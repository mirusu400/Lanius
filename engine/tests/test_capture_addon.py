from __future__ import annotations

import asyncio

import pytest
from mitmproxy.test import tflow, tutils

from app.addons.capture import CaptureAddon, flow_to_record
from app.db.store import FlowStore
from app.events import EventBroker


def make_flow(path: str = "/search?q=1", status: int = 200):
    flow = tflow.tflow(
        req=tutils.treq(path=path.encode(), method=b"GET", host="example.com"),
        resp=tutils.tresp(status_code=status, content=b"hello"),
    )
    return flow


def test_flow_to_record_maps_request_and_response() -> None:
    record = flow_to_record(make_flow())
    assert record.method == "GET"
    assert record.host == "example.com"
    assert record.path == "/search"
    assert record.query == "q=1"
    assert record.status_code == 200
    assert record.response_body == b"hello"
    assert record.request_size == len(record.request_body)
    assert record.type == "http"


def test_flow_to_record_without_query() -> None:
    record = flow_to_record(make_flow(path="/plain"))
    assert record.path == "/plain"
    assert record.query is None


def test_flow_to_record_duration_is_positive() -> None:
    record = flow_to_record(make_flow())
    assert record.duration_ms is not None
    assert record.duration_ms >= 0


@pytest.mark.asyncio
async def test_addon_persists_and_publishes() -> None:
    store = FlowStore()
    broker = EventBroker()
    queue = broker.subscribe()
    addon = CaptureAddon(store, broker)

    flow = make_flow()
    addon.request(flow)
    addon.response(flow)
    await addon.done()

    assert store.count() == 1
    saved = store.get(flow.id)
    assert saved is not None and saved.status_code == 200

    first = await asyncio.wait_for(queue.get(), 1)
    second = await asyncio.wait_for(queue.get(), 1)
    assert first["type"] == "flow.request"
    assert second["type"] == "flow.response"
    assert second["data"]["host"] == "example.com"
    store.close()


@pytest.mark.asyncio
async def test_addon_records_error() -> None:
    store = FlowStore()
    addon = CaptureAddon(store, EventBroker())
    flow = tflow.tflow(err=True)
    addon.error(flow)
    await addon.done()
    saved = store.get(flow.id)
    assert saved is not None and saved.error
    store.close()


def test_addon_persists_synchronously_without_loop() -> None:
    store = FlowStore()
    addon = CaptureAddon(store, EventBroker())
    flow = make_flow()
    addon.response(flow)
    assert store.count() == 1
    store.close()
