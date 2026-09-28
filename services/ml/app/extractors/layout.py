"""Page layout from OCR geometry: regions, reading order, charts and tables.

OCR returns every line with its box, and the boxes are what say which number
belongs to which label. Joining the lines top to bottom throws that away: on a
bar chart the value labels sit at different heights, so "2024" and "28.9" end
up a dozen lines apart and nothing downstream can put them back together.

Everything here is geometry on those boxes. No model, no network, so it runs
when every vision API is down and gives the same answer every time. It is the
floor; a vision model reading the same image (models/vision.py) is layered on
top when one is reachable, and its numbers are checked against these.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

from ..schemas import VisualRegion


@dataclass(frozen=True)
class Line:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def h(self) -> float:
        return max(1.0, self.y1 - self.y0)

    @property
    def w(self) -> float:
        return max(1.0, self.x1 - self.x0)


@dataclass
class Region:
    """A block of lines the layout keeps together, before it is typed."""

    lines: list[Line]
    kind: str = "text"
    title: str | None = None
    unit: str | None = None
    columns: list[str] = field(default_factory=list)
    data: list[dict[str, str | float]] = field(default_factory=list)

    @property
    def box(self) -> tuple[float, float, float, float]:
        return (
            min(line.x0 for line in self.lines),
            min(line.y0 for line in self.lines),
            max(line.x1 for line in self.lines),
            max(line.y1 for line in self.lines),
        )

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)


# A printed value: 12.1, 1,204, $21M, 48%, -3.5, 7.2bn. Years match too, which
# is why the category row is found by position rather than by content.
_NUMBER = re.compile(
    r"^[\$€£₹]?\s?-?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbB]n?|bn|B|M|K)?$"
)
_UNIT = re.compile(r"\(([^)]{1,40})\)\s*$")


def is_number(text: str) -> bool:
    return bool(_NUMBER.match(text.strip()))


def numeric_value(text: str) -> float | str:
    """The number a label prints, as a float when it is a plain one, else the
    label verbatim. "$21M" stays "$21M": converting it would invent a scale."""
    cleaned = text.strip().replace(",", "")
    try:
        return float(cleaned)
    except ValueError:
        return text.strip()


def _median_height(lines: list[Line]) -> float:
    return statistics.median(line.h for line in lines) if lines else 20.0


def _largest_gap(intervals: list[tuple[float, float]]) -> tuple[float, float] | None:
    """The widest empty stretch between merged intervals, as (start, end)."""
    ordered = sorted(intervals)
    best: tuple[float, float] | None = None
    reach = ordered[0][1]
    for start, end in ordered[1:]:
        if start > reach and (best is None or start - reach > best[1] - best[0]):
            best = (reach, start)
        reach = max(reach, end)
    return best


def xy_cut(lines: list[Line], gap_y: float, gap_x: float) -> list[list[Line]]:
    """Recursive XY-cut: split on the widest horizontal band of whitespace,
    else the widest vertical gutter, until neither is wide enough. The order
    the pieces come back in is the reading order: top to bottom, then left to
    right within a band."""
    if len(lines) <= 1:
        return [lines] if lines else []

    horizontal = _largest_gap([(line.y0, line.y1) for line in lines])
    if horizontal and horizontal[1] - horizontal[0] >= gap_y:
        cut = (horizontal[0] + horizontal[1]) / 2
        top = [line for line in lines if line.cy < cut]
        bottom = [line for line in lines if line.cy >= cut]
        return xy_cut(top, gap_y, gap_x) + xy_cut(bottom, gap_y, gap_x)

    # One row of short cells is a table row, or a row of chart labels: its
    # gutters are between columns, and cutting them would scatter the row.
    if len(lines) >= 2 and len(rows_of(lines)) == 1 and all(map(_is_cell, lines)):
        return [sorted(lines, key=lambda line: line.x0)]

    vertical = _largest_gap([(line.x0, line.x1) for line in lines])
    if vertical and vertical[1] - vertical[0] >= gap_x:
        cut = (vertical[0] + vertical[1]) / 2
        left = [line for line in lines if line.cx < cut]
        right = [line for line in lines if line.cx >= cut]
        if not _is_grid(left, right):
            return xy_cut(left, gap_y, gap_x) + xy_cut(right, gap_y, gap_x)

    return [sorted(lines, key=lambda line: (line.y0, line.x0))]


def _is_cell(line: Line) -> bool:
    return is_number(line.text) or (len(line.text.split()) <= 4 and not line.text.rstrip().endswith("."))


def _is_grid(left: list[Line], right: list[Line]) -> bool:
    """Whether a gutter is the space between table columns rather than between
    two columns of prose. Cutting there would put every name in one region and
    every score in another, which is exactly the pairing this module exists to
    keep. A grid's two sides share rows line for line, and its cells are short
    or numeric; two columns of prose share neither."""
    if len(left) < 2 or len(right) < 2:
        return False
    h = _median_height([*left, *right])
    smaller, larger = sorted((left, right), key=len)
    paired = sum(1 for line in smaller if any(abs(line.cy - other.cy) <= 0.35 * h for other in larger))
    if paired < 0.8 * len(smaller):
        return False

    def numeric(side: list[Line]) -> bool:
        return sum(1 for line in side if is_number(line.text)) >= 0.5 * len(side)

    return numeric(left) or numeric(right) or (all(map(_is_cell, left)) and all(map(_is_cell, right)))


def rows_of(lines: list[Line]) -> list[list[Line]]:
    """Lines grouped into visual rows: two lines share a row when their
    vertical extents overlap by at least half the shorter one."""
    rows: list[list[Line]] = []
    for line in sorted(lines, key=lambda item: item.cy):
        for row in rows:
            anchor = row[0]
            overlap = min(anchor.y1, line.y1) - max(anchor.y0, line.y0)
            if overlap >= 0.5 * min(anchor.h, line.h):
                row.append(line)
                break
        else:
            rows.append([line])
    return [sorted(row, key=lambda item: item.x0) for row in rows]


def _title_above(lines: list[Line], top: float, left: float, right: float) -> Line | None:
    """The nearest wordy line above a plot or table that overlaps it
    horizontally: where a chart's or table's own caption sits."""
    above = [
        line
        for line in lines
        if line.y1 <= top + 2
        and not is_number(line.text)
        and min(line.x1, right) - max(line.x0, left) > 0
    ]
    return max(above, key=lambda line: line.y1) if above else None


def detect_chart(region: Region) -> Region | None:
    """A column chart with printed data labels: a row of three or more short
    category labels, each with a number standing directly above it. Axis ticks
    sit in a column to the left of the first category and align with no
    category, so they fall out without being special-cased."""
    lines = region.lines
    h = _median_height(lines)

    for full_row in sorted(rows_of(lines), key=lambda items: -items[0].cy):
        # A row of axis labels can share its height with unrelated text in a
        # neighbouring column; only the short labels are category candidates.
        row = [line for line in full_row if len(line.text) <= 24]
        if len(row) < 3:
            continue

        used: set[int] = set()
        pairs: list[tuple[Line, Line]] = []
        for category in row:
            reach = max(category.w, h) * 0.8
            candidates = [
                (index, line)
                for index, line in enumerate(lines)
                if index not in used
                and line not in row
                and is_number(line.text)
                and line.y1 <= category.y0 + 0.25 * h
                and category.y0 - line.y1 <= 15 * h
                and abs(line.cx - category.cx) <= reach
            ]
            if not candidates:
                continue
            # The label nearest the category is the one on its bar; anything
            # further up in the same column belongs to a gridline or a legend.
            index, value = max(candidates, key=lambda item: item[1].y1)
            used.add(index)
            pairs.append((category, value))

        if len(pairs) < 3 or len(pairs) < 0.6 * len(row):
            continue
        # Two shapes that also put numbers above a row of labels, and are not
        # charts: a table whose bottom row is numbers too (a totals row), and
        # one whose numbers all sit on a single line above the labels.
        if any(
            is_number(category.text) and not re.fullmatch(r"(19|20)\d\d", category.text.strip())
            for category, _ in pairs
        ):
            continue
        values = [value for _, value in pairs]
        if len(rows_of(values)) == 1:
            continue
        categories = [category for category, _ in pairs]

        plot_top = min(line.y0 for line in values)
        left = min(line.x0 for line in categories)
        right = max(line.x1 for line in categories)
        title_line = _title_above(lines, plot_top, left - 4 * h, right)
        # Ticks: numbers left of the first category, within the plot's height.
        ticks = [
            line
            for line in lines
            if is_number(line.text)
            and left - 6 * h <= line.x1 <= left
            and plot_top - h <= line.cy <= categories[0].y1
        ]
        members = [*categories, *values, *ticks, *([title_line] if title_line else [])]

        title = title_line.text if title_line else None
        unit_match = _UNIT.search(title) if title else None
        unit = unit_match.group(1).strip() if unit_match else None
        if title and unit_match:
            title = title[: unit_match.start()].strip() or title

        x_label = (
            "year"
            if all(re.fullmatch(r"(19|20)\d\d", category.text.strip()) for category, _ in pairs)
            else "category"
        )
        series = "value"
        return Region(
            lines=members,
            kind="chart",
            title=title,
            unit=unit,
            columns=[x_label, series],
            data=[
                {x_label: numeric_value(category.text), series: numeric_value(value.text)}
                for category, value in pairs
            ],
        )
    return None


def _column_starts(rows: list[list[Line]], tolerance: float) -> list[float]:
    """Left edges shared by cells in several rows: a table's column starts."""
    starts: list[list[float]] = []
    for row in rows:
        if len(row) < 2:
            continue
        for cell in row:
            for cluster in starts:
                if abs(statistics.mean(cluster) - cell.x0) <= tolerance:
                    cluster.append(cell.x0)
                    break
            else:
                starts.append([cell.x0])
    return sorted(statistics.mean(cluster) for cluster in starts if len(cluster) >= 2)


