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

    gemini_api_key: str
    gemini_caption_model: str
    gemini_file_api_fallback: bool


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
    gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
    gemini_caption_model=os.getenv("GEMINI_CAPTION_MODEL", "gemini-3.8-flash"),
    gemini_file_api_fallback=_bool("GEMINI_FILE_API_FALLBACK", True),
)
