"""Lazy, thread-safe model handles.

Loading every model at import would cost roughly 2 GB of RAM and a minute of
startup for a container that may only ever be asked to embed text. Each handle
loads on first use, stays warm for the process lifetime, and reports its state
so /healthz can tell cold from broken."""

from __future__ import annotations

import logging
import threading
from typing import Callable, Generic, TypeVar

from .schemas import ModelState

logger = logging.getLogger("trace.ml.registry")

T = TypeVar("T")


class LazyModel(Generic[T]):
    def __init__(self, name: str, loader: Callable[[], T]) -> None:
        self._name = name
        self._loader = loader
        self._value: T | None = None
        self._state: ModelState = "cold"
        self._error: str = ""
        self._lock = threading.Lock()

    @property
    def name(self) -> str:
        return self._name

    @property
    def state(self) -> ModelState:
        return self._state

    @property
    def error(self) -> str:
        return self._error

    def get(self) -> T:
        if self._value is not None:
            return self._value

        # Held across the load so two concurrent first-requests do not each
        # pay for a copy of the weights.
        with self._lock:
            if self._value is not None:
                return self._value

            self._state = "loading"
            logger.info("loading model %s", self._name)
            try:
                value = self._loader()
            except Exception as exc:
                self._state = "error"
                self._error = f"{type(exc).__name__}: {exc}"
                logger.exception("model %s failed to load", self._name)
                raise RuntimeError(f"model {self._name} failed to load: {exc}") from exc

            self._value = value
            self._state = "loaded"
            self._error = ""
            logger.info("model %s ready", self._name)
            return value


class ModelRegistry:
    def __init__(self) -> None:
        self._models: dict[str, LazyModel[object]] = {}

    def register(self, model: LazyModel[object]) -> None:
        self._models[model.name] = model

    def states(self) -> dict[str, ModelState]:
        return {name: model.state for name, model in self._models.items()}

    def errors(self) -> dict[str, str]:
        return {name: model.error for name, model in self._models.items() if model.error}


registry = ModelRegistry()
