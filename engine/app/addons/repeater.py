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

from .. import charset
from ..content_encoding import (
    auto_decompress_enabled,
    body_for_display,
    encode_content,
)
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
    encode_content_body: bool = True,
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
    # Validate before reading anything out of them, so a malformed entry
    # is reported as such rather than failing to unpack somewhere else.
    for item in headers or []:
        if len(item) != 2:
            raise RepeaterError(f"invalid header entry: {item!r}")

    # Encode with the charset this request declares, not always UTF-8:
    # sending UTF-8 bytes to an EUC-KR endpoint delivers mojibake.
    content_type = next(
        (value for name, value in (headers or []) if name.lower() == "content-type"),
        None,
    )
    body_encoding = next(
        (
            value
            for name, value in (headers or [])
            if name.lower() == "content-encoding"
        ),
        None,
    )
    if not encode_content_body and body_encoding:
        # With automatic decoding disabled the editor contains the original
        # compressed bytes mapped one-to-one through latin-1. Preserve those
        # bytes instead of UTF-8-encoding the display string.
        try:
            body_bytes = body.encode("latin-1")
        except UnicodeEncodeError:
            body_bytes = charset.encode(body, charset.charset_of(content_type, None))
    else:
        body_bytes = charset.encode(body, charset.charset_of(content_type, None))
    if encode_content_body and body_encoding:
        try:
            body_bytes = encode_content(body_bytes, body_encoding)
        except (TypeError, ValueError) as exc:
            raise RepeaterError(f"invalid Content-Encoding: {exc}") from exc
    flow.request = http.Request.make(method.upper(), url, body_bytes)
    flow.request.path = path
    flow.request.http_version = http_version
    if headers:
        # The editor's headers are authoritative (an explicit Host must win
        # over the one derived from the URL).
        flow.request.headers.clear()
        for item in headers:
            flow.request.headers.add(item[0], item[1])
    if not flow.request.headers.get("host"):
        flow.request.headers["host"] = parts.netloc or parts.hostname

    # Clearing the headers above drops the Content-Length that Request.make
    # set, so a body was written but never announced and the server read
    # none of it. Re-derive it from the bytes actually being sent, which is
    # also what keeps it right after the body was edited or re-encoded.
    raw = flow.request.raw_content or b""
    if raw:
        flow.request.headers["content-length"] = str(len(raw))
    elif "content-length" in flow.request.headers:
        flow.request.headers["content-length"] = "0"
    return flow


class RepeaterAddon:
    """Sends one-off requests and returns the resulting flow."""

    def __init__(self, store: FlowStore) -> None:
        self.store = store
        self.options: Options | None = None

    @property
    def auto_decompress(self) -> bool:
        return auto_decompress_enabled(self.store)

    def running(self) -> None:  # mitmproxy hook
        from mitmproxy import ctx

        self.options = ctx.options

    def attach(self, options: Options) -> None:
        """Hand over the options without waiting for the hook.

        mitmproxy only runs ``running`` once the whole addon chain has
        started, and with a local-capture mode configured that never
        happened: the port was open and traffic flowed, but Repeater kept
        reporting the engine as not running. The options are known when
        the master is built, so pass them in rather than waiting.
        """
        self.options = options

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


def _content_type(headers: list[tuple[str, str]] | None) -> str | None:
    for name, value in headers or []:
        if name.lower() == "content-type":
            return value
    return None


def render_raw(
    record: FlowRecord, *, auto_decompress: bool = True
) -> dict[str, Any]:
    """Response view for the Repeater UI."""
    shown, body_encoding, decoded, decode_error = body_for_display(
        record.response_headers,
        record.response_body,
        enabled=auto_decompress,
    )
    return {
        "id": record.id,
        "status_code": record.status_code,
        "reason": record.reason,
        "headers": record.response_headers or [],
        "body": charset.decode_body(
            _content_type(record.response_headers), shown
        ),
        # What the bytes were read as, so the UI can say so and a reply can
        # be encoded the same way.
        "charset": charset.charset_of(
            _content_type(record.response_headers), shown
        ),
        "content_encoding": body_encoding,
        "body_decoded": decoded,
        "decode_error": decode_error,
        "size": record.response_size,
        "duration_ms": record.duration_ms,
        "error": record.error,
    }
