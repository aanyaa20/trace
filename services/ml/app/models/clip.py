"""open_clip ViT-B/32 for image vectors and for the text side of image search,
so a text query and an image land in the same 512-dimensional space."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from ..config import settings
from ..registry import LazyModel, registry

if TYPE_CHECKING:
    import torch


@dataclass
class ClipBundle:
    model: object
    preprocess: object
    tokenizer: object


def _load() -> ClipBundle:
    import open_clip
    import torch

    model, _, preprocess = open_clip.create_model_and_transforms(
        settings.clip_model,
        pretrained=settings.clip_pretrained,
        device="cpu",
    )
    model.eval()
    torch.set_num_threads(max(1, torch.get_num_threads()))
    return ClipBundle(
        model=model,
        preprocess=preprocess,
        tokenizer=open_clip.get_tokenizer(settings.clip_model),
    )


clip_model: LazyModel[ClipBundle] = LazyModel("clip", _load)
registry.register(clip_model)  # type: ignore[arg-type]

# torch modules are not safe to call concurrently from several threads when
# they share one set of intra-op thread pools.
_inference_lock = threading.Lock()


def embed_images(paths: list[str]) -> list[list[float]]:
    import torch
    from PIL import Image

    bundle = clip_model.get()
    tensors = []
    for raw_path in paths:
        path = Path(raw_path)
        if not path.is_file():
            raise FileNotFoundError(f"image not found for clip embedding: {raw_path}")
        with Image.open(path) as image:
            tensors.append(bundle.preprocess(image.convert("RGB")))

    batch = torch.stack(tensors)
    with _inference_lock, torch.inference_mode():
        features = bundle.model.encode_image(batch)
        features = features / features.norm(dim=-1, keepdim=True)
    return features.cpu().tolist()


def embed_text(query: str) -> list[float]:
    import torch

    bundle = clip_model.get()
    tokens = bundle.tokenizer([query])
    with _inference_lock, torch.inference_mode():
        features = bundle.model.encode_text(tokens)
        features = features / features.norm(dim=-1, keepdim=True)
    return features[0].cpu().tolist()
