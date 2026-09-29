"""faster-whisper on CTranslate2. int8 on CPU runs the base model at roughly
realtime, which is what keeps a ten minute lecture inside the ingestion budget."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..config import LITE, settings
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


# Groq's free tier takes files up to 25 MB. Twenty minutes of mono speech at
# 32 kbit/s is under 5 MB, so pieces that long stay far inside it.
_PIECE_SEC = 20 * 60


def _duration(path: str) -> float:
    import subprocess

    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, timeout=60, check=True,
    )
    return float(out.stdout.strip() or 0)


def _transcribe_groq(path: str) -> tuple[list[Segment], float]:
    """Lite mode: Whisper large-v3-turbo on Groq, piece by piece, with each
    piece's segment times shifted back onto the recording's own clock."""
    import subprocess
    import tempfile
    import time

    import httpx

    duration = _duration(path)
    collected: list[Segment] = []
    with tempfile.TemporaryDirectory() as scratch:
        start = 0.0
        while start < max(duration, 0.1):
            piece = f"{scratch}/piece.mp3"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(_PIECE_SEC), "-i", path,
                 "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", piece],
                check=True, timeout=600,
            )
            for attempt in range(5):
                with open(piece, "rb") as audio:
                    response = httpx.post(
                        "https://api.groq.com/openai/v1/audio/transcriptions",
                        headers={"Authorization": f"Bearer {settings.groq_api_key}"},
                        data={
                            "model": settings.groq_whisper_model,
                            "response_format": "verbose_json",
                            "temperature": "0",
                        },
                        files={"file": ("piece.mp3", audio, "audio/mpeg")},
                        timeout=300,
                    )
                if response.status_code == 200:
                    break
                if response.status_code in (429, 500, 502, 503) and attempt < 4:
                    time.sleep(10 * (attempt + 1))
                    continue
                raise RuntimeError(f"groq transcription failed: {response.status_code} {response.text[:300]}")
            for segment in response.json().get("segments") or []:
                text = str(segment.get("text") or "").strip()
                if text:
                    collected.append(
                        Segment(
                            start=start + float(segment["start"]),
                            end=start + float(segment["end"]),
                            text=text,
                        )
                    )
            start += _PIECE_SEC
    return collected, duration


def transcribe(path: str) -> tuple[list[Segment], float]:
    """Returns timed segments and the detected duration. Word timestamps are
    on because a citation that points at a whole segment is not precise enough
    to seek to."""
    if LITE:
        return _transcribe_groq(path)
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
