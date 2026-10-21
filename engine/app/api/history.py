"""Tie a history database query's lifetime to its HTTP client."""

from __future__ import annotations

import asyncio
import threading
from typing import Any

from fastapi import HTTPException, Request

from ..db.store import FlowStore, HistoryQueryCancelled


async def history_page(request: Request, store: FlowStore, **kwargs: Any) -> dict[str, Any]:
    cancelled = threading.Event()

    async def watch_disconnect() -> None:
        while not cancelled.is_set():
            if await request.is_disconnected():
                cancelled.set()
                return
            await asyncio.sleep(0.05)

    watcher = asyncio.create_task(watch_disconnect())
    try:
        return await asyncio.to_thread(store.page_summaries, cancel_event=cancelled, **kwargs)
    except HistoryQueryCancelled as exc:
        raise HTTPException(status_code=499, detail="History query cancelled") from exc
    finally:
        # Cancelling to_thread's await alone does not stop its SQLite worker.
        cancelled.set()
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
