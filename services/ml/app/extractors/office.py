"""DOCX, PPTX and XLSX, parsed locally.

These used to go to the Gemini File API as a last resort, which sent the file
off the machine, needed a key, and came back as one flat block — no slide
numbers, no headings, tables run together into prose. Parsed here instead:

- DOCX: headings become markdown heading lines, so the chunker starts a new
  chunk at each and tags every chunk with its section; tables stay tables.
- PPTX: one block per slide, page = slide number, section = slide title.
- XLSX: each sheet through the same table path as CSV, with computed stats.

The Gemini path remains only for formats none of these handle (.doc, .ppt)."""

from __future__ import annotations

from ..schemas import ExtractBlock, ExtractResponse
from .tables import table_blocks

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
LOCAL_OFFICE = {DOCX, PPTX, XLSX}


def _heading_level(style_name: str) -> int | None:
    name = (style_name or "").strip().lower()
    if name == "title":
        return 1
    if name.startswith("heading"):
        digits = "".join(ch for ch in name if ch.isdigit())
        return min(int(digits), 6) if digits else 1
    return None


def _table_rows(table) -> list[list[object]]:
    return [[cell.text for cell in row.cells] for row in table.rows]


def extract_docx(path: str) -> ExtractResponse:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(path)
    # One block per heading section, each tagged with its heading. A short
    # document would otherwise reach the chunker as one block under whatever
    # heading came first, and every chunk of it would claim that section.
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    tables: list[ExtractBlock] = []
    section: str | None = None
    table_index = 0

    # Body order matters: a table belongs under the heading before it.
    for element in document.element.body.iterchildren():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(element, document)
            text = paragraph.text.strip()
            if not text:
                continue
            level = _heading_level(paragraph.style.name if paragraph.style is not None else "")
            if level:
                section = text[:200]
                sections.append((section, [f"{'#' * level} {text}"]))
            else:
                sections[-1][1].append(text)
        elif tag == "tbl":
            table_index += 1
            title = f"Table {table_index}" + (f" ({section})" if section else "")
            tables.extend(table_blocks(title, _table_rows(Table(element, document)), 0))

    blocks: list[ExtractBlock] = []
    for heading, parts in sections:
        text = "\n\n".join(parts).strip()
        # A heading with nothing under it (a title, say) is kept only if it is
        # the whole document; otherwise it would be a chunk of one line.
        if not text or (len(parts) == 1 and parts[0].startswith("#") and len(sections) > 1):
            continue
        blocks.append(ExtractBlock(ordinal=len(blocks), kind="text", source="text", text=text, section=heading))
    for block in tables:
        blocks.append(block.model_copy(update={"ordinal": len(blocks)}))
    return ExtractResponse(
        modality="text", pageCount=None, durationSec=None, blocks=blocks,
        warnings=[] if blocks else ["the document has no text"],
    )


def extract_pptx(path: str) -> ExtractResponse:
    from pptx import Presentation

    presentation = Presentation(path)
    blocks: list[ExtractBlock] = []
    for number, slide in enumerate(presentation.slides, start=1):
        title_shape = slide.shapes.title
        title = title_shape.text.strip() if title_shape is not None and title_shape.has_text_frame else ""
        # python-pptx builds a new proxy object on every access, so identity
        # never matches; the shape id is what identifies the title placeholder.
        title_id = title_shape.shape_id if title_shape is not None else None
        lines: list[str] = [f"# Slide {number}" + (f": {title}" if title else "")]
        for shape in slide.shapes:
            if title_id is not None and shape.shape_id == title_id:
                continue
            if shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    text = "".join(run.text for run in paragraph.runs).strip()
                    if text:
                        lines.append(("  " * paragraph.level) + f"- {text}")
            if getattr(shape, "has_table", False) and shape.has_table:
                for block in table_blocks(f"Slide {number} table", _table_rows(shape.table), 0, page=number):
                    lines.append(block.text)
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                lines.append(f"Speaker notes: {notes}")
        blocks.append(
            ExtractBlock(
                ordinal=number - 1, kind="text", source="text", text="\n".join(lines),
                page=number, section=title or f"Slide {number}",
            )
        )
    return ExtractResponse(
        modality="text", pageCount=len(blocks), durationSec=None, blocks=blocks,
        warnings=[] if blocks else ["the presentation has no slides"],
    )


def extract_xlsx(path: str) -> ExtractResponse:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True, data_only=True)
    blocks: list[ExtractBlock] = []
    try:
        for sheet in workbook.worksheets:
            rows = [list(row) for row in sheet.iter_rows(values_only=True)]
            for block in table_blocks(f"Sheet {sheet.title}", rows, len(blocks)):
                blocks.append(block.model_copy(update={"ordinal": len(blocks)}))
    finally:
        workbook.close()
    return ExtractResponse(
        modality="text", pageCount=None, durationSec=None, blocks=blocks,
        warnings=[] if blocks else ["the workbook has no non-empty cells"],
    )


def extract_office(path: str, mime: str) -> ExtractResponse:
    if mime == DOCX:
        return extract_docx(path)
    if mime == PPTX:
        return extract_pptx(path)
    return extract_xlsx(path)
