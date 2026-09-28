"""Pydantic mirrors of packages/contracts. These two definitions must move
together; the Node client validates every response against the Zod version,
so a drift here surfaces as a 502 rather than as corrupt data."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Modality = Literal["text", "pdf", "image", "audio", "video"]
BlockSource = Literal["text", "ocr", "asr", "caption", "vision"]
RegionType = Literal[
    "text", "chart", "table", "diagram", "photo", "form", "handwriting", "screenshot"
]
ModelState = Literal["cold", "loading", "loaded", "error"]


class SparseVector(BaseModel):
    indices: list[int]
    values: list[float]


class VisualRegion(BaseModel):
    """One region of an image: a paragraph, a chart, a table, a photo. Data
    regions keep their label-value pairs as records, so "2024" and "28.9"
    stay one fact instead of two tokens a dozen lines apart."""

    id: str
    type: RegionType
    title: str | None = None
    unit: str | None = None
    # What a photo, diagram or chart shows, in words; from a vision model.
    description: str | None = None
    # The region's own text, for text, form and handwriting regions.
    text: str | None = None
    # Column order for `data`. For a chart: the x-axis label, then each series.
    columns: list[str] = Field(default_factory=list)
    data: list[dict[str, str | float]] = Field(default_factory=list)
    # Normalised to the image, 0-1: x0, y0, x1, y1.
    bbox: tuple[float, float, float, float] | None = None
    # "layout" is geometry on the OCR boxes; "vision" is a vision model's read.
    origin: Literal["layout", "vision"]
    # True when a chart prints no data labels and the values were read off
    # the axis, so the answer can say they are approximate.
    estimated: bool = False
    # Share of the region's numbers that OCR independently read in the image.
    # None when the region has no numbers to check.
    ocrAgreement: float | None = None


class ExtractBlock(BaseModel):
    ordinal: int
    kind: Literal["text", "image", "region"]
    source: BlockSource
    text: str
    page: int | None = None
    tsStart: float | None = None
    tsEnd: float | None = None
    bbox: tuple[float, float, float, float] | None = None
    imagePath: str | None = None
    # Heading this block sits under, or a slide title, when known.
    section: str | None = None
    visual: VisualRegion | None = None


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


class RerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    passages: list[str] = Field(min_length=1, max_length=100)


class RerankResponse(BaseModel):
    # Raw cross-encoder logits and their sigmoid, aligned with the request's
    # passages. Order is the caller's; nothing is sorted here.
    logits: list[float]
    scores: list[float]
    model: str


class VisionAnswerRequest(BaseModel):
    path: str
    question: str = Field(min_length=1, max_length=4000)
    # Normalised region to look at; the whole image when absent.
    bbox: tuple[float, float, float, float] | None = None


class VisionAnswerResponse(BaseModel):
    # False when no vision model is configured or every provider failed, so
    # the caller can tell "the image does not show it" from "nobody looked".
    available: bool
    found: bool
    answer: str | None = None
    evidence: str | None = None
    model: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    uptimeSec: float
    models: dict[str, ModelState]
    errors: dict[str, str]
