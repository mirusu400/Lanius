from __future__ import annotations

import asyncio

import pytest

from app.events import EventBroker


@pytest.mark.asyncio
async def test_publish_fans_out_to_all_subscribers() -> None:
    broker = EventBroker()
    a, b = broker.subscribe(), broker.subscribe()
    broker.publish("flow.request", {"id": "1"})
    assert (await a.get())["data"]["id"] == "1"
    assert (await b.get())["data"]["id"] == "1"


@pytest.mark.asyncio
async def test_unsubscribe_stops_delivery() -> None:
    broker = EventBroker()
    q = broker.subscribe()
    broker.unsubscribe(q)
    broker.publish("x", {})
    assert q.empty()
    assert broker.subscriber_count == 0


@pytest.mark.asyncio
async def test_slow_subscriber_drops_oldest_instead_of_blocking() -> None:
    broker = EventBroker(queue_size=2)
    q = broker.subscribe()
    for i in range(5):
        broker.publish("e", {"i": i})
    assert q.qsize() == 2
    assert (await q.get())["data"]["i"] == 3
    assert (await q.get())["data"]["i"] == 4
    assert broker.dropped == 3


@pytest.mark.asyncio
async def test_stream_context_manager_cleans_up() -> None:
    broker = EventBroker()
    async with broker.stream() as q:
        broker.publish("e", {})
        assert await asyncio.wait_for(q.get(), 1)
        assert broker.subscriber_count == 1
    assert broker.subscriber_count == 0
