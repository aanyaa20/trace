"""A standalone image becomes an overview block plus one block per region.

The overview carries the CLIP vector and says what the image is. The regions
carry the content: paragraphs as OCR read them, and charts and tables as
records, so a question about one value retrieves the one region that holds it,
with the label and the value still side by side.

Two readings are combined. OCR geometry (layout.py) is exact about text and
always available. A vision model reads what geometry cannot — unlabelled bars,
photos, diagrams — and its numbers are only kept when OCR read the same numbers
in the same image.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from ..config import LITE, settings
from ..models import vision
from ..models.ocr import read_lines
from ..models.vision import transcribe_text
from ..schemas import ExtractBlock, ExtractResponse, VisualRegion
from . import layout
from .layout import Line

logger = logging.getLogger("trace.ml.image")

# Text regions are merged up to about a chunk's worth, so a paragraph split
# by the layout into two blocks is still searched as one.
_TEXT_REGION_CHARS = 900
_DATA_TYPES = ("chart", "table")
_VISUAL_TYPES = ("diagram", "photo", "form", "handwriting", "screenshot")


def _size(path: str) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as image:
        return image.size


def _normal(text: str) -> str:
    return re.sub(r"[^a-z0-9.]", "", text.lower())


def _number_key(text: str) -> str | None:
    cleaned = re.sub(r"[\s,$€£₹%]", "", str(text))
    return cleaned if re.fullmatch(r"-?\d+(?:\.\d+)?[kKmMbB]?n?", cleaned) else None


def _ocr_numbers(lines: list[Line]) -> set[str]:
    found: set[str] = set()
    for line in lines:
        for token in re.split(r"[\s()/:;]+", line.text):
            key = _number_key(token)
            if key:
                found.add(key)
    return found


def _agreement(region: VisualRegion, ocr_numbers: set[str]) -> float | None:
    """Share of the region's numbers that OCR also read. A vision model that
    misreads 28.9 as 29.8 produces a number OCR never saw, and this is where
    that shows."""
    keys = [
        key
        for record in region.data
        for value in record.values()
        if (key := _number_key(str(value) if not isinstance(value, float) else f"{value:g}"))
    ]
    if not keys:
        return None
    return round(sum(1 for key in keys if key in ocr_numbers) / len(keys), 3)


def _cells(region: VisualRegion) -> set[str]:
    values = [region.title or "", *region.columns]
    for record in region.data:
        values.extend(f"{value:g}" if isinstance(value, float) else str(value) for value in record.values())
    return {_normal(value) for value in values if _normal(value)}


def _snap(
    region: VisualRegion, lines: list[Line], width: int, height: int
) -> tuple[float, float, float, float] | None:
    """The region's box from the OCR lines that print its own labels and
    values, which is exact, falling back to the model's estimate. Lines far
    outside the model's box are ignored, so a year that also appears in a
    paragraph elsewhere cannot stretch the box across the page."""
    cells = _cells(region)
    guess = region.bbox
    hits: list[Line] = []
    for line in lines:
        if _normal(line.text) not in cells:
            continue
        if guess:
            gx0, gy0, gx1, gy1 = guess
            cx, cy = line.cx / width, line.cy / height
            if not (gx0 - 0.15 <= cx <= gx1 + 0.15 and gy0 - 0.15 <= cy <= gy1 + 0.15):
                continue
        hits.append(line)
    if len(hits) >= 2:
        return (
            round(min(line.x0 for line in hits) / width, 4),
            round(min(line.y0 for line in hits) / height, 4),
            round(max(line.x1 for line in hits) / width, 4),
            round(max(line.y1 for line in hits) / height, 4),
        )
    return guess


def _iou(a: tuple[float, float, float, float] | None, b: tuple[float, float, float, float] | None) -> float:
    if not a or not b:
        return 0.0
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _box(raw: object, order: str) -> tuple[float, float, float, float] | None:
    """A model's 0-1000 box as normalised x0, y0, x1, y1, sanity-checked."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        a, b, c, d = (min(1.0, max(0.0, float(value) / 1000)) for value in raw)
    except (TypeError, ValueError):
        return None
    x0, y0, x1, y1 = (b, a, d, c) if order.startswith("[ymin") else (a, b, c, d)
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def _without_unit(title: str | None, unit: str | None) -> str | None:
    """"Market Size (USD Billion)" with unit "USD Billion" is "Market Size":
    the unit is printed once, after the title, by render()."""
    if not title or not unit:
        return title
    stripped = re.sub(rf"\s*\(\s*{re.escape(unit)}\s*\)\s*$", "", title, flags=re.IGNORECASE)
    return stripped or title


def _text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text and text.lower() != "null" else None


