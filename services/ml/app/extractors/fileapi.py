"""Last-resort extraction through the Gemini File API.

The local pipeline is the contribution and handles every format we claim to
support. This exists for the long tail a demo eventually meets: a .docx, an
exotic container, a PDF whose text layer defeats PyMuPDF. It is opt-out via
GEMINI_FILE_API_FALLBACK so the pipeline can be proven fully offline."""

from __future__ import annotations

import logging
import mimetypes
import time
from pathlib import Path

from ..config import settings
from ..schemas import ExtractBlock, ExtractResponse

logger = logging.getLogger("trace.ml.fileapi")

_POLL_SECONDS = 2
_MAX_WAIT_SECONDS = 120
_PROMPT = (
    "Transcribe this document to plain text. Preserve reading order and "
    "paragraph breaks. Do not summarise, comment, or add headings that are "
    "not in the source."
)


def extract_via_file_api(path: str, mime: str) -> ExtractResponse:
    if not settings.gemini_file_api_fallback:
        raise ValueError(
            f"no local extractor handles {mime} and GEMINI_FILE_API_FALLBACK is disabled"
        )
    if not settings.gemini_api_key:
        raise ValueError(
            f"no local extractor handles {mime} and GEMINI_API_KEY is not set for the fallback"
        )

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=settings.gemini_api_key)
    file_path = Path(path)
    upload_mime = mime or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"

    uploaded = client.files.upload(
        file=str(file_path),
        config=types.UploadFileConfig(mime_type=upload_mime, display_name=file_path.name),
    )

    try:
        waited = 0
        while getattr(getattr(uploaded, "state", None), "name", "") == "PROCESSING":
            if waited >= _MAX_WAIT_SECONDS:
                raise TimeoutError(
                    f"gemini file api still processing {file_path.name} after {_MAX_WAIT_SECONDS}s"
                )
            time.sleep(_POLL_SECONDS)
            waited += _POLL_SECONDS
            uploaded = client.files.get(name=uploaded.name)

        state = getattr(getattr(uploaded, "state", None), "name", "")
        if state and state not in {"ACTIVE", "SUCCEEDED"}:
            raise ValueError(f"gemini file api rejected {file_path.name}: state {state}")

        response = client.models.generate_content(
            model=settings.gemini_caption_model,
            contents=[
                types.Part.from_uri(file_uri=uploaded.uri, mime_type=upload_mime),
                _PROMPT,
            ],
            config=types.GenerateContentConfig(temperature=0.0),
        )
        text = (response.text or "").strip()
        if not text:
            raise ValueError(f"gemini file api returned no text for {file_path.name}")

    finally:
        # The free tier caps stored files; leaving them behind eventually
        # breaks ingestion for everyone sharing the key.
        name = getattr(uploaded, "name", None)
        if name:
            try:
                client.files.delete(name=name)
            except Exception as exc:
                logger.warning("could not delete uploaded file %s: %s", name, exc)

    return ExtractResponse(
        modality="text",
        pageCount=None,
        durationSec=None,
        blocks=[ExtractBlock(ordinal=0, kind="text", source="text", text=text, page=None)],
        warnings=[
            f"local extraction unavailable for {upload_mime}; text came from the gemini file api"
        ],
    )
