"""Dense and sparse text embeddings, both from fastembed so the two share one
ONNX runtime and one tokeniser cache."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..config import settings
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


def embed_dense(texts: list[str]) -> list[list[float]]:
    return [vector.tolist() for vector in dense_model.get().embed(texts)]


def embed_sparse(texts: list[str]) -> list[SparseVector]:
    return [
        SparseVector(indices=vector.indices.tolist(), values=vector.values.tolist())
        for vector in sparse_model.get().embed(texts)
    ]


def embed_dense_query(query: str) -> list[float]:
    # bge models are trained with an asymmetric objective: queries carry a
    # retrieval instruction prefix that documents must not have.
    return [vector.tolist() for vector in dense_model.get().query_embed([query])][0]


def embed_sparse_query(query: str) -> SparseVector:
    vector = next(iter(sparse_model.get().query_embed([query])))
    return SparseVector(indices=vector.indices.tolist(), values=vector.values.tolist())
