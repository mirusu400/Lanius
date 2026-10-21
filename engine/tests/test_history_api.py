"""Abandoned HTTP searches must stop their workers, including queued ones."""

import asyncio
import threading

import pytest
from fastapi import HTTPException

from app.api.history import history_page
from app.db.store import HistoryQueryCancelled


@pytest.mark.asyncio
@pytest.mark.parametrize("disconnect", [True, False])
async def test_history_worker_stops_on_disconnect_or_task_cancellation(disconnect):
    entered, stopped = threading.Event(), threading.Event()
    disconnected = False

    class Request:
        async def is_disconnected(self):
            return disconnected

    class Store:
        def page_summaries(self, *, cancel_event, search):
            assert search == "needle"
            entered.set()
            try:
                assert cancel_event.wait(timeout=3)
                raise HistoryQueryCancelled
            finally:
                stopped.set()

    task = asyncio.create_task(history_page(Request(), Store(), search="needle"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        if disconnect:
            disconnected = True
            with pytest.raises(HTTPException) as error:
                await asyncio.wait_for(task, timeout=1)
            assert error.value.status_code == 499
        else:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert await asyncio.to_thread(stopped.wait, 1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