def detect_table(region: Region) -> Region | None:
    """Rows of cells whose left edges line up in two or more columns. A cell
    that wraps onto a second line is folded back into its row: the wrapped
    line either has nothing in the first column, or sits closer to the row
    above than rows sit to each other."""
    lines = region.lines
    h = _median_height(lines)
    rows = rows_of(lines)
    columns = _column_starts(rows, tolerance=1.2 * h)
    if len(columns) < 2:
        return None

    table_rows = [row for row in rows if len(row) >= 2]
    if len(table_rows) < 2:
        return None

    first = rows.index(table_rows[0])
    body = rows[first:]
    # A single-cell line above the header is the table's caption.
    caption = rows[first - 1] if first > 0 and len(rows[first - 1]) == 1 else None

    def column_of(cell: Line) -> int:
        return min(range(len(columns)), key=lambda index: abs(columns[index] - cell.x0))

    gaps = [body[i + 1][0].y0 - max(line.y1 for line in body[i]) for i in range(len(body) - 1)]
    typical = statistics.median(gaps) if gaps else h
    merged: list[list[str]] = []
    for index, row in enumerate(body):
        cells = [""] * len(columns)
        for cell in row:
            slot = column_of(cell)
            cells[slot] = f"{cells[slot]} {cell.text}".strip()

        wraps = index > 1 and (not cells[0] or gaps[index - 1] < 0.5 * typical)
        if wraps and merged:
            merged[-1] = [f"{a} {b}".strip() for a, b in zip(merged[-1], cells)]
        else:
            merged.append(cells)

    header, *records = merged
    if not records or sum(1 for cell in header if cell) < 2:
        return None
    # Two columns of prose also share rows. A table's cells are short.
    cells = [line for row in body for line in row]
    if sum(1 for line in cells if _is_cell(line)) < 0.7 * len(cells):
        return None

    names = [cell or f"column {i + 1}" for i, cell in enumerate(header)]
    members = [line for row in body for line in row] + (caption or [])
    return Region(
        lines=members,
        kind="table",
        title=caption[0].text if caption else None,
        columns=names,
        data=[
            {name: numeric_value(value) if is_number(value) else value for name, value in zip(names, row)}
            for row in records
            if any(row)
        ],
    )


