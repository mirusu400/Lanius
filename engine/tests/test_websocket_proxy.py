from __future__ import annotations

import asyncio

import pytest
from mitmproxy.test import tflow
from mitmproxy.websocket import WebSocketMessage

from app.addons.websocket_proxy import WebSocketProxyAddon, WebSocketProxyError
from app.events import EventBroker


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
