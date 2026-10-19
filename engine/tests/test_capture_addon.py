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


def test_flow_to_record_captures_connected_socket_source_only() -> None:
    flow = make_flow()
    assert flow_to_record(flow).local_source_ip is None
    flow.server_conn.sockname = ("192.0.2.12", 41321)
    assert flow_to_record(flow).local_source_ip == "192.0.2.12"


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
    response = flow.response
    flow.response = None
    addon.request(flow)
    flow.response = response
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
    assert first["data"]["request_number"] == second["data"]["request_number"] == 1
    assert addon.writer_status()["coalesced"] == 1
    assert addon.writer_status()["records_written"] == 1
    store.close()


@pytest.mark.asyncio
async def test_addon_batches_latest_snapshot_but_keeps_both_events(monkeypatch) -> None:
    store = FlowStore()
    broker = EventBroker()
    queue = broker.subscribe()
    batches: list[list[str]] = []
    upsert_many = store.upsert_prepared_many

    def track_batch(records):
        records = list(records)
        batches.append([record.id for record in records])
        return upsert_many(records)

    monkeypatch.setattr(store, "upsert_prepared_many", track_batch)
    addon = CaptureAddon(store, broker, batch_size=2, flush_seconds=0.1)
    first = make_flow("/first")
    second = make_flow("/second")
    first_response = first.response
    second_response = second.response
    first.response = None
    second.response = None

    addon.request(first)
    addon.request(second)
    first.response = first_response
    second.response = second_response
    addon.response(first)
    addon.response(second)
    await addon.done()

    assert batches == [[first.id, second.id]]
    assert [queue.get_nowait()["type"] for _ in range(4)] == [
        "flow.request",
        "flow.request",
        "flow.response",
        "flow.response",
    ]
    store.close()


@pytest.mark.asyncio
async def test_flush_is_durable_and_writer_restarts_after_done() -> None:
    store = FlowStore()
    addon = CaptureAddon(store, EventBroker(), flush_seconds=60)
    first = make_flow("/first")
    second = make_flow("/second")

    addon.response(first)
    await addon.flush()
    assert store.count() == 1
    assert addon.writer_status()["running"] is True

    await addon.done()
    assert addon.writer_status()["running"] is False
    addon.response(second)
    await addon.done()

    assert store.count() == 2
    assert addon.writer_status()["running"] is False
    store.close()


@pytest.mark.asyncio
async def test_clear_history_is_ordered_after_queued_captures() -> None:
    store = FlowStore()
    addon = CaptureAddon(store, EventBroker(), flush_seconds=60)

    addon.response(make_flow())
    await addon.clear_history()
    await addon.done()

    assert store.count() == 0
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


def test_proxied_traffic_is_recorded_as_proxied() -> None:
    assert flow_to_record(make_flow()).source == "proxy"


def test_a_replay_is_not_proxied_traffic() -> None:
    """Replay and Fuzzer replay through the same addons, so both write
    the same row. They disagreed about what it was, and whichever write
    landed last won: on a loaded machine an Fuzzer result could appear
    in the history as ordinary proxy traffic."""
    flow = make_flow()
    flow.is_replay = "request"
    assert flow_to_record(flow).source == "replay"
