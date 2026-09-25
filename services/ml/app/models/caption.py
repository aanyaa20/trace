"""Image captions come from Gemini Flash rather than a local BLIP checkpoint.
BLIP-base would add roughly 2 GB of resident memory for a job that runs a
handful of times per document, and the free tier covers it."""

from __future__ import annotations

import logging
import mimetypes
import random
import time
from pathlib import Path

from ..config import settings

logger = logging.getLogger("trace.ml.caption")

# The free tier answers 503 under load often enough that a single attempt
# loses captions routinely. Mirrors the retry policy the Node provider uses.
_MAX_ATTEMPTS = 4
_RETRYABLE = ("429", "500", "502", "503", "504", "UNAVAILABLE", "RESOURCE_EXHAUSTED")

_PROMPT = (
    "Describe this image for a document search index. State what is shown, "
    "including any visible text, numbers, axis labels or captions, in at most "
    "three sentences. Do not speculate about anything not visible."
)


def _is_retryable(error: Exception) -> bool:
    message = str(error)
    return any(token in message for token in _RETRYABLE)


def caption_image(image_path: str) -> str | None:
    """Returns None rather than raising: a missing caption degrades retrieval
    for one chunk, while a raised error would fail the whole document."""
    if not settings.gemini_api_key:
        return None

    from google import genai
    from google.genai import types

    path = Path(image_path)
    mime = mimetypes.guess_type(path.name)[0] or "image/png"

    for attempt in range(_MAX_ATTEMPTS):
        try:
            client = genai.Client(api_key=settings.gemini_api_key)
            response = client.models.generate_content(
                model=settings.gemini_caption_model,
                contents=[
                    types.Part.from_bytes(data=path.read_bytes(), mime_type=mime),
                    _PROMPT,
                ],
                config=types.GenerateContentConfig(temperature=0.0, max_output_tokens=200),
            )
            text = (response.text or "").strip()
            return text or None
        except Exception as exc:
            if attempt == _MAX_ATTEMPTS - 1 or not _is_retryable(exc):
                logger.warning("caption failed for %s: %s", image_path, exc)
                return None
            # Full jitter, so a batch of images does not resynchronise on the
            # next attempt and recreate the spike.
            delay = random.uniform(0, min(8.0, 0.5 * (2**attempt)))
            logger.info(
                "caption attempt %d/%d failed for %s, retrying in %.1fs",
                attempt + 1,
                _MAX_ATTEMPTS,
                path.name,
                delay,
            )
            time.sleep(delay)

    return None
