from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..models import clip, text
from ..models.caption import caption_image
from ..pool import run_blocking
from ..schemas import (
    EmbedImageRequest,
    EmbedImageResponse,
    EmbedQueryRequest,
    EmbedQueryResponse,
    EmbedTextRequest,
    EmbedTextResponse,
)

logger = logging.getLogger("trace.ml.embed")
router = APIRouter()


def _embed_text_batch(texts: list[str]) -> EmbedTextResponse:
    return EmbedTextResponse(
        dense=text.embed_dense(texts),
        sparse=text.embed_sparse(texts),
    )


@router.post("/embed/text", response_model=EmbedTextResponse)
async def embed_text(request: EmbedTextRequest) -> EmbedTextResponse:
    # fastembed rejects empty strings; an empty OCR page is normal input, so a
    # placeholder keeps positional alignment with the caller's chunk list.
    prepared = [value if value.strip() else " " for value in request.texts]

    try:
        return await run_blocking(_embed_text_batch, prepared)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


def _embed_image_batch(paths: list[str], want_captions: bool) -> EmbedImageResponse:
    vectors = clip.embed_images(paths)
    captions = [caption_image(path) if want_captions else None for path in paths]
    return EmbedImageResponse(clip=vectors, captions=captions)


@router.post("/embed/image", response_model=EmbedImageResponse)
async def embed_image(request: EmbedImageRequest) -> EmbedImageResponse:
    try:
        return await run_blocking(_embed_image_batch, request.paths, request.caption)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


def _embed_query(query: str, include_clip: bool) -> EmbedQueryResponse:
    return EmbedQueryResponse(
        dense=text.embed_dense_query(query),
        sparse=text.embed_sparse_query(query),
        clip=clip.embed_text(query) if include_clip else None,
    )


@router.post("/embed/query", response_model=EmbedQueryResponse)
async def embed_query(request: EmbedQueryRequest) -> EmbedQueryResponse:
    """Both vectors in one call because Qdrant needs the dense and sparse sides
    of a hybrid query together, and a second round trip per question is latency
    the agent loop pays on every iteration."""
    try:
        return await run_blocking(_embed_query, request.query, request.includeClip)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
