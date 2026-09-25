from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

from ..config import settings
from ..models.whisper import transcribe
from ..schemas import ExtractBlock, ExtractResponse

logger = logging.getLogger("trace.ml.media")

_FFPROBE_TIMEOUT_SEC = 30
_FFMPEG_TIMEOUT_SEC = 600


def probe_duration(path: str) -> float | None:
    try:
        completed = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "json", path,
            ],
            capture_output=True,
            text=True,
            timeout=_FFPROBE_TIMEOUT_SEC,
            check=True,
        )
        return float(json.loads(completed.stdout)["format"]["duration"])
    except (subprocess.SubprocessError, KeyError, ValueError) as exc:
        logger.warning("ffprobe could not read duration for %s: %s", path, exc)
        return None


def extract_audio(path: str) -> ExtractResponse:
    """One block per whisper segment, each carrying its own timestamp span.
    Those spans are what a citation seeks to, so they are never merged here."""
    segments, duration = transcribe(path)

    blocks = [
        ExtractBlock(
            ordinal=index,
            kind="text",
            source="asr",
            text=segment.text,
            tsStart=segment.start,
            tsEnd=segment.end,
        )
        for index, segment in enumerate(segments)
    ]

    warnings = [] if blocks else ["no speech detected; the file may be silent or music only"]
    return ExtractResponse(
        modality="audio",
        pageCount=None,
        durationSec=duration,
        blocks=blocks,
        warnings=warnings,
    )


def extract_video(path: str, document_id: str) -> ExtractResponse:
    """Transcript segments plus sampled keyframes. A lecture slide that is
    never spoken aloud is only findable through the frame, and a spoken aside
    that is never shown is only findable through the transcript."""
    segments, duration = transcribe(path)

    blocks: list[ExtractBlock] = [
        ExtractBlock(
            ordinal=index,
            kind="text",
            source="asr",
            text=segment.text,
            tsStart=segment.start,
            tsEnd=segment.end,
        )
        for index, segment in enumerate(segments)
    ]

    warnings: list[str] = []
    if not segments:
        warnings.append("no speech detected in the video track")

    frames, frame_warnings = _extract_keyframes(path, document_id, duration)
    warnings.extend(frame_warnings)

    interval = settings.video_keyframe_interval_sec
    for offset, frame_path in enumerate(frames):
        timestamp = float(offset * interval)

        # ffmpeg's fps filter can emit a trailing frame at or past the end of a
        # short clip. Such a frame has no position on the timeline to cite, and
        # keeping it produced a chunk whose end preceded its start.
        if duration is not None and timestamp >= duration:
            warnings.append(
                f"discarded keyframe at {timestamp:.0f}s, past the {duration:.1f}s duration"
            )
            frame_path.unlink(missing_ok=True)
            continue

        end = min(timestamp + interval, duration) if duration else timestamp + interval
        blocks.append(
            ExtractBlock(
                ordinal=len(blocks),
                kind="image",
                source="caption",
                text="",
                tsStart=timestamp,
                tsEnd=max(end, timestamp),
                imagePath=str(frame_path),
            )
        )

    return ExtractResponse(
        modality="video",
        pageCount=None,
        durationSec=duration,
        blocks=blocks,
        warnings=warnings,
    )


def _extract_keyframes(
    path: str, document_id: str, duration: float | None
) -> tuple[list[Path], list[str]]:
    interval = settings.video_keyframe_interval_sec
    frame_dir = Path(settings.upload_dir) / "derived" / document_id / "frames"
    frame_dir.mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-y",
                "-i", path,
                "-vf", f"fps=1/{interval}",
                "-frames:v", "200",
                str(frame_dir / "frame-%04d.jpg"),
            ],
            capture_output=True,
            text=True,
            timeout=_FFMPEG_TIMEOUT_SEC,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        return [], [f"keyframe extraction failed: ffmpeg exited {exc.returncode}: {exc.stderr[:200]}"]
    except subprocess.TimeoutExpired:
        return [], [f"keyframe extraction timed out after {_FFMPEG_TIMEOUT_SEC}s"]

    frames = sorted(frame_dir.glob("frame-*.jpg"))
    warnings = [] if frames else ["no keyframes were produced; the file may have no video track"]
    return frames, warnings
