"""Tables as tables.

Flattening a table into prose loses the one thing that makes it a table: that
"91" is Aanya's score and not her hours. Every chunk here is a small markdown
table that repeats the header row, so a retrieved passage always carries its
column names, and a row is never separated from what its cells mean.

Arithmetic is done here, deterministically, and emitted as its own block. A
language model asked for "the average score" over retrieved rows would either
average the handful it was shown or do the sum in its head; a stats block lets
it quote a number that was actually computed over every row, with a citation
to the block that computed it."""

from __future__ import annotations

import math
from statistics import mean, median

from ..schemas import ExtractBlock

ROWS_PER_BLOCK = 20
TOP_N = 3


def _cell(value: object) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", " ").strip()


def _number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return None if math.isnan(float(value)) else float(value)
    text = str(value).strip().replace(",", "")
    if text.endswith("%"):
        text = text[:-1]
    try:
        return float(text)
    except ValueError:
        return None


def _fmt(value: float) -> str:
    return str(int(value)) if value == int(value) else f"{value:.4g}"


def _markdown(header: list[str], rows: list[list[object]]) -> str:
    lines = [
        "| " + " | ".join(_cell(h) for h in header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    for row in rows:
        padded = list(row) + [""] * (len(header) - len(row))
        lines.append("| " + " | ".join(_cell(c) for c in padded[: len(header)]) + " |")
    return "\n".join(lines)


def normalise_table(raw: list[list[object]]) -> tuple[list[str], list[list[object]]]:
    """First non-empty row is the header; blank rows are dropped; unnamed
    columns get a positional name so no cell is left without a label."""
    rows = [row for row in raw if any(_cell(c) for c in row)]
    if not rows:
        return [], []
    width = max(len(row) for row in rows)
    header = [(_cell(h) or f"Column {i + 1}") for i, h in enumerate(list(rows[0]) + [""] * (width - len(rows[0])))]
    return header, [list(row) + [""] * (width - len(row)) for row in rows[1:]]


def stats_text(title: str, header: list[str], rows: list[list[object]]) -> str | None:
    """Per numeric column: count, sum, mean, median, min and max with the row
    they came from, and the top and bottom rows. The row is named by the first
    column that is not numeric, which is almost always the label column."""
    if not rows:
        return None

    numeric_cols: list[int] = []
    for index in range(len(header)):
        values = [_number(row[index]) for row in rows]
        present = [v for v in values if v is not None]
        filled = [row[index] for row in rows if _cell(row[index])]
        if present and len(present) >= max(1, int(0.8 * len(filled))):
            numeric_cols.append(index)
    label_col = next((i for i in range(len(header)) if i not in numeric_cols), None)

    def name(row: list[object], position: int) -> str:
        return _cell(row[label_col]) if label_col is not None else f"row {position + 1}"

    lines = [f"## {title} — computed statistics", f"{len(rows)} data rows, columns: {', '.join(header)}."]
    for index in numeric_cols:
        pairs = [(v, name(row, i)) for i, row in enumerate(rows) if (v := _number(row[index])) is not None]
        if not pairs:
            continue
        values = [v for v, _ in pairs]
        ranked = sorted(pairs, key=lambda pair: pair[0], reverse=True)
        top = ", ".join(f"{who} ({_fmt(v)})" for v, who in ranked[:TOP_N])
        bottom = ", ".join(f"{who} ({_fmt(v)})" for v, who in ranked[-TOP_N:][::-1])
        lines.append(
            # Everyday words beside the statistical ones ("average", "highest",
            # "total"), so a question phrased either way matches this block.
            f"Column {header[index]}: count {len(values)}, sum (total) {_fmt(sum(values))}, "
            f"mean (average) {_fmt(mean(values))}, median {_fmt(median(values))}, "
            f"minimum (lowest) {_fmt(ranked[-1][0])} ({ranked[-1][1]}), "
            f"maximum (highest) {_fmt(ranked[0][0])} ({ranked[0][1]}). "
            f"Top {min(TOP_N, len(ranked))} (highest first): {top}. "
            f"Bottom {min(TOP_N, len(ranked))} (lowest first): {bottom}."
        )
    return "\n".join(lines) if len(lines) > 2 else None


def table_blocks(
    title: str,
    raw: list[list[object]],
    start_ordinal: int,
    page: int | None = None,
) -> list[ExtractBlock]:
    """A computed-statistics block first, then the rows in header-carrying
    slices of ROWS_PER_BLOCK. Each slice's section names its row range."""
    header, rows = normalise_table(raw)
    if not header:
        return []

    blocks: list[ExtractBlock] = []
    ordinal = start_ordinal
    stats = stats_text(title, header, rows)
    if stats:
        blocks.append(
            ExtractBlock(
                ordinal=ordinal, kind="text", source="text", text=stats, page=page,
                section=f"{title} — statistics",
            )
        )
        ordinal += 1

    for start in range(0, max(len(rows), 1), ROWS_PER_BLOCK):
        chunk = rows[start : start + ROWS_PER_BLOCK]
        label = f"{title} — rows {start + 1}–{start + len(chunk)}" if chunk else title
        blocks.append(
            ExtractBlock(
                ordinal=ordinal, kind="text", source="text",
                text=f"## {label}\n{_markdown(header, chunk)}", page=page, section=label,
            )
        )
        ordinal += 1
    return blocks
