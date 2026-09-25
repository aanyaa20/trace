from __future__ import annotations

import logging
from pathlib import Path

from ..config import settings
from ..models.ocr import read_text
from ..schemas import ExtractBlock, ExtractResponse

logger = logging.getLogger("trace.ml.pdf")


def extract_pdf(path: str, document_id: str) -> ExtractResponse:
    """One block per page. A page yielding almost no extractable text is
    treated as scanned, rendered at PDF_OCR_DPI and read with OCR."""
    import fitz

    blocks: list[ExtractBlock] = []
    warnings: list[str] = []
    render_dir = Path(settings.upload_dir) / "derived" / document_id
    ocr_pages = 0

    with fitz.open(path) as document:
        page_count = document.page_count

        for index, page in enumerate(document):
            text = page.get_text("text").strip()

            if len(text) >= settings.pdf_ocr_char_threshold:
                blocks.append(
                    ExtractBlock(
                        ordinal=index,
                        kind="text",
                        source="text",
                        text=text,
                        page=index + 1,
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
                recognised = read_text(str(image_path))
            except Exception as exc:
                warnings.append(f"ocr failed on page {index + 1}: {exc}")
                logger.warning("ocr failed for %s page %s: %s", document_id, index + 1, exc)
                recognised = ""

            ocr_pages += 1
            blocks.append(
                ExtractBlock(
                    ordinal=index,
                    kind="text",
                    source="ocr",
                    text=recognised,
                    page=index + 1,
                    imagePath=str(image_path),
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