def analyse(lines: list[Line]) -> list[Region]:
    """Regions in reading order, each typed chart, table or text.

    Charts are found on the whole page before it is cut into regions. A bar's
    value label can sit far above its category, with nothing but the bar in
    between, and a cut through that whitespace would separate every value
    from its label."""
    if not lines:
        return []
    h = _median_height(lines)

    charts: list[Region] = []
    remaining = list(lines)
    while chart := detect_chart(Region(lines=remaining)):
        charts.append(chart)
        remaining = [line for line in remaining if line not in chart.lines]

    regions: list[Region] = []
    for group in _stitch_rows(xy_cut(remaining, gap_y=0.8 * h, gap_x=1.8 * h), h):
        table = detect_table(Region(lines=group))
        if table:
            regions.append(table)
            rest = [line for line in group if line not in table.lines]
            if rest:
                regions.append(Region(lines=rest))
            continue
        regions.append(Region(lines=group))

    for chart in charts:
        _place(regions, chart)
    return _attach_headings(regions)


def _place(regions: list[Region], region: Region) -> None:
    """Puts a region before the first one below it in the same column, which
    keeps a chart inside the column it was printed in."""
    x0, y0, x1, _ = region.box
    for index, other in enumerate(regions):
        ox0, oy0, ox1, _ = other.box
        if oy0 > y0 and min(x1, ox1) - max(x0, ox0) > 0:
            regions.insert(index, region)
            return
    regions.append(region)


