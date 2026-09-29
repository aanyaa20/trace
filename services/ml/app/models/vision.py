"""A vision model, for what OCR geometry cannot read: bars without printed
labels, a photo's content, a diagram's arrows, handwriting.

Providers are tried in VISION_PROVIDERS order, each skipped when it has no
key. The free tiers answer 503 under load often enough that one provider is
not enough: during testing every Gemini Flash model was overloaded for an hour
while Groq's Qwen read the same chart correctly in four seconds. Each call has
a hard timeout, because an overloaded endpoint that takes 37 seconds to say
"unavailable" is worse than one that fails at once.

Nothing here is trusted on its own. extractors/image.py checks every number a
vision model reports against what OCR read in the same image.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..config import settings

logger = logging.getLogger("trace.ml.vision")

_RETRYABLE = ("429", "500", "502", "503", "504", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "timed out")
_ATTEMPTS_PER_MODEL = 2
# Large enough to read an axis label, small enough to stay far below the
# providers' inline-image limits.
_MAX_SIDE = 1600


@dataclass(frozen=True)
class VisionReply:
    text: str
    model: str


def available() -> bool:
    return any(_has_key(provider) for provider in settings.vision_providers)


def _has_key(provider: str) -> bool:
    if provider == "groq":
        return bool(settings.groq_api_key)
    if provider == "gemini":
        return bool(settings.gemini_api_key)
    return False


def encode(path: str, bbox: tuple[float, float, float, float] | None = None) -> bytes:
    """JPEG bytes of the image, or of one normalised region of it with a
    margin, so a question about a chart is asked of the chart and its axis."""
    from PIL import Image

    with Image.open(path) as source:
        image = source.convert("RGB")
    if bbox:
        width, height = image.size
        pad_x, pad_y = 0.06 * width, 0.06 * height
        x0, y0, x1, y1 = bbox
        image = image.crop(
            (
                max(0, int(x0 * width - pad_x)),
                max(0, int(y0 * height - pad_y)),
                min(width, int(x1 * width + pad_x)),
                min(height, int(y1 * height + pad_y)),
            )
        )
    image.thumbnail((_MAX_SIDE, _MAX_SIDE))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def _groq(prompt: str, image: bytes, json_mode: bool, max_tokens: int) -> str:
    data_url = "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")
    body: dict[str, object] = {
        "model": settings.groq_vision_model,
        "temperature": 0,
        # Groq's free tier allows 1,000 output tokens a minute for this model,
        # and counts the ceiling asked for, so the ceiling is kept to what the
        # reply needs.
        "max_completion_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    response = httpx.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {settings.groq_api_key}"},
        json=body,
        timeout=settings.vision_timeout_sec,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"{response.status_code} {response.text[:300]}")
    return str(response.json()["choices"][0]["message"]["content"] or "")


def _gemini(model: str, prompt: str, image: bytes, json_mode: bool, max_tokens: int) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(
        api_key=settings.gemini_api_key,
        http_options=types.HttpOptions(timeout=settings.vision_timeout_sec * 1000),
    )
    response = client.models.generate_content(
        model=model,
        contents=[types.Part.from_bytes(data=image, mime_type="image/jpeg"), prompt],
        config=types.GenerateContentConfig(
            temperature=0.0,
            # Gemini's thinking models spend output tokens before they answer,
            # and its limits are per request, not per minute; the ceiling is
            # generous so the reply is not cut off mid-object.
            max_output_tokens=max(4 * max_tokens, 2048),
            **({"response_mime_type": "application/json"} if json_mode else {}),
        ),
    )
    return response.text or ""


def _candidates() -> list[tuple[str, str]]:
    """(provider, model) pairs in the order they are tried."""
    pairs: list[tuple[str, str]] = []
    for provider in settings.vision_providers:
        if not _has_key(provider):
            continue
        if provider == "groq":
            pairs.append(("groq", settings.groq_vision_model))
        elif provider == "gemini":
            for model in (settings.gemini_caption_model, *settings.gemini_vision_fallback_models):
                if ("gemini", model) not in pairs:
                    pairs.append(("gemini", model))
    return pairs


# How each provider writes a box. Gemini is trained on [ymin, xmin, ymax,
# xmax]; Qwen on [x0, y0, x1, y1]. Asking each for its own convention, and
# reading the reply the same way, is what puts a box on the right region.
BOX_ORDERS = {"gemini": "[ymin, xmin, ymax, xmax]", "groq": "[x0, y0, x1, y1]"}


def box_order(model: str) -> str:
    return BOX_ORDERS.get(model.split(":", 1)[0], BOX_ORDERS["groq"])


def ask(
    prompt: str,
    path: str,
    *,
    bbox: tuple[float, float, float, float] | None = None,
    json_mode: bool = False,
    max_tokens: int = 400,
    max_wait_sec: float = 0,
) -> VisionReply | None:
    """The first provider's answer, or None when none could be reached.
    Never raises: a missing reading costs one image some recall, while a
    raised error would fail the whole document."""
    image = encode(path, bbox)
    name = Path(path).name

    for provider, model in _candidates():
        for attempt in range(_ATTEMPTS_PER_MODEL):
            try:
                framed = prompt.replace("{BOX_ORDER}", BOX_ORDERS[provider])
                # Groq's strict JSON mode rejects Qwen's replies outright
                # ("json_validate_failed"); the object is parsed out of plain
                # text instead, which every provider manages.
                text = (
                    _groq(framed, image, False, max_tokens)
                    if provider == "groq"
                    else _gemini(model, framed, image, json_mode, max_tokens)
                )
                text = _strip_reasoning(text)
                if text:
                    return VisionReply(text=text, model=f"{provider}:{model}")
                break
            except Exception as exc:  # noqa: BLE001 - every failure moves on
                message = str(exc)
                retryable = any(token in message for token in _RETRYABLE)
                logger.info(
                    "vision %s:%s attempt %d failed for %s: %s",
                    provider,
                    model,
                    attempt + 1,
                    name,
                    message[:200],
                )
                if not retryable:
                    break
                # A per-minute limit says when it resets. Waiting that out is
                # worth it at ingestion, where nobody is watching a spinner,
                # and not at question time, where the next provider is faster.
                hinted = re.search(r"try again in ([\d.]+)s", message)
                wait = float(hinted.group(1)) if hinted else random.uniform(0.2, 1.0)
                if wait > max(max_wait_sec, 1.0):
                    break
                time.sleep(wait)
    logger.warning("no vision provider could read %s", name)
    return None


def _strip_reasoning(text: str) -> str:
    """Reasoning models may prefix a <think> block; only the answer is kept."""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def parse_json(text: str) -> dict[str, object] | None:
    """The first JSON object in a reply, tolerating a ```json fence."""
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return None
    raw = match.group(0)
    for candidate in (raw, _repair(raw)):
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return value if isinstance(value, dict) else None
    return None


def _repair(raw: str) -> str:
    """The slips a model makes in long JSON that do not change its meaning:
    a doubled colon ("regions":: [), seen from Qwen on a real upload, and a
    trailing comma before a closing bracket."""
    fixed = re.sub(r'"\s*:\s*:', '":', raw)
    return re.sub(r",\s*([}\]])", r"\1", fixed)


STRUCTURE_PROMPT = """You are reading an image for a document search index.
Return one JSON object and nothing else, written compactly with no
indentation and each row on one line:

{"summary": "two sentences: what this image is and what it covers",
 "regions": [
  {"type": "chart | table | diagram | photo | form | handwriting | screenshot",
   "title": "the region's printed title, or null",
   "unit": "the unit of the values, e.g. USD Billion, or null",
   "description": "one or two sentences on what the region shows",
   "columns": ["for a chart: the x-axis label (e.g. year), then one name per series; for a table: the header cells"],
   "rows": [["one row per data point or table row, values exactly as printed"]],
   "estimated": false,
   "box_2d": {BOX_ORDER}}
 ]}

Rules:
- Include every chart, table, diagram, photo or illustration, form and piece of
  handwriting. Do not include ordinary paragraphs or headings as regions.
- Copy numbers and labels exactly as printed. Never round or reformat them.
- For a chart, read printed data labels. Only if the chart prints none, read
  the values off the axis and set "estimated": true.
- For a table, join a cell that wraps onto several lines into one string.
- For a photo, illustration or diagram, describe only what is visibly there.
- box_2d is the region's position, {BOX_ORDER}, with the whole image spanning
  0 to 1000 on both axes.
- Do not add anything that is not visible in the image."""

QUESTION_PROMPT = """Answer the question using only what is visible in this image.
Return one JSON object and nothing else:

{"found": true or false,
 "answer": "the answer in one or two sentences, with numbers exactly as printed",
 "evidence": "what in the image shows it, e.g. the bar labelled 2024 reads 28.9"}

If the image does not show the answer, return {"found": false, "answer": null,
"evidence": null}. Do not use outside knowledge and do not guess.

Question: """

CAPTION_PROMPT = (
    "Describe this image for a document search index. State what is shown, "
    "including any visible text, numbers, axis labels or captions, in at most "
    "three sentences. Do not speculate about anything not visible."
)


TRANSCRIBE_PROMPT = """Transcribe all the text in this image, in reading order:
top to bottom, and column by column where there are columns. Keep headings on
their own lines and keep each paragraph together. For a table, write one row
per line with cells separated by " | ". Output only the text, with no
commentary, and do not add anything that is not printed in the image."""


def transcribe_text(path: str) -> str:
    """The image's text, read by a vision model: lite mode's OCR. Empty when
    no provider could be reached."""
    reply = ask(TRANSCRIBE_PROMPT, path, max_tokens=1500, max_wait_sec=45)
    return reply.text.strip() if reply else ""
