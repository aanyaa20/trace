from __future__ import annotations

import time

from fastapi import APIRouter

from ..registry import registry
from ..schemas import HealthResponse

router = APIRouter()
_started = time.monotonic()


@router.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    """Reports readiness without touching a model. Cold is a normal state on a
    fresh container and must not read as unhealthy; only a model that tried to
    load and failed degrades the service."""
    states = registry.states()
    errors = registry.errors()

    return HealthResponse(
        status="degraded" if errors else "ok",
        uptimeSec=time.monotonic() - _started,
        models=states,
        errors=errors,
    )