def _stitch_rows(groups: list[list[Line]], h: float) -> list[list[Line]]:
    """Joins consecutive groups that are rows of one table. Rows spaced more
    generously than lines of text are cut apart by the whitespace between
    them; they are the same table when their cells start at the same columns."""
    out: list[list[Line]] = []
    for group in groups:
        previous = out[-1] if out else None
        if (
            previous is not None
            and len(group) >= 2
            and all(map(_is_cell, group))
            and all(map(_is_cell, previous))
            and all(len(row) >= 2 for row in rows_of(previous))
            and len(rows_of(group)) == 1
            and group[0].y0 - max(line.y1 for line in previous) <= 3 * h
        ):
            starts = [line.x0 for line in previous]
            aligned = sum(1 for cell in group if any(abs(cell.x0 - x) <= 1.2 * h for x in starts))
            if aligned >= 2:
                out[-1] = [*previous, *group]
                continue
        out.append(group)
    return out


def _attach_headings(regions: list[Region]) -> list[Region]:
    """A lone short line directly before a chart or table is its heading when
    the region has no title of its own, and is kept as text otherwise."""
    out: list[Region] = []
    for region in regions:
        previous = out[-1] if out else None
        if (
            region.kind in ("chart", "table")
            and region.title is None
            and previous is not None
            and previous.kind == "text"
            and len(previous.lines) == 1
            and len(previous.lines[0].text) <= 80
        ):
            region.title = previous.lines[0].text
            region.lines = [*region.lines, *previous.lines]
            out.pop()
        out.append(region)
    return out


def reading_order_text(regions: list[Region]) -> str:
    """The page's text with each region kept together, charts and tables as
    their structured rendering rather than a scatter of tokens."""
    return "\n\n".join(render(to_visual(region, 1, 1, index)) for index, region in enumerate(regions))


def to_visual(region: Region, width: float, height: float, index: int) -> VisualRegion:
    x0, y0, x1, y1 = region.box
    return VisualRegion(
        id=f"r{index + 1}",
        type=region.kind,  # type: ignore[arg-type]
        title=region.title,
        unit=region.unit,
        description=None,
        text=region.text if region.kind == "text" else None,
        columns=region.columns,
        data=region.data,
        bbox=(
            round(x0 / width, 4),
            round(y0 / height, 4),
            round(x1 / width, 4),
            round(y1 / height, 4),
        ),
        origin="layout",
        estimated=False,
        ocrAgreement=1.0 if region.kind in ("chart", "table") else None,
    )


def _format(value: str | float) -> str:
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def render(region: VisualRegion) -> str:
    """The text a region is searched, graded and cited by. Data is written
    both as a table and as one sentence per record, because a retriever and a
    cross-encoder match sentences far better than they match grid rows, and
    "in 2024 the market size was 28.9" is the sentence a question is about.

    Every generated sentence says it is reading the chart or table ("The
    chart shows that…"). Written plainly, they were taken for the document's
    own prose: asked to compare the chart with the text, a model reported that
    "the written text also states 12.1", quoting sentences this function had
    written."""
    if region.type == "text":
        return (region.text or "").strip()

    label = f"{region.type.capitalize()} read from the image"
    head = f"{label}: {region.title}" if region.title else label
    if region.unit:
        head += f" ({region.unit})"
    parts = [head]
    if region.description:
        parts.append(region.description.strip())
    if region.estimated:
        parts.append("Values are estimated from the axis; the chart does not print them.")

    if region.columns and region.data:
        parts.append(" | ".join(region.columns))
        for record in region.data:
            parts.append(" | ".join(_format(record.get(column, "")) for column in region.columns))
        parts.extend(_sentences(region))
    elif region.text:
        parts.append(region.text.strip())
    return "\n".join(parts)


def _sentences(region: VisualRegion) -> list[str]:
    subject = region.title or f"the {region.type}"
    unit = f" {region.unit}" if region.unit else ""
    key, *fields = region.columns
    sentences: list[str] = []
    for record in region.data:
        name = _format(record.get(key, ""))
        if not name:
            continue
        if region.type == "chart" and len(fields) == 1:
            value = _format(record.get(fields[0], ""))
            lead = f"in {name}" if key.strip().lower() == "year" else f"for {name}"
            sentences.append(f"The chart shows that {lead}, {subject} was {value}{unit}.")
        else:
            pairs = [
                f"{column} {_format(record[column])}"
                for column in fields
                if _format(record.get(column, ""))
            ]
            if pairs:
                sentences.append(f"The {region.type} lists {name}: {'; '.join(pairs)}.")
    return sentences
