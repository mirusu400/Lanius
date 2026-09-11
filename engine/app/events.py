"""In-process event broker: addon hooks -> asyncio queues -> WebSocket clients."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_QUEUE_SIZE = 1000


class EventBroker:
    """Fan-out broker with bounded per-subscriber queues.

    ``publish`` is non-blocking and safe to call from the mitmproxy event loop.
    Slow subscribers drop their oldest event instead of stalling the engine.
    """

    def __init__(
        self,
        queue_size: int = DEFAULT_QUEUE_SIZE,
        on_publish: Any | None = None,
    ) -> None:
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self.dropped = 0
        # Optional sink used to persist notable events for the Logger tab.
        self.on_publish = on_publish

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def publish(self, event_type: str, data: Any) -> None:
        event = {"type": event_type, "data": data}
        if self.on_publish is not None:
            try:
                self.on_publish(event_type, data)
            except Exception:  # pragma: no cover - logging must never break
                logger.exception("event sink failed for %s", event_type)
        for queue in list(self._subscribers):
            while True:
                try:
                    queue.put_nowait(event)
                    break
                except asyncio.QueueFull:
                    self.dropped += 1
                    with contextlib.suppress(asyncio.QueueEmpty):
                        queue.get_nowait()

    @contextlib.asynccontextmanager
    async def stream(self) -> AsyncIterator[asyncio.Queue[dict[str, Any]]]:
        queue = self.subscribe()
        try:
            yield queue
        finally:
            self.unsubscribe(queue)