def _vision_regions(path: str) -> tuple[str | None, list[VisualRegion], str | None]:
    """The vision model's summary and regions, or nothing when no model could
    be reached or its reply was not the JSON asked for."""
    reply = vision.ask(vision.STRUCTURE_PROMPT, path, json_mode=True, max_tokens=950, max_wait_sec=45)
    if not reply:
        return None, [], None
    parsed = vision.parse_json(reply.text)
    if not parsed:
        logger.warning("vision reply for %s was not JSON", Path(path).name)
        return None, [], reply.model

    regions: list[VisualRegion] = []
    order = vision.box_order(reply.model)
    raw_regions = parsed.get("regions")
    for index, raw in enumerate(raw_regions if isinstance(raw_regions, list) else []):
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("type", "")).strip().lower()
        if kind not in (*_DATA_TYPES, *_VISUAL_TYPES):
            continue
        columns = [str(column).strip() for column in raw.get("columns") or [] if str(column).strip()]
        rows = [row for row in raw.get("rows") or [] if isinstance(row, list) and row]
        width = max([len(columns), *(len(row) for row in rows)], default=0)
        names = columns + [f"column {i + 1}" for i in range(len(columns), width)]
        data = [
            {
                names[i]: layout.numeric_value(str(cell)) if layout.is_number(str(cell)) else str(cell).strip()
                for i, cell in enumerate(row)
            }
            for row in rows
        ]
        unit = _text(raw.get("unit"))
        regions.append(
            VisualRegion(
                id=f"v{index + 1}",
                type=kind,  # type: ignore[arg-type]
                title=_without_unit(_text(raw.get("title")), unit),
                unit=unit,
                description=_text(raw.get("description")),
                columns=names,
                data=data,
                bbox=_box(raw.get("box_2d", raw.get("bbox")), order),
                origin="vision",
                estimated=bool(raw.get("estimated")),
            )
        )
    return _text(parsed.get("summary")), regions, reply.model


def _combine(
    found: list[VisualRegion],
    seen: list[VisualRegion],
    lines: list[Line],
    width: int,
    height: int,
) -> list[VisualRegion]:
    """Layout regions, with the vision model's reading taking over a chart or
    table when its numbers check out against OCR, and adding the photos and
    diagrams geometry cannot see. Order stays the layout's reading order."""
    regions = list(found)
    numbers = _ocr_numbers(lines)
    has_text = sum(len(line.text) for line in lines) > 40

    for region in seen:
        region.bbox = _snap(region, lines, width, height)
        if region.type in _DATA_TYPES:
            region.ocrAgreement = _agreement(region, numbers)
            match = _same_region(region, regions)
            doubtful = has_text and region.ocrAgreement is not None and region.ocrAgreement < 0.8
            if match is not None:
                # Geometry read this region too. Its values are OCR's own, so
                # a vision reading that disagrees with them loses; one that
                # agrees wins, because it also has the headers and the wraps.
                if doubtful:
                    match.description = match.description or region.description
                    continue
                region.id = match.id
                region.bbox = match.bbox
                regions[regions.index(match)] = region
                continue
            if doubtful and region.ocrAgreement is not None and region.ocrAgreement < 0.5:
                # Numbers nobody else can confirm are not kept as data. What
                # the model said the region is about is still worth indexing.
                logger.info("dropping unconfirmed values for %s (agreement %s)", region.title, region.ocrAgreement)
                region.data = []
                region.columns = []
        elif region.type not in _VISUAL_TYPES:
            continue
        _insert_in_order(regions, region)
    return regions


def _keys(region: VisualRegion) -> set[str]:
    return {
        key
        for record in region.data
        for value in record.values()
        if (key := _number_key(f"{value:g}" if isinstance(value, float) else str(value)))
    }


def _same_region(region: VisualRegion, regions: list[VisualRegion]) -> VisualRegion | None:
    """The layout region the vision model is describing. Matched on content
    first — the same numbers, or the same cells — because a model's box can be
    off by half the image while its values are exact; box overlap decides
    only when there is no content to compare."""
    candidates = [item for item in regions if item.type == region.type and item.origin == "layout"]
    best: tuple[float, VisualRegion] | None = None
    for item in candidates:
        mine, theirs = _keys(region), _keys(item)
        if mine and theirs:
            score = len(mine & theirs) / len(mine | theirs)
        else:
            cells, other = _cells(region), _cells(item)
            score = len(cells & other) / len(cells | other) if cells and other else _iou(item.bbox, region.bbox)
        if score >= 0.5 and (best is None or score > best[0]):
            best = (score, item)
    return best[1] if best else None


def _insert_in_order(regions: list[VisualRegion], region: VisualRegion) -> None:
    top = region.bbox[1] if region.bbox else 1.0
    for index, existing in enumerate(regions):
        if existing.bbox and existing.bbox[1] > top:
            regions.insert(index, region)
            return
    regions.append(region)


def _union(boxes: list[tuple[float, float, float, float] | None]) -> tuple[float, float, float, float] | None:
    present = [box for box in boxes if box]
    if not present:
        return None
    return (
        min(box[0] for box in present),
        min(box[1] for box in present),
        max(box[2] for box in present),
        max(box[3] for box in present),
    )


