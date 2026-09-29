"""Environment-derived settings. Read once at import so a misconfigured
container fails at startup rather than on the first request."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got {raw!r}") from exc


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _list(name: str, default: str) -> tuple[str, ...]:
    raw = os.getenv(name)
    value = default if raw is None or raw.strip() == "" else raw
    return tuple(part.strip() for part in value.split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    upload_dir: Path
    log_level: str
    threadpool_workers: int

    text_embedding_model: str
    sparse_embedding_model: str
    clip_model: str
    clip_pretrained: str
    whisper_model: str
    whisper_compute_type: str

    pdf_ocr_char_threshold: int
    pdf_ocr_dpi: int
    video_keyframe_interval_sec: int

    rerank_model: str

    gemini_api_key: str
    gemini_caption_model: str
    gemini_file_api_fallback: bool

    groq_api_key: str
    # Tried in order until one answers. Each is skipped when it has no key.
    vision_providers: tuple[str, ...]
    groq_vision_model: str
    # Gemini models tried after the caption model, for when it is overloaded.
    gemini_vision_fallback_models: tuple[str, ...]
    vision_timeout_sec: int
    # Read each uploaded image's charts and tables with a vision model at
    # ingestion. Off leaves only the OCR-geometry reading.
    vision_structure: bool

    # "full" runs every model locally (about 3 GB of memory). "lite" replaces
    # each with a hosted API so the service fits a 512 MB free instance:
    # Gemini embeddings, Groq Whisper, vision-model text reading, and no
    # reranker or CLIP. Same endpoints, same response shapes.
    ml_mode: str
    gemini_embedding_model: str
    embedding_dim: int
    groq_whisper_model: str


settings = Settings(
    upload_dir=Path(os.getenv("UPLOAD_DIR", "/data/uploads")),
    log_level=os.getenv("ML_LOG_LEVEL", "info"),
    threadpool_workers=_int("ML_THREADPOOL_WORKERS", 2),
    text_embedding_model=os.getenv("TEXT_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"),
    sparse_embedding_model=os.getenv("SPARSE_EMBEDDING_MODEL", "Qdrant/bm25"),
    clip_model=os.getenv("CLIP_MODEL", "ViT-B-32"),
    clip_pretrained=os.getenv("CLIP_PRETRAINED", "laion2b_s34b_b79k"),
    whisper_model=os.getenv("WHISPER_MODEL", "base"),
    whisper_compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"),
    pdf_ocr_char_threshold=_int("PDF_OCR_CHAR_THRESHOLD", 40),
    pdf_ocr_dpi=_int("PDF_OCR_DPI", 200),
    video_keyframe_interval_sec=_int("VIDEO_KEYFRAME_INTERVAL_SEC", 30),
    rerank_model=os.getenv("RERANK_MODEL", "Xenova/ms-marco-MiniLM-L-12-v2"),
    gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
    gemini_caption_model=os.getenv("GEMINI_CAPTION_MODEL", "gemini-3.8-flash"),
    gemini_file_api_fallback=_bool("GEMINI_FILE_API_FALLBACK", True),
    groq_api_key=os.getenv("GROQ_API_KEY", ""),
    vision_providers=_list("VISION_PROVIDERS", "groq,gemini"),
    groq_vision_model=os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b"),
    # gemini-2.5-flash was withdrawn for new keys; each of these has its own
    # free quota, so one spent model does not stop the rest.
    gemini_vision_fallback_models=_list(
        "GEMINI_VISION_FALLBACK_MODELS", "gemini-3.5-flash,gemini-3.1-flash-lite,gemini-flash-latest"
    ),
    vision_timeout_sec=_int("VISION_TIMEOUT_SEC", 30),
    vision_structure=_bool("VISION_STRUCTURE", True),
    ml_mode=os.getenv("ML_MODE", "full").strip().lower(),
    gemini_embedding_model=os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001"),
    embedding_dim=_int("EMBEDDING_DIM", 768),
    groq_whisper_model=os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo"),
)

LITE = settings.ml_mode == "lite"
