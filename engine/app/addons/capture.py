"""Capture addon: mitmproxy flows -> SQLite + event broker.

Registered on the embedded ``DumpMaster``. DB writes are offloaded to a worker
thread so the mitmproxy event loop is never blocked (see codex.md §5, §9).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from mitmproxy import http
from mitmproxy import tcp

from ..db.store import FlowRecord, FlowStore, RequestSnapshot
from ..events import EventBroker
from ..request_history import AUTO_MODIFIED, ORIGINAL, request_changed, snapshot

logger = logging.getLogger(__name__)


def _addr(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, (tuple, list)) and len(value) >= 2:
        return f"{value[0]}:{value[1]}"
    return str(value)


def flow_to_record(flow: http.HTTPFlow) -> FlowRecord:
    """Convert a mitmproxy HTTP flow into a persistable record."""
    req = flow.request
    record = FlowRecord(
        id=flow.id,
        type="http",
        client_addr=_addr(getattr(flow.client_conn, "peername", None)),
        server_addr=_addr(getattr(flow.server_conn, "peername", None)),
        scheme=req.scheme,
        method=req.method,
        host=req.pretty_host,
        port=req.port,
        path=req.path.split("?", 1)[0],
        query=req.path.split("?", 1)[1] if "?" in req.path else None,
        http_version=req.http_version,
        request_headers=[(k, v) for k, v in req.headers.items(multi=True)],
        request_body=req.raw_content or b"",
        request_size=len(req.raw_content or b""),
        started_at=req.timestamp_start,
        source="proxy",
        comment=flow.comment or None,
    )
    original_data = flow.metadata.get(ORIGINAL)
    automatic_data = flow.metadata.get(AUTO_MODIFIED)
    final_data = snapshot(req)
    if isinstance(original_data, dict):
        if not isinstance(automatic_data, dict):
            automatic_data = original_data
        auto_changed = request_changed(original_data, automatic_data)
        later_changed = request_changed(automatic_data, final_data)
        if auto_changed or later_changed:
            record.request_original = RequestSnapshot.from_mapping(original_data)
            record.request_auto_modified = RequestSnapshot.from_mapping(
                automatic_data
            )
            record.auto_modified = auto_changed
            record.modified = True
    resp = flow.response
    if resp is not None:
        body = resp.raw_content or b""
        record.status_code = resp.status_code
        record.reason = resp.reason
        record.response_headers = [(k, v) for k, v in resp.headers.items(multi=True)]
        record.response_body = body
        record.response_size = len(body)
        record.response_mime = resp.headers.get("content-type")
        record.completed_at = resp.timestamp_end
        if req.timestamp_start and resp.timestamp_end:
            record.duration_ms = (resp.timestamp_end - req.timestamp_start) * 1000
    if flow.error is not None:
        record.error = flow.error.msg
    return record


def tcp_flow_to_record(flow: tcp.TCPFlow) -> FlowRecord:
    """Convert a raw TCP flow into a persistable record.

    Non-HTTP traffic is represented at the byte level only (codex.md §5):
    client->server bytes land in the request body, server->client in the
    response body.
    """
    address = getattr(flow.server_conn, "address", None) or ("", 0)
    host = str(address[0]) if address else ""
    port = int(address[1]) if address and len(address) > 1 else None

    to_server = b"".join(m.content for m in flow.messages if m.from_client)
    to_client = b"".join(m.content for m in flow.messages if not m.from_client)
    timestamps = [m.timestamp for m in flow.messages]

    record = FlowRecord(
        id=flow.id,
        type="tcp",
        client_addr=_addr(getattr(flow.client_conn, "peername", None)),
        server_addr=_addr(getattr(flow.server_conn, "peername", None)),
        scheme="tcp",
        method="TCP",
        host=host,
        port=port,
        path=f"tcp://{host}:{port}",
        request_headers=[],
        request_body=to_server,
        request_size=len(to_server),
        response_body=to_client,
        response_size=len(to_client),
        started_at=getattr(flow.client_conn, "timestamp_start", None)
        or (min(timestamps) if timestamps else None),
        completed_at=max(timestamps) if timestamps else None,
        source="proxy",
        comment=f"{len(flow.messages)} messages",
    )
    if record.started_at and record.completed_at:
        record.duration_ms = (record.completed_at - record.started_at) * 1000
    if flow.error is not None:
        record.error = flow.error.msg
    return record


class CaptureAddon:
    """Persists HTTP flows and broadcasts live events.

    When a scope manager is attached and scope capture restriction is on,
    out-of-scope flows are neither stored nor broadcast (codex.md §2: scope
    limits capture/display/tooling).
    """

    def __init__(
        self,
        store: FlowStore,
        broker: EventBroker,
        scope: Any | None = None,
    ) -> None:
        self.store = store
        self.broker = broker
        self.scope = scope
        self._pending: set[asyncio.Task[None]] = set()
        self._last_write: dict[str, asyncio.Task[None]] = {}

    def in_scope(self, flow: http.HTTPFlow) -> bool:
        if self.scope is None:
            return True
        req = flow.request
        return bool(
            self.scope.should_capture(
                req.scheme, req.pretty_host, req.port, req.path.split("?", 1)[0]
            )
        )

    # --- mitmproxy hooks --------------------------------------------------
    def request(self, flow: http.HTTPFlow) -> None:
        self._save(flow, "flow.request")

    def request_updated(self, flow: http.HTTPFlow) -> None:
        """Persist an Intercept edit; mitmproxy does not repeat request()."""
        self._save(flow, "flow.request")

    def response(self, flow: http.HTTPFlow) -> None:
        self._save(flow, "flow.response")

    def error(self, flow: http.HTTPFlow) -> None:
        self._save(flow, "flow.error")

    # --- raw TCP (M6) -----------------------------------------------------
    # mitmproxy relays traffic it cannot parse as a raw TCP layer (still doing
    # TLS interception). We surface those bytes; structure is a plugin concern.
    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        self._save_tcp(flow, "tcp.start")

    def tcp_message(self, flow: tcp.TCPFlow) -> None:
        self._save_tcp(flow, "tcp.message")

    def tcp_end(self, flow: tcp.TCPFlow) -> None:
        self._save_tcp(flow, "tcp.end")

    def tcp_error(self, flow: tcp.TCPFlow) -> None:
        self._save_tcp(flow, "tcp.error")

    async def done(self) -> None:
        if self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)

    # --- internals --------------------------------------------------------
    def _save(self, flow: http.HTTPFlow, event_type: str) -> None:
        if not self.in_scope(flow):
            return
        try:
            record = flow_to_record(flow)
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to convert flow %s", flow.id)
            return
        self.broker.publish(event_type, record.summary())
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self.store.upsert(record)
            return
        self._queue_persist(loop, record)

    def _save_tcp(self, flow: tcp.TCPFlow, event_type: str) -> None:
        try:
            record = tcp_flow_to_record(flow)
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to convert tcp flow %s", flow.id)
            return
        if self.scope is not None and not self.scope.should_capture(
            "tcp", record.host, record.port, "/"
        ):
            return
        self.broker.publish(event_type, record.summary())
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self.store.upsert(record)
            return
        self._queue_persist(loop, record)

    def _queue_persist(
        self, loop: asyncio.AbstractEventLoop, record: FlowRecord
    ) -> None:
        """Keep writes for one flow ordered while allowing different flows in parallel."""
        previous = self._last_write.get(record.id)
        task = loop.create_task(self._persist_after(record, previous))
        self._last_write[record.id] = task
        self._pending.add(task)

        def finished(done: asyncio.Task[None]) -> None:
            self._pending.discard(done)
            if self._last_write.get(record.id) is done:
                self._last_write.pop(record.id, None)

        task.add_done_callback(finished)

    async def _persist_after(
        self, record: FlowRecord, previous: asyncio.Task[None] | None
    ) -> None:
        if previous is not None:
            await previous
        await self._persist(record)

    async def _persist(self, record: FlowRecord) -> None:
        try:
            await asyncio.to_thread(self.store.upsert, record)
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to persist flow %s", record.id)
