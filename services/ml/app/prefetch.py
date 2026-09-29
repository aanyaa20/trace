"""Downloads every model's weights into the image at build time.

On a host whose disk is rebuilt from the image at each restart (a Hugging
Face Space), weights fetched on first use would be fetched again after every
restart, and the first question after one would wait minutes. Loading each
model once here bakes the files into the image instead.

    python -m app.prefetch
"""

from __future__ import annotations

from .models.clip import clip_model
from .models.ocr import ocr_model
from .models.rerank import rerank_model
from .models.text import dense_model, sparse_model
from .models.whisper import whisper_model

for model in (dense_model, sparse_model, rerank_model, ocr_model, clip_model, whisper_model):
    print(f"prefetching {model._name}", flush=True)  # noqa: SLF001 - build-time script
    model.get()
print("all model weights present", flush=True)
