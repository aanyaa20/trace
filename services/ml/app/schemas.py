"""Pydantic mirrors of packages/contracts. These two definitions must move
together; the Node client validates every response against the Zod version,
so a drift here surfaces as a 502 rather than as corrupt data."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Modality = Literal["text", "pdf", "image", "audio", "video"]
BlockSource = Literal["text", "ocr", "asr", "caption"]
ModelState = Literal["cold", "loading", "loaded", "error"]


class SparseVector(BaseModel):
    indices: list[int]
    values: list[float]


class ExtractBlock(BaseModel):
    ordinal: int
    kind: Literal["text", "image"]
    source: BlockSource
    text: str
    page: int | None = None
    tsStart: float | None = None
    tsEnd: float | None = None
    bbox: tuple[float, float, float, float] | None = None
    imagePath: str | None = None


class ExtractRequest(BaseModel):
    path: str
    mime: str
    documentId: str


class ExtractResponse(BaseModel):
    modality: Modality
    pageCount: int | None = None
    durationSec: float | None = None
    blocks: list[ExtractBlock]
    warnings: list[str] = Field(default_factory=list)


class EmbedTextRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=256)


class EmbedTextResponse(BaseModel):
    dense: list[list[float]]
    sparse: list[SparseVector]


class EmbedImageRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=32)
    caption: bool = True


class EmbedImageResponse(BaseModel):
    clip: list[list[float]]
    captions: list[str | None]


class EmbedQueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    includeClip: bool = False


class EmbedQueryResponse(BaseModel):
    dense: list[float]
    sparse: SparseVector
    clip: list[float] | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    uptimeSec: float
    models: dict[str, ModelState]
    errors: dict[str, str]
