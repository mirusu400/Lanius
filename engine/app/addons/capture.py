"""Capture addon: mitmproxy flows -> SQLite + event broker.

Registered on the embedded ``DumpMaster``. DB writes are offloaded to a worker
thread so the mitmproxy event loop is never blocked (see codex.md §5, §9).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from mitmproxy import http

from ..db.store import FlowRecord, FlowStore
from ..events import EventBroker

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


class CaptureAddon:
    """Persists every HTTP flow and broadcasts live events."""

    def __init__(self, store: FlowStore, broker: EventBroker) -> None:
        self.store = store
        self.broker = broker
        self._pending: set[asyncio.Task[None]] = set()

    # --- mitmproxy hooks --------------------------------------------------
    def request(self, flow: http.HTTPFlow) -> None:
        self._save(flow, "flow.request")

    def response(self, flow: http.HTTPFlow) -> None:
        self._save(flow, "flow.response")

    def error(self, flow: http.HTTPFlow) -> None:
        self._save(flow, "flow.error")

    async def done(self) -> None:
        if self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)

    # --- internals --------------------------------------------------------
    def _save(self, flow: http.HTTPFlow, event_type: str) -> None:
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
        task = loop.create_task(self._persist(record))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def _persist(self, record: FlowRecord) -> None:
        try:
            await asyncio.to_thread(self.store.upsert, record)
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to persist flow %s", record.id)
