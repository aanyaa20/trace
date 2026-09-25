"""Every model call is blocking C or Rust that holds the GIL for seconds at a
time. Running it on the event loop would stall unrelated requests, including
the healthcheck, so all of it is dispatched here."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, ParamSpec, TypeVar

from .config import settings

P = ParamSpec("P")
R = TypeVar("R")

# Deliberately small: each worker can hold a whisper decode or an OCR page
# render in memory, and this service is expected to share a laptop.
_executor = ThreadPoolExecutor(
    max_workers=settings.threadpool_workers,
    thread_name_prefix="ml-worker",
)


async def run_blocking(fn: Callable[P, R], *args: P.args, **kwargs: P.kwargs) -> R:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, lambda: fn(*args, **kwargs))


def shutdown() -> None:
    _executor.shutdown(wait=True, cancel_futures=True)
