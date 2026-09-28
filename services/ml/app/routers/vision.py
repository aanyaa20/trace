from __future__ import annotations

import logging

from fastapi import APIRouter

from ..models import vision
from ..pool import run_blocking
from ..schemas import VisionAnswerRequest, VisionAnswerResponse
from .extract import _resolve_within_uploads

logger = logging.getLogger("trace.ml.vision")
router = APIRouter()


def _answer(path: str, question: str, bbox: tuple[float, float, float, float] | None) -> VisionAnswerResponse:
    if not vision.available():
        return VisionAnswerResponse(available=False, found=False)
    reply = vision.ask(vision.QUESTION_PROMPT + question, path, bbox=bbox, json_mode=True, max_tokens=300)
    if not reply:
        return VisionAnswerResponse(available=False, found=False)
    parsed = vision.parse_json(reply.text) or {}
    answer = str(parsed.get("answer") or "").strip() or None
    evidence = str(parsed.get("evidence") or "").strip() or None
    found = bool(parsed.get("found")) and answer is not None
    return VisionAnswerResponse(
        available=True,
        found=found,
        answer=answer if found else None,
        evidence=evidence if found else None,
        model=reply.model,
    )


@router.post("/vision/answer", response_model=VisionAnswerResponse)
async def vision_answer(request: VisionAnswerRequest) -> VisionAnswerResponse:
    """Asks a vision model one question about one image, or one region of it.
    The agent calls this before abstaining, when text retrieval found the
    image but not the answer in it."""
    resolved = _resolve_within_uploads(request.path)
    return await run_blocking(_answer, str(resolved), request.question, request.bbox)
