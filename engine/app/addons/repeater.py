"""Repeater: send a (possibly edited) request through the mitmproxy engine.

Reuses mitmproxy's client-replay machinery (``ReplayHandler``) so TLS, HTTP/2,
upstream modes and all addon hooks behave exactly as for proxied traffic
(codex.md §9: never bypass the engine).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from urllib.parse import urlsplit

from mitmproxy import http
from mitmproxy.addons.clientplayback import ReplayHandler
from mitmproxy.connection import Client, Server
from mitmproxy.options import Options

from ..db.store import FlowRecord, FlowStore

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0
LOCAL_CLIENT = ("127.0.0.1", 0)


class RepeaterError(Exception):
    """Invalid repeater request (mapped to HTTP 4xx)."""


def build_flow(
    *,
    url: str,
    method: str = "GET",
    headers: list[list[str]] | None = None,
    body: str = "",
    http_version: str = "HTTP/1.1",
) -> http.HTTPFlow:
    """Construct a standalone flow ready for replay."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise RepeaterError(f"invalid url: {url!r}")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"

    client = Client(peername=LOCAL_CLIENT, sockname=LOCAL_CLIENT, timestamp_start=time.time())
    server = Server(address=(parts.hostname, port))
    flow = http.HTTPFlow(client, server)
    flow.request = http.Request.make(
        method.upper(),
        url,
        body.encode("utf-8"),
    )
    flow.request.path = path
    flow.request.http_version = http_version
    if headers:
        # The editor's headers are authoritative (an explicit Host must win
        # over the one derived from the URL).
        flow.request.headers.clear()
        for item in headers:
            if len(item) != 2:
                raise RepeaterError(f"invalid header entry: {item!r}")
            flow.request.headers.add(item[0], item[1])
    if not flow.request.headers.get("host"):
        flow.request.headers["host"] = parts.netloc or parts.hostname
    return flow


class RepeaterAddon:
    """Sends one-off requests and returns the resulting flow."""

    def __init__(self, store: FlowStore) -> None:
        self.store = store
        self.options: Options | None = None

    def running(self) -> None:  # mitmproxy hook
        from mitmproxy import ctx

        self.options = ctx.options

    async def send(
        self, flow: http.HTTPFlow, timeout: float = DEFAULT_TIMEOUT
    ) -> FlowRecord:
        if self.options is None:
            raise RepeaterError("proxy engine is not running")

        flow.is_replay = "request"
        handler = ReplayHandler(flow, self.options)
        started = time.time()
        try:
            await asyncio.wait_for(handler.replay(), timeout=timeout)
        except TimeoutError as exc:
            raise RepeaterError(f"request timed out after {timeout}s") from exc

        record = _to_record(flow, started)
        await asyncio.to_thread(self.store.upsert, record)
        return record


def _to_record(flow: http.HTTPFlow, started: float) -> FlowRecord:
    from .capture import flow_to_record

    record = flow_to_record(flow)
    record.source = "repeater"
    if record.started_at is None:
        record.started_at = started
    if record.duration_ms is None and record.completed_at:
        record.duration_ms = (record.completed_at - started) * 1000
    return record


def render_raw(record: FlowRecord) -> dict[str, Any]:
    """Response view for the Repeater UI."""
    return {
        "id": record.id,
        "status_code": record.status_code,
        "reason": record.reason,
        "headers": record.response_headers or [],
        "body": (record.response_body or b"").decode("utf-8", errors="replace"),
        "size": record.response_size,
        "duration_ms": record.duration_ms,
        "error": record.error,
    }
