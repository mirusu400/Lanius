"""Replay: send a (possibly edited) request through the mitmproxy engine.

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

from ..http_protocol import REPLAY_MODE, HttpMode, project_mode, validate_mode
from .. import charset
from ..content_encoding import (
    auto_decompress_enabled,
    body_for_display,
    body_prefix_for_display,
    encode_content,
)
from ..db.store import FlowRecord, FlowStore

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0
LOCAL_CLIENT = ("127.0.0.1", 0)


class ReplayError(Exception):
    """Invalid replay request (mapped to HTTP 4xx)."""


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
    if http_version not in ("HTTP/1.0", "HTTP/1.1", "HTTP/2", "HTTP/2.0", "HTTP/3", "HTTP/3.0"):
        raise ReplayError(f"unsupported HTTP version: {http_version!r}")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ReplayError(f"invalid url: {url!r}")
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
            raise ReplayError(f"invalid header entry: {item!r}")

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
            raise ReplayError(f"invalid Content-Encoding: {exc}") from exc
    flow.request = http.Request.make(method.upper(), url, body_bytes)
    flow.request.path = path
    flow.request.http_version = {"HTTP/2": "HTTP/2.0", "HTTP/3.0": "HTTP/3"}.get(http_version, http_version)
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


class ReplayAddon:
    """Sends one-off requests and returns the resulting flow."""

    def __init__(self, store: FlowStore) -> None:
        self.store = store
        self.options: Options | None = None
        self._active: set[asyncio.Task[Any]] = set()
        self._policy_cancelled: dict[asyncio.Task[Any], str] = {}

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
        happened: the port was open and traffic flowed, but Replay kept
        reporting the engine as not running. The options are known when
        the master is built, so pass them in rather than waiting.
        """
        self.options = options

    async def send(
        self, flow: http.HTTPFlow, timeout: float = DEFAULT_TIMEOUT,
        http_mode: HttpMode | None = None,
    ) -> FlowRecord:
        if self.options is None:
            raise ReplayError("proxy engine is not running")

        try:
            mode = validate_mode(http_mode) if http_mode is not None else project_mode(self.store)
        except ValueError as exc:
            raise ReplayError(str(exc)) from exc
        flow.is_replay = "request"
        handler = ReplayHandler(flow, self.options)
        task = asyncio.current_task()
        if task is not None:
            self._active.add(task)
        started = time.time()
        token = REPLAY_MODE.set(mode)
        try:
            await asyncio.wait_for(handler.replay(), timeout=timeout)
        except TimeoutError as exc:
            raise ReplayError(f"request timed out after {timeout}s") from exc
        except asyncio.CancelledError:
            if task is not None and task in self._policy_cancelled:
                raise ReplayError(f"request cancelled by {self._policy_cancelled[task]}") from None
            raise
        finally:
            # ReplayHandler normally closes these after response/error. A
            # policy transition can cancel replay earlier, so clean up here as
            # well to ensure no standalone upstream connection survives.
            handlers = [
                item.handler
                for item in handler.transports.values()
                if item.handler is not None and not item.handler.done()
            ]
            for active in handlers:
                active.cancel("Lockdown scope guard changed")
            if handlers:
                await asyncio.gather(*handlers, return_exceptions=True)
            REPLAY_MODE.reset(token)
            if task is not None:
                self._active.discard(task)
                self._policy_cancelled.pop(task, None)

        record = _to_record(flow, started)
        await asyncio.to_thread(self.store.upsert, record)
        return record

    async def cancel_active(self, reason: str = "the Lockdown scope guard") -> None:
        """Cancel standalone Replay/Fuzzer connections during policy changes."""
        current = asyncio.current_task()
        tasks = [task for task in self._active if task is not current and not task.done()]
        self._policy_cancelled.update({task: reason for task in tasks})
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _to_record(flow: http.HTTPFlow, started: float) -> FlowRecord:
    from .capture import flow_to_record

    record = flow_to_record(flow)
    record.source = "replay"
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
    record: FlowRecord, *, auto_decompress: bool = True,
    body_limit: int | None = None,
) -> dict[str, Any]:
    """Response view for the Replay UI."""
    raw = record.response_body
    captured_size = len(raw or b"")
    content_type = _content_type(record.response_headers)
    enabled = auto_decompress and not record.response_body_omitted
    if body_limit is None:
        shown, body_encoding, decoded, decode_error = body_for_display(
            record.response_headers, raw, enabled=enabled,
        )
        truncated = False
    else:
        # Bound the decoded text before JSON serialization.  A compressed
        # body shows its first decoded bytes, as History does.
        shown, body_encoding, decoded, decode_error, truncated = (
            body_prefix_for_display(
                record.response_headers,
                None if raw is None else raw[:body_limit],
                enabled=enabled,
                limit=body_limit,
                input_complete=captured_size <= body_limit,
            )
        )
    if truncated and body_encoding and enabled and not decoded:
        # A cut window of compressed bytes that cannot be decoded is noise.
        shown = b""
    body_charset = (
        charset.charset_of_prefix(content_type, shown)
        if truncated
        else charset.charset_of(content_type, shown)
    )
    if truncated and shown:
        shown = charset.complete_characters(shown, body_charset)
    return {
        "id": record.id,
        "http_mode": record.http_mode,
        "upstream_http_version": record.upstream_http_version,
        "response_http_version": record.response_http_version,
        "status_code": record.status_code,
        "reason": record.reason,
        "headers": record.response_headers or [],
        "body": charset.decode(shown, body_charset),
        # What the bytes were read as, so the UI can say so and a reply can
        # be encoded the same way.
        "charset": body_charset,
        "content_encoding": body_encoding,
        "body_decoded": decoded,
        "decode_error": decode_error,
        "body_omitted": record.response_body_omitted,
        "body_captured_size": captured_size,
        "body_preview_size": len(shown or b""),
        "body_truncated": truncated,
        "size": record.response_size,
        "duration_ms": record.duration_ms,
        "error": record.error,
    }
