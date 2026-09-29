from __future__ import annotations

import logging
import re
from pathlib import Path

from ..config import LITE, settings
from ..models.ocr import read_lines, read_text
from . import layout
from ..schemas import ExtractBlock, ExtractResponse

logger = logging.getLogger("trace.ml.pdf")


_NUMBERED = re.compile(r"^(\d+(\.\d+)*\.?|[A-Z]\.|[IVX]+\.)\s+\S")


def _lines(page) -> list[tuple[str, float, bool]]:
    """(text, font size, bold) per visual line, from PyMuPDF's span data."""
    out: list[tuple[str, float, bool]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if span.get("text", "").strip()]
            if not spans:
                continue
            text = " ".join(span["text"].strip() for span in spans)
            size = max(float(span.get("size", 0)) for span in spans)
            bold = all(int(span.get("flags", 0)) & 16 for span in spans)
            out.append((text, size, bold))
    return out


def _body_size(document) -> float:
    """The font size most characters are set in, over the first pages."""
    weights: dict[float, int] = {}
    for index, page in enumerate(document):
        if index >= 20:
            break
        for text, size, _ in _lines(page):
            weights[round(size, 1)] = weights.get(round(size, 1), 0) + len(text)
    return max(weights, key=weights.get) if weights else 0.0


def _page_heading(page, body: float) -> str | None:
    """The first line on the page that looks like a heading: short, and either
    set clearly larger than body text or bold and numbered ("2.1 Models").
    A heuristic — PDFs carry no structure tags as a rule — so it only ever
    labels a page, never changes its text or offsets."""
    if body <= 0:
        return None
    for text, size, bold in _lines(page):
        clean = text.strip()
        if not (3 <= len(clean) <= 120) or clean.endswith((".", ",", ";")) and not _NUMBERED.match(clean):
            continue
        if sum(ch.isalpha() for ch in clean) < 3:
            continue
        if size >= body * 1.15 or (bold and size >= body * 0.95 and _NUMBERED.match(clean)):
            return clean
    return None


def extract_pdf(path: str, document_id: str) -> ExtractResponse:
    """One block per page. A page yielding almost no extractable text is
    treated as scanned, rendered at PDF_OCR_DPI and read with OCR."""
    import fitz
    from PIL import Image

    blocks: list[ExtractBlock] = []
    warnings: list[str] = []
    render_dir = Path(settings.upload_dir) / "derived" / document_id
    ocr_pages = 0

    with fitz.open(path) as document:
        page_count = document.page_count
        body = _body_size(document)
        section: str | None = None

        for index, page in enumerate(document):
            text = page.get_text("text").strip()
            heading = _page_heading(page, body)
            if heading:
                section = heading

            if len(text) >= settings.pdf_ocr_char_threshold:
                blocks.append(
                    ExtractBlock(
                        ordinal=index,
                        kind="text",
                        source="text",
                        text=text,
                        page=index + 1,
                        section=section,
                    )
                )
                continue

            render_dir.mkdir(parents=True, exist_ok=True)
            image_path = render_dir / f"page-{index + 1:04d}.png"
            # The DPI matters: below about 150 the detector starts dropping
            # small type, and above 300 the render dominates ingestion time.
            zoom = settings.pdf_ocr_dpi / 72.0
            page.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).save(str(image_path))

            try:
                if LITE:
                    # A scanned page read by a vision model; no boxes, so no
                    # separate chart or table regions for it.
                    lite_text = read_text(str(image_path))
                    regions = []
                else:
                    lite_text = None
                    regions = layout.analyse(read_lines(str(image_path)))
            except Exception as exc:
                warnings.append(f"ocr failed on page {index + 1}: {exc}")
                logger.warning("ocr failed for %s page %s: %s", document_id, index + 1, exc)
                regions = []
                lite_text = None

            ocr_pages += 1
            blocks.append(
                ExtractBlock(
                    ordinal=index,
                    kind="text",
                    source="ocr",
                    text=lite_text if lite_text is not None else layout.reading_order_text(regions),
                    page=index + 1,
                    imagePath=str(image_path),
                )
            )
            # A chart or table on a scanned page is also indexed on its own,
            # as records, so a question about one value finds the region that
            # holds it and the citation can point at where it sits.
            with Image.open(image_path) as rendered:
                width, height = rendered.size
            for number, region in enumerate(regions):
                if region.kind not in ("chart", "table"):
                    continue
                visual = layout.to_visual(region, width, height, number)
                blocks.append(
                    ExtractBlock(
                        ordinal=index,
                        kind="region",
                        source="ocr",
                        text=layout.render(visual),
                        page=index + 1,
                        imagePath=str(image_path),
                        bbox=visual.bbox,
                        section=visual.title or section,
                        visual=visual,
                    )
                )

    if ocr_pages:
        warnings.append(f"{ocr_pages} of {page_count} pages required ocr")

    empty = sum(1 for block in blocks if not block.text.strip())
    if empty == len(blocks) and blocks:
        warnings.append("no text recovered from any page; the file may be image-only or corrupt")

    return ExtractResponse(
        modality="pdf",
        pageCount=page_count,
        durationSec=None,
        blocks=blocks,
        warnings=warnings,
    )
