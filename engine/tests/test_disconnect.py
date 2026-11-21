"""Replay stops waiting on the target once the UI cancels its request."""

import asyncio

import pytest
from fastapi import HTTPException

from app.api.disconnect import until_disconnected


class Request:
    def __init__(self):
        self.disconnected = False

    async def is_disconnected(self):
        return self.disconnected


@pytest.mark.asyncio
async def test_work_is_cancelled_when_the_client_disconnects():
    request = Request()
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def slow_upstream():
        started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    task = asyncio.create_task(until_disconnected(request, slow_upstream()))
    await asyncio.wait_for(started.wait(), 1)
    request.disconnected = True
    with pytest.raises(HTTPException) as error:
        await asyncio.wait_for(task, 1)
    assert error.value.status_code == 499
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_result_and_errors_pass_through():
    async def answer():
        return 42

    async def fail():
        raise ValueError("bad request")

    assert await until_disconnected(Request(), answer()) == 42
    with pytest.raises(ValueError, match="bad request"):
        await until_disconnected(Request(), fail())


@pytest.mark.asyncio
async def test_work_is_cancelled_with_the_handler():
    cancelled = asyncio.Event()

    async def slow_upstream():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    task = asyncio.create_task(until_disconnected(Request(), slow_upstream()))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()
