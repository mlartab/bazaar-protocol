"""Event bus: the single feed the live viewer reads (over SSE).

Thread-safe. Keeps full history so late joiners get a replay. Plain code.
"""
from __future__ import annotations

import threading
import time


class EventBus:
    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._events: list[dict] = []
        self._seq = 0

    def emit(self, kind: str, payload: dict) -> dict:
        with self._cond:
            self._seq += 1
            event = {"seq": self._seq, "ts": time.time(), "type": kind,
                     "payload": payload}
            self._events.append(event)
            self._cond.notify_all()
            return event

    def history(self, after_seq: int = 0) -> list[dict]:
        with self._cond:
            return [e for e in self._events if e["seq"] > after_seq]

    def wait_for(self, after_seq: int, timeout: float) -> list[dict]:
        """Block until events newer than after_seq exist, or timeout."""
        with self._cond:
            fresh = [e for e in self._events if e["seq"] > after_seq]
            if fresh:
                return fresh
            self._cond.wait(timeout=timeout)
            return [e for e in self._events if e["seq"] > after_seq]

    @property
    def count(self) -> int:
        with self._cond:
            return self._seq
