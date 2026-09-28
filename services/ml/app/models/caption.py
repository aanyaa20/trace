"""Image captions come from a hosted vision model rather than a local BLIP
checkpoint. BLIP-base would add roughly 2 GB of resident memory for a job that
runs a handful of times per document, and the free tiers cover it.

The provider chain, timeouts and retries live in models/vision.py, so a caption
falls through to the next provider rather than waiting out an overloaded one."""

from __future__ import annotations

from . import vision


def caption_image(image_path: str) -> str | None:
    """Returns None rather than raising: a missing caption degrades retrieval
    for one chunk, while a raised error would fail the whole document."""
    reply = vision.ask(vision.CAPTION_PROMPT, image_path)
    return reply.text if reply else None
