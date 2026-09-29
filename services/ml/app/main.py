from __future__ import annotations

import logging
import ctypes
import ctypes.util
import gc
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from . import pool
from .config import settings
from .routers import embed, extract, health, vision

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("trace.ml")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    logger.info(
        "ml service ready; models load on first use (upload_dir=%s, workers=%d)",
        settings.upload_dir,
        settings.threadpool_workers,
    )
    yield
    pool.shutdown()


try:
    _libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
    if not hasattr(_libc, "malloc_trim"):  # not glibc (macOS, musl)
        _libc = None
except OSError:
    _libc = None

app = FastAPI(
    title="trace ml",
    version="0.1.0",
    summary="Stateless extraction and embedding service. Holds no business logic and owns no database.",
    lifespan=lifespan,
)

@app.middleware("http")
async def release_memory(request, call_next):  # type: ignore[no-untyped-def]
    """Hands freed memory back to the system after each request.

    glibc keeps what Python frees for reuse, so an extraction that rendered a
    33-page PDF leaves the process at its peak size for good. On a 512 MB
    instance those peaks stacked across a batch of uploads until the kernel
    killed the container. malloc_trim returns the free pages."""
    response = await call_next(request)
    if request.url.path.startswith(("/extract", "/embed", "/vision")):
        # MuPDF keeps decoded pages and images in its own store, up to 256 MB
        # by default and invisible to Python's collector. Emptied after each
        # request, and capped for the rest (see below).
        pymupdf = sys.modules.get("pymupdf") or sys.modules.get("fitz")
        if pymupdf is not None:
            pymupdf.TOOLS.store_shrink(100)
        gc.collect()
        if _libc is not None:
            _libc.malloc_trim(0)
    return response


app.include_router(health.router)
app.include_router(extract.router)
app.include_router(embed.router)
app.include_router(vision.router)
