from __future__ import annotations

from pathlib import Path

import csv
import io

from ..schemas import ExtractBlock, ExtractResponse
from .tables import table_blocks

# Text files carry no page or timestamp structure, so the whole file is one
# block and Node's chunker supplies the character offsets.
_MAX_BYTES = 32 * 1024 * 1024


def extract_text(path: str) -> ExtractResponse:
    file_path = Path(path)
    size = file_path.stat().st_size
    if size > _MAX_BYTES:
        raise ValueError(f"text file is {size} bytes, over the {_MAX_BYTES} byte limit")

    raw = file_path.read_bytes()
    try:
        content = raw.decode("utf-8")
        warnings: list[str] = []
    except UnicodeDecodeError:
        content = raw.decode("utf-8", errors="replace")
        warnings = ["file was not valid utf-8; undecodable bytes were replaced"]

    return ExtractResponse(
        modality="text",
        pageCount=None,
        durationSec=None,
        blocks=[
            ExtractBlock(ordinal=0, kind="text", source="text", text=content, page=None)
        ],
        warnings=warnings,
    )


def extract_delimited(path: str, delimiter: str | None = None) -> ExtractResponse:
    """CSV/TSV through the table path: header-carrying row slices plus
    computed statistics, instead of one undifferentiated block of commas."""
    base = extract_text(path)
    content = base.blocks[0].text
    if delimiter is None:
        try:
            delimiter = csv.Sniffer().sniff(content[:4096], delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
    rows = [row for row in csv.reader(io.StringIO(content), delimiter=delimiter)]
    blocks = table_blocks(Path(path).name.split("-", 5)[-1], rows, 0)
    if not blocks:
        return base
    return ExtractResponse(
        modality="text", pageCount=None, durationSec=None, blocks=blocks, warnings=base.warnings
    )