def _heading_of(region: VisualRegion) -> str | None:
    """The region's heading, when its first line reads as one: a few words, a
    letter in them, no closing punctuation. A heading printed tight against
    its text lands in the same region as that text, so the first line of a
    longer region counts too."""
    first = (region.text or "").strip().split("\n", 1)[0].strip()
    words = first.split()
    if not words or len(words) > 6 or not re.search(r"[A-Za-z]", first):
        return None
    if first.endswith((".", ",", ";", ":")) or not first[0].isupper():
        return None
    return first


def _region_blocks(regions: list[VisualRegion], image_path: str) -> list[ExtractBlock]:
    """Text regions merged to about a chunk each, in reading order; every
    chart, table, photo and diagram its own block. Each block carries its
    region, so its citation can name what it is and where it sits."""
    blocks: list[ExtractBlock] = []
    pending: list[VisualRegion] = []
    section: str | None = None
    # The heading a pending text chunk opens with, so the chunk is named after
    # what it starts with rather than whatever heading came last.
    opening: str | None = None

    def flush() -> None:
        nonlocal pending, opening
        if not pending:
            return
        text = "\n".join((item.text or "").strip() for item in pending).strip()
        merged = VisualRegion(
            id="+".join(item.id for item in pending),
            type="text",
            text=text,
            bbox=_union([item.bbox for item in pending]),
            origin="layout",
        )
        blocks.append(
            ExtractBlock(
                ordinal=0,
                kind="region",
                source="ocr",
                text=text,
                imagePath=image_path,
                bbox=merged.bbox,
                section=opening or section,
                visual=merged,
            )
        )
        pending = []
        opening = None

    for region in regions:
        if region.type == "text":
            size = sum(len(item.text or "") for item in pending)
            if pending and size + len(region.text or "") > _TEXT_REGION_CHARS:
                flush()
            heading = _heading_of(region)
            if heading:
                section = heading
                if not pending:
                    opening = heading
            pending.append(region)
            continue

        flush()
        text = layout.render(region)
        if not text.strip():
            continue
        blocks.append(
            ExtractBlock(
                ordinal=0,
                kind="region",
                source="vision" if region.origin == "vision" else "ocr",
                text=text,
                imagePath=image_path,
                bbox=region.bbox,
                section=region.title or section,
                visual=region,
            )
        )
    flush()
    return blocks


def _overview(summary: str | None, regions: list[VisualRegion], first_text: str | None) -> str:
    """What the image is, in a few lines: short enough to grade whole, and the
    chunk a question about the image as a whole is answered from."""
    parts = [summary] if summary else ([first_text] if first_text else [])
    named = [
        f'{region.type} "{region.title}"' if region.title else f"{region.type}"
        for region in regions
        if region.type != "text"
    ]
    if named:
        parts.append("Contains: " + "; ".join(named) + ".")
    for region in regions:
        if region.type in _VISUAL_TYPES and region.description:
            parts.append(f"{region.type.capitalize()}: {region.description}")
    return "\n".join(parts).strip()


def extract_image(path: str) -> ExtractResponse:
    """OCR with geometry, a vision reading when one is reachable, and the two
    reconciled into regions. The CLIP vector is produced later by /embed/image
    on the overview block."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"image not found: {path}")

    warnings: list[str] = []
    width, height = _size(str(file_path))
    try:
        lines = read_lines(str(file_path))
    except Exception as exc:
        warnings.append(f"ocr failed: {exc}")
        lines = []

    found = [
        layout.to_visual(region, width, height, index)
        for index, region in enumerate(layout.analyse(lines))
    ]

    summary: str | None = None
    seen: list[VisualRegion] = []
    if settings.vision_structure and vision.available():
        summary, seen, model = _vision_regions(str(file_path))
        if model is None:
            warnings.append("no vision model was reachable; charts and tables were read from OCR geometry only")
        elif seen:
            logger.info("vision %s read %d regions in %s", model, len(seen), file_path.name)

    regions = _combine(found, seen, lines, width, height)
    if LITE and not lines:
        # No local OCR in lite mode: the page's text comes from a vision
        # model's transcription, as one text region ahead of the others.
        text = transcribe_text(str(file_path))
        if text:
            regions.insert(0, VisualRegion(id="t1", type="text", text=text, origin="vision"))
    region_blocks = _region_blocks(regions, str(file_path))
    first_text = next((region.text for region in regions if region.type == "text" and region.text), None)
    overview = _overview(summary, regions, first_text)

    blocks = [
        ExtractBlock(
            ordinal=0,
            kind="image",
            source="vision" if summary else ("ocr" if lines else "caption"),
            text=overview,
            imagePath=str(file_path),
        ),
        *region_blocks,
    ]
    for index, block in enumerate(blocks):
        block.ordinal = index

    charts = sum(1 for region in regions if region.type == "chart")
    tables = sum(1 for region in regions if region.type == "table")
    if charts or tables:
        warnings.append(f"read {charts} chart(s) and {tables} table(s) as structured data")

    return ExtractResponse(
        modality="image",
        pageCount=None,
        durationSec=None,
        blocks=blocks,
        warnings=warnings,
    )
