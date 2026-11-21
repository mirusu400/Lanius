"""Stop work for a request whose HTTP client has gone away."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any, TypeVar

from fastapi import HTTPException, Request

T = TypeVar("T")

POLL_SECONDS = 0.1


async def until_disconnected(request: Request, work: Coroutine[Any, Any, T]) -> T:
    """Await ``work``, cancelling it if the client closes the connection.

    Replay can wait on a slow upstream for its whole timeout. When the user
    cancels in the UI the fetch is aborted, and the upstream connection
    should close too rather than run on unseen.
    """
    task = asyncio.ensure_future(work)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=POLL_SECONDS)
            if done:
                return task.result()
            if await request.is_disconnected():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise HTTPException(status_code=499, detail="Request cancelled by the client")
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
