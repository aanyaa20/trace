from __future__ import annotations

from pathlib import Path

from ..models.ocr import read_text
from ..schemas import ExtractBlock, ExtractResponse


def extract_image(path: str) -> ExtractResponse:
    """A standalone image becomes one image block. Its CLIP vector and caption
    are produced later by /embed/image; OCR runs here because text baked into
    a slide or scan is the part most worth searching."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"image not found: {path}")

    warnings: list[str] = []
    try:
        recognised = read_text(str(file_path))
    except Exception as exc:
        warnings.append(f"ocr failed: {exc}")
        recognised = ""

    return ExtractResponse(
        modality="image",
        pageCount=None,
        durationSec=None,
        blocks=[
            ExtractBlock(
                ordinal=0,
                kind="image",
                source="ocr" if recognised else "caption",
                text=recognised,
                imagePath=str(file_path),
            )
        ],
        warnings=warnings,
    )
