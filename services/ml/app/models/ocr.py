"""RapidOCR, chosen over PaddleOCR and Tesseract because it is pure ONNX: no
system packages, no model server, about 15 MB of weights, and it runs on a
laptop core without a GPU."""

from __future__ import annotations

import logging
import os
import threading
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

from ..registry import LazyModel, registry

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from rapidocr_onnxruntime import RapidOCR

    from ..extractors.layout import Line


# RapidOCR ships the Chinese PP-OCRv4 recogniser by default. It reads English
# glyphs correctly but drops the spaces between words — Chinese does not use
# them, so its character dictionary barely emits one. On a résumé that turned
# "Experienced and results-driven Education Director" into a single
# seventy-character token: unreadable on a source card, and invisible to BM25,
# which can only match words it can see the boundaries of. The English
# recogniser is a separate 9 MB file, fetched on first use like every other
# weight here and cached in the models volume.
_EN_REC_URL = (
    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/en_PP-OCRv3_rec_infer.onnx"
)
_EN_REC_PATH = Path(os.environ.get("OCR_MODEL_DIR", "/models/ocr")) / "en_PP-OCRv3_rec_infer.onnx"


def _english_recogniser() -> str | None:
    """The English recogniser's path, downloading it once if absent.

    Returns None when it cannot be fetched, so OCR falls back to the bundled
    recogniser rather than failing: worse spacing is a better outcome than no
    text at all.
    """
    if _EN_REC_PATH.exists() and _EN_REC_PATH.stat().st_size > 0:
        return str(_EN_REC_PATH)

    try:
        _EN_REC_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Downloaded beside the target and moved into place, so an interrupted
        # fetch cannot leave a truncated file that every later run trusts.
        partial = _EN_REC_PATH.with_suffix(".partial")
        urllib.request.urlretrieve(_EN_REC_URL, partial)
        partial.replace(_EN_REC_PATH)
        return str(_EN_REC_PATH)
    except Exception as exc:  # noqa: BLE001 - any failure falls back
        logger.warning("english OCR recogniser unavailable, using the bundled one: %s", exc)
        return None


def _load() -> "RapidOCR":
    from rapidocr_onnxruntime import RapidOCR

    rec = _english_recogniser()
    return RapidOCR(rec_model_path=rec) if rec else RapidOCR()


ocr_model: LazyModel["RapidOCR"] = LazyModel("ocr", _load)
registry.register(ocr_model)  # type: ignore[arg-type]

_ocr_lock = threading.Lock()


def read_lines(image_path: str) -> list["Line"]:
    """Every recognised line with its box, in pixels of the image as stored.

    The boxes are the part of OCR that says which label a number belongs to;
    layout.py turns them into regions, charts and tables."""
    from ..extractors.layout import Line

    engine = ocr_model.get()

    with _ocr_lock:
        result, _elapsed = engine(image_path)

    if not result:
        return []

    # RapidOCR yields [box, text, confidence] per detected line; the box is
    # four corner points, not always axis-aligned, so its extent is taken.
    lines: list[Line] = []
    for entry in result:
        if len(entry) < 2 or not entry[1] or not str(entry[1]).strip():
            continue
        xs = [float(point[0]) for point in entry[0]]
        ys = [float(point[1]) for point in entry[0]]
        lines.append(Line(str(entry[1]).strip(), min(xs), min(ys), max(xs), max(ys)))
    return lines


def read_text(image_path: str) -> str:
    """Returns recognised text in reading order, or an empty string when the
    page carries no legible text. Reading order comes from the layout, so a
    two-column page reads column by column and a chart reads as its data
    rather than as the order its labels happen to sit top to bottom."""
    from ..extractors import layout

    lines = read_lines(image_path)
    if not lines:
        return ""
    return layout.reading_order_text(layout.analyse(lines))
