from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from . import pool
from .config import settings
from .routers import embed, extract, health

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


app = FastAPI(
    title="trace ml",
    version="0.1.0",
    summary="Stateless extraction and embedding service. Holds no business logic and owns no database.",
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(extract.router)
app.include_router(embed.router)
