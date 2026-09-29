"""Dense and sparse text embeddings, both from fastembed so the two share one
ONNX runtime and one tokeniser cache."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..config import LITE, settings
from . import bm25
from ..registry import LazyModel, registry
from ..schemas import SparseVector

if TYPE_CHECKING:
    from fastembed import SparseTextEmbedding, TextEmbedding


def _load_dense() -> "TextEmbedding":
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=settings.text_embedding_model)


def _load_sparse() -> "SparseTextEmbedding":
    from fastembed import SparseTextEmbedding

    return SparseTextEmbedding(model_name=settings.sparse_embedding_model)


dense_model: LazyModel["TextEmbedding"] = LazyModel("text_dense", _load_dense)
sparse_model: LazyModel["SparseTextEmbedding"] = LazyModel("text_sparse", _load_sparse)

registry.register(dense_model)  # type: ignore[arg-type]
registry.register(sparse_model)  # type: ignore[arg-type]


# Gemini accepts up to 100 texts in one batch request.
_GEMINI_BATCH = 100


def _gemini_embed(texts: list[str], task: str) -> list[list[float]]:
    """Lite mode's dense vectors. The task type is the asymmetric part a local
    bge model gets from its query prefix: documents and queries are embedded
    for retrieval from opposite sides."""
    import random
    import time

    import httpx

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{settings.gemini_embedding_model}:batchEmbedContents"
    )
    vectors: list[list[float]] = []
    for start in range(0, len(texts), _GEMINI_BATCH):
        batch = texts[start : start + _GEMINI_BATCH]
        body = {
            "requests": [
                {
                    "model": f"models/{settings.gemini_embedding_model}",
                    "content": {"parts": [{"text": text[:8000] or " "}]},
                    "taskType": task,
                    "outputDimensionality": settings.embedding_dim,
                }
                for text in batch
            ]
        }
        for attempt in range(6):
            response = httpx.post(
                url, params={"key": settings.gemini_api_key}, json=body, timeout=60
            )
            if response.status_code == 200:
                vectors.extend(item["values"] for item in response.json()["embeddings"])
                break
            if response.status_code in (429, 500, 502, 503, 504) and attempt < 5:
                # A per-minute quota: waiting it out is the only way through.
                time.sleep(min(30.0, 2.0 * 2**attempt) + random.uniform(0, 1))
                continue
            raise RuntimeError(f"gemini embeddings failed: {response.status_code} {response.text[:300]}")
    return vectors


def embed_dense(texts: list[str]) -> list[list[float]]:
    if LITE:
        return _gemini_embed(texts, "RETRIEVAL_DOCUMENT")
    return [vector.tolist() for vector in dense_model.get().embed(texts)]


def embed_sparse(texts: list[str]) -> list[SparseVector]:
    if LITE:
        return [bm25.embed_document(text) for text in texts]
    return [
        SparseVector(indices=vector.indices.tolist(), values=vector.values.tolist())
        for vector in sparse_model.get().embed(texts)
    ]


def embed_dense_query(query: str) -> list[float]:
    if LITE:
        return _gemini_embed([query], "RETRIEVAL_QUERY")[0]
    # bge models are trained with an asymmetric objective: queries carry a
    # retrieval instruction prefix that documents must not have.
    return [vector.tolist() for vector in dense_model.get().query_embed([query])][0]


def embed_sparse_query(query: str) -> SparseVector:
    if LITE:
        return bm25.embed_query(query)
    vector = next(iter(sparse_model.get().query_embed([query])))
    return SparseVector(indices=vector.indices.tolist(), values=vector.values.tolist())
