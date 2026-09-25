"""faster-whisper on CTranslate2. int8 on CPU runs the base model at roughly
realtime, which is what keeps a ten minute lecture inside the ingestion budget."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..config import settings
from ..registry import LazyModel, registry

if TYPE_CHECKING:
    from faster_whisper import WhisperModel


@dataclass
class Segment:
    start: float
    end: float
    text: str


def _load() -> "WhisperModel":
    from faster_whisper import WhisperModel

    return WhisperModel(
        settings.whisper_model,
        device="cpu",
        compute_type=settings.whisper_compute_type,
    )


whisper_model: LazyModel["WhisperModel"] = LazyModel("whisper", _load)
registry.register(whisper_model)  # type: ignore[arg-type]

_transcribe_lock = threading.Lock()


def transcribe(path: str) -> tuple[list[Segment], float]:
    """Returns timed segments and the detected duration. Word timestamps are
    on because a citation that points at a whole segment is not precise enough
    to seek to."""
    model = whisper_model.get()

    # One decode at a time: CTranslate2 sizes its own thread pool from
    # OMP_NUM_THREADS, and two concurrent decodes oversubscribe every core.
    with _transcribe_lock:
        segments, info = model.transcribe(
            path,
            vad_filter=True,
            word_timestamps=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        collected = [
            Segment(start=float(s.start), end=float(s.end), text=s.text.strip())
            for s in segments
            if s.text and s.text.strip()
        ]

    return collected, float(info.duration)
