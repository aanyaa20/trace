from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import settings
from ..extractors.fileapi import extract_via_file_api
from ..extractors.image import extract_image
from ..extractors.media import extract_audio, extract_video
from ..extractors.pdf import extract_pdf
from ..extractors.text import extract_text
from ..pool import run_blocking
from ..schemas import ExtractRequest, ExtractResponse

logger = logging.getLogger("trace.ml.extract")
router = APIRouter()

_TEXT_MIMES = {"application/json", "application/xml", "application/x-ndjson"}


def _resolve_within_uploads(raw_path: str) -> Path:
    """The path arrives over HTTP from the api service. Even though both sides
    are ours, a traversal here would read anything the container can see."""
    root = settings.upload_dir.resolve()
    candidate = Path(raw_path).resolve()

    if not candidate.is_relative_to(root):
        raise HTTPException(400, f"path is outside the upload directory: {raw_path}")
    if not candidate.is_file():
        raise HTTPException(404, f"file not found: {raw_path}")
    return candidate


def _dispatch(path: str, mime: str, document_id: str) -> ExtractResponse:
    normalised = mime.split(";")[0].strip().lower()

    if normalised == "application/pdf":
        return extract_pdf(path, document_id)
    if normalised.startswith("image/"):
        return extract_image(path)
    if normalised.startswith("audio/"):
        return extract_audio(path)
    if normalised.startswith("video/"):
        return extract_video(path, document_id)
    if normalised.startswith("text/") or normalised in _TEXT_MIMES:
        return extract_text(path)

    return extract_via_file_api(path, normalised)


@router.post("/extract", response_model=ExtractResponse)
async def extract(request: ExtractRequest) -> ExtractResponse:
    resolved = _resolve_within_uploads(request.path)

    try:
        response = await run_blocking(
            _dispatch, str(resolved), request.mime, request.documentId
        )
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, TimeoutError) as exc:
        raise HTTPException(422, f"extraction failed for {resolved.name}: {exc}") from exc
    except Exception as exc:
        logger.exception("extraction crashed for document %s", request.documentId)
        raise HTTPException(
            500, f"extraction failed for document {request.documentId}: {type(exc).__name__}: {exc}"
        ) from exc

    logger.info(
        "extracted document=%s modality=%s blocks=%d warnings=%d",
        request.documentId,
        response.modality,
        len(response.blocks),
        len(response.warnings),
    )
    return response
