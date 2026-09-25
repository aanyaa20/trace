from __future__ import annotations

from pathlib import Path

from ..schemas import ExtractBlock, ExtractResponse

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
