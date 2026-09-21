"""WebSocket history, interception, editing, dropping, and injection."""

from __future__ import annotations

import asyncio
import base64
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from typing import Any

from mitmproxy import http

from ..events import EventBroker


class WebSocketProxyError(ValueError):
    """The requested WebSocket action is no longer possible."""


@dataclass(slots=True)
class WebSocketInterceptRules:
    enabled: bool = False
    client_messages: bool = True
    server_messages: bool = True

    def as_dict(self) -> dict[str, bool]:
        return asdict(self)


@dataclass(slots=True)
class HeldMessage:
    flow: http.HTTPFlow
    message: Any
    future: asyncio.Future[None]


class WebSocketProxyAddon:
    """Owns the live WebSocket workflow exposed to the UI."""

    def __init__(self, broker: EventBroker, history_limit: int = 2000) -> None:
        self.broker = broker
        self.rules = WebSocketInterceptRules()
        self.active: dict[str, http.HTTPFlow] = {}
        self.messages: deque[dict[str, Any]] = deque(maxlen=history_limit)
        self.paused: dict[str, HeldMessage] = {}
        self.master: Any | None = None

    def attach(self, master: Any) -> None:
        self.master = master

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        self.active[flow.id] = flow
        self.broker.publish("websocket.started", self._connection(flow))

    async def websocket_message(self, flow: http.HTTPFlow) -> None:
        if flow.websocket is None or not flow.websocket.messages:
            return
        message = flow.websocket.messages[-1]
        message_id = str(uuid.uuid4())
        should_hold = (
            self.rules.enabled
            and not message.injected
            and (
                (message.from_client and self.rules.client_messages)
                or (not message.from_client and self.rules.server_messages)
            )
        )
        item = self._message(flow, message_id, message, paused=should_hold)
        self.messages.append(item)
        self.broker.publish(
            "websocket.intercepted" if should_hold else "websocket.message", item
        )
        if not should_hold:
            return

        future = asyncio.get_running_loop().create_future()
        self.paused[message_id] = HeldMessage(flow, message, future)
        try:
            await future
        finally:
            self.paused.pop(message_id, None)

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self.active.pop(flow.id, None)
        self._release_flow(flow.id, drop=True)
        data = self._connection(flow)
        data["active"] = False
        self.broker.publish("websocket.ended", data)

    def websocket_error(self, flow: http.HTTPFlow) -> None:
        self.websocket_end(flow)

    def state(self) -> dict[str, Any]:
        return {
            "rules": self.rules.as_dict(),
            "connections": [self._connection(flow) for flow in self.active.values()],
            "messages": list(self.messages),
            "paused": list(self.paused),
        }

    def set_rules(self, **changes: Any) -> dict[str, bool]:
        for key, value in changes.items():
            if value is not None and hasattr(self.rules, key):
                setattr(self.rules, key, bool(value))
        if not self.rules.enabled:
            self.resume_all()
        state = self.rules.as_dict()
        self.broker.publish("websocket.rules", state)
        return state

    def forward(self, message_id: str, content: str, encoding: str = "utf-8") -> None:
        held = self._held(message_id)
        held.message.content = _content_bytes(content, encoding)
        self._resolve(message_id, "forward")

    def drop(self, message_id: str) -> None:
        held = self._held(message_id)
        held.message.drop()
        self._resolve(message_id, "drop")

    def resume_all(self) -> int:
        count = len(self.paused)
        for message_id in list(self.paused):
            self._resolve(message_id, "forward")
        return count

    def repeat(
        self,
        flow_id: str,
        *,
        to_client: bool,
        content: str,
        encoding: str = "utf-8",
        is_text: bool = True,
    ) -> None:
        flow = self.active.get(flow_id)
        if flow is None or flow.websocket is None:
            raise WebSocketProxyError("WebSocket connection is no longer active")
        if self.master is None:
            raise WebSocketProxyError("proxy engine is not running")
        self.master.commands.call(
            "inject.websocket",
            flow,
            to_client,
            _content_bytes(content, encoding),
            is_text,
        )

    def clear(self) -> None:
        self.messages.clear()
        self.broker.publish("websocket.cleared", {})

    def _held(self, message_id: str) -> HeldMessage:
        held = self.paused.get(message_id)
        if held is None:
            raise WebSocketProxyError(f"WebSocket message {message_id} is not paused")
        return held

    def _resolve(self, message_id: str, action: str) -> None:
        held = self._held(message_id)
        for item in reversed(self.messages):
            if item["id"] == message_id:
                item["paused"] = False
                item["dropped"] = action == "drop"
                item.update(_encoded(held.message.content, held.message.is_text))
                break
        if not held.future.done():
            held.future.set_result(None)
        self.broker.publish(
            "websocket.resolved", {"id": message_id, "action": action}
        )

    def _release_flow(self, flow_id: str, *, drop: bool) -> None:
        for message_id, held in list(self.paused.items()):
            if held.flow.id != flow_id:
                continue
            if drop:
                held.message.drop()
            if not held.future.done():
                held.future.set_result(None)

    @staticmethod
    def _connection(flow: http.HTTPFlow) -> dict[str, Any]:
        request = flow.request
        return {
            "id": flow.id,
            "host": request.pretty_host,
            "path": request.path,
            "url": request.pretty_url,
            "active": flow.websocket is not None
            and flow.websocket.timestamp_end is None,
            "started_at": request.timestamp_start,
        }

    @staticmethod
    def _message(
        flow: http.HTTPFlow, message_id: str, message: Any, *, paused: bool
    ) -> dict[str, Any]:
        return {
            "id": message_id,
            "connection_id": flow.id,
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "from_client": bool(message.from_client),
            "is_text": bool(message.is_text),
            "timestamp": message.timestamp or time.time(),
            "size": len(message.content),
            "injected": bool(message.injected),
            "dropped": bool(message.dropped),
            "paused": paused,
            **_encoded(message.content, message.is_text),
        }


def _encoded(content: bytes, is_text: bool) -> dict[str, str]:
    if is_text:
        return {"content": content.decode("utf-8", errors="replace"), "encoding": "utf-8"}
    return {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"}


def _content_bytes(content: str, encoding: str) -> bytes:
    if encoding == "base64":
        try:
            return base64.b64decode(content, validate=True)
        except ValueError as exc:
            raise WebSocketProxyError("binary content is not valid base64") from exc
    return content.encode("utf-8")


__all__ = [
    "WebSocketInterceptRules",
    "WebSocketProxyAddon",
    "WebSocketProxyError",
]
