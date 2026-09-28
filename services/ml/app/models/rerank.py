"""Cross-encoder reranking.

The retriever scores a query and a passage independently — two vectors, one
dot product — which is fast enough to search the whole corpus but blind to how
the words of one relate to the other. A cross-encoder reads the pair together,
so it separates "the generator produces the answer" from a passage that merely
mentions generators. It is far too slow to run over the corpus and cheap over
twenty candidates, which is exactly where it sits.

It also replaces most of the LLM grading calls: those were what a free-tier
per-minute limit refused, and a refused grade is indistinguishable from "no
evidence" to the gate. This model runs locally and cannot be rate-limited."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from ..config import settings
from ..registry import LazyModel, registry

if TYPE_CHECKING:
    from fastembed.rerank.cross_encoder import TextCrossEncoder


def _load() -> "TextCrossEncoder":
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    return TextCrossEncoder(model_name=settings.rerank_model)


rerank_model: LazyModel["TextCrossEncoder"] = LazyModel("rerank", _load)
registry.register(rerank_model)  # type: ignore[arg-type]


def _sigmoid(logit: float) -> float:
    # MS MARCO cross-encoders emit an unbounded relevance logit. The sigmoid
    # maps it onto 0-1 without reordering anything, so a threshold can be
    # stated in the same units as every other score in the system.
    return 1.0 / (1.0 + math.exp(-logit))


def rerank(query: str, passages: list[str]) -> tuple[list[float], list[float]]:
    """Returns (logits, probabilities), aligned with the input passages."""
    prepared = [passage if passage.strip() else " " for passage in passages]
    logits = [float(score) for score in rerank_model.get().rerank(query, prepared)]
    return logits, [_sigmoid(logit) for logit in logits]
