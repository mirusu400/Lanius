from __future__ import annotations

import asyncio

import pytest
from mitmproxy.test import tflow
from mitmproxy.websocket import WebSocketMessage

from app.addons.websocket_proxy import WebSocketProxyAddon, WebSocketProxyError
from app.events import EventBroker
from app.db.store import FlowStore


def websocket_flow():
    flow = tflow.twebsocketflow(messages=False)
    assert flow.websocket is not None
    return flow


@pytest.mark.asyncio
async def test_records_message_without_interception() -> None:
    addon = WebSocketProxyAddon(EventBroker())
    flow = websocket_flow()
    flow.websocket.messages.append(WebSocketMessage(1, True, b"hello"))
    await addon.websocket_message(flow)
    message = addon.state()["messages"][0]
    assert message["content"] == "hello"
    assert message["from_client"] is True
    assert message["paused"] is False


@pytest.mark.asyncio
async def test_intercept_edit_and_forward() -> None:
    addon = WebSocketProxyAddon(EventBroker())
    addon.set_rules(enabled=True)
    flow = websocket_flow()
    message = WebSocketMessage(1, True, b"before")
    flow.websocket.messages.append(message)
    task = asyncio.create_task(addon.websocket_message(flow))
    await asyncio.sleep(0)
    [message_id] = addon.paused
    addon.forward(message_id, "after")
    await asyncio.wait_for(task, 1)
    assert message.content == b"after"
    assert addon.paused == {}


@pytest.mark.asyncio
async def test_intercept_drop() -> None:
    addon = WebSocketProxyAddon(EventBroker())
    addon.set_rules(enabled=True)
    flow = websocket_flow()
    message = WebSocketMessage(1, False, b"drop me")
    flow.websocket.messages.append(message)
    task = asyncio.create_task(addon.websocket_message(flow))
    await asyncio.sleep(0)
    addon.drop(next(iter(addon.paused)))
    await task
    assert message.dropped is True


def test_repeat_injects_into_active_connection() -> None:
    calls = []

    class Commands:
        def call(self, *args):
            calls.append(args)

    class Master:
        commands = Commands()

    addon = WebSocketProxyAddon(EventBroker())
    addon.attach(Master())
    flow = websocket_flow()
    addon.websocket_start(flow)
    addon.repeat(flow.id, to_client=False, content="again")
    assert calls[0][0] == "inject.websocket"
    assert calls[0][2] is False
    assert calls[0][3] == b"again"


def test_repeat_closed_connection_is_rejected() -> None:
    addon = WebSocketProxyAddon(EventBroker())
    with pytest.raises(WebSocketProxyError):
        addon.repeat("missing", to_client=False, content="x")


@pytest.mark.asyncio
async def test_message_bytes_and_pages_survive_restart(tmp_path) -> None:
    path = tmp_path / "websocket.sqlite"
    store = FlowStore(path)
    addon = WebSocketProxyAddon(EventBroker(), store=store)
    flow = websocket_flow()
    raw = b"\xff\x00binary"
    flow.websocket.messages.append(WebSocketMessage(2, True, raw))
    await addon.websocket_message(flow)
    first = store.page_websocket_messages(limit=1)
    assert first["items"][0]["size"] == len(raw)
    assert store.get_websocket_message_bytes(first["items"][0]["id"]) == raw
    store.close()

    reopened = FlowStore(path)
    assert reopened.page_websocket_messages()["items"][0]["size"] == len(raw)
    assert reopened.get_websocket_message_bytes(first["items"][0]["id"]) == raw
    reopened.clear_websocket_messages()
    assert reopened.page_websocket_messages()["items"] == []
    reopened.close()


@pytest.mark.asyncio
async def test_live_mitmproxy_flow_is_bounded_after_persisting_frames(tmp_path) -> None:
    store = FlowStore(tmp_path / "bounded.sqlite")
    addon = WebSocketProxyAddon(EventBroker(), store=store, flow_history_limit=2)
    flow = websocket_flow()
    for i in range(5):
        flow.websocket.messages.append(WebSocketMessage(1, True, f"frame-{i}".encode()))
        await addon.websocket_message(flow)
    assert len(flow.websocket.messages) == 2
    assert len(addon.messages) == 0
    assert [item["content"] for item in store.page_websocket_messages()["items"]] == [
        f"frame-{i}" for i in range(4, -1, -1)
    ]
    store.close()


def test_websocket_history_pages_beyond_old_memory_limit(tmp_path) -> None:
    store = FlowStore(tmp_path / "many.sqlite")
    for i in range(2005):
        store.append_websocket_message({
            "id": str(i), "connection_id": "c", "host": "example.com", "path": "/ws",
            "from_client": True, "is_text": True, "timestamp": float(i),
            "injected": False, "dropped": False, "paused": False,
        }, f"message {i}".encode())
    before = None
    seen = []
    while True:
        page = store.page_websocket_messages(limit=200, before=before)
        seen.extend(item["id"] for item in page["items"])
        if not page["has_more"]:
            break
        before = page["next_before"]
    assert len(seen) == 2005
    assert seen[0] == "2004" and seen[-1] == "0"
    store.close()
