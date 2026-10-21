"""Capture addon: mitmproxy flows -> SQLite + event broker.

Registered on the embedded ``DumpMaster``. DB writes are coalesced and committed
in bounded batches on one worker thread.  When that bounded queue is full the
capture hook applies backpressure instead of silently dropping traffic.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from mitmproxy import http
from mitmproxy import tcp

from ..db.store import FlowRecord, FlowStore, RequestSnapshot
from ..events import EventBroker
from ..http_protocol import MODE_KEY, WIRE_KEY
from ..request_history import AUTO_MODIFIED, ORIGINAL, request_changed, snapshot

logger = logging.getLogger(__name__)

# A raw TCP record holds the whole stream so far, so writing it on every
# message costs time quadratic in the message count. While a stream is open,
# write it at most this often; start, end and error are still written at once.
TCP_MESSAGE_FLUSH_SECONDS = 1.0

# SQLite's fixed transaction and trigger cost dominates small captures.  Keep
# latency low for interactive use while allowing busy proxies to amortise it.
CAPTURE_BATCH_SIZE = 100
CAPTURE_FLUSH_SECONDS = 0.02
CAPTURE_QUEUE_SIZE = 512


@dataclass(slots=True)
class _PersistItem:
    loop: asyncio.AbstractEventLoop
    record: FlowRecord
    event_type: str


@dataclass(slots=True)
class _FlushBarrier:
    done: threading.Event
    action: Callable[[], None] | None = None
    error: BaseException | None = None


@dataclass(slots=True)
class _StopWriter:
    done: threading.Event


_WriterItem = _PersistItem | _FlushBarrier | _StopWriter


class _CaptureWriter:
    """One bounded, restartable SQLite writer for capture hooks."""

    def __init__(
        self,
        store: FlowStore,
        broker: EventBroker,
        *,
        batch_size: int,
        flush_seconds: float,
        queue_size: int,
    ) -> None:
        self.store = store
        self.broker = broker
        self.batch_size = max(1, batch_size)
        self.flush_seconds = max(0.0, flush_seconds)
        self.queue_size = max(1, queue_size)
        self._queue: queue.Queue[_WriterItem] = queue.Queue(self.queue_size)
        self._lifecycle_lock = threading.Lock()
        self._stats_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._enqueued = 0
        self._batches = 0
        self._records_written = 0
        self._coalesced = 0
        self._backpressure_count = 0
        self._backpressure_ms = 0.0
        self._high_watermark = 0
        self._write_failures = 0
        self._last_batch_size = 0
        self._last_db_ms = 0.0
        self._last_error: str | None = None

    def offer(
        self,
        loop: asyncio.AbstractEventLoop,
        record: FlowRecord,
        event_type: str,
    ) -> None:
        item = _PersistItem(loop, record, event_type)
        with self._lifecycle_lock:
            self._ensure_started_locked()
            started = time.perf_counter() if self._queue.full() else None
            self._queue.put(item)
            depth = self._queue.qsize()
        with self._stats_lock:
            self._enqueued += 1
            self._high_watermark = max(self._high_watermark, depth)
            if started is not None:
                self._backpressure_count += 1
                self._backpressure_ms = round(
                    self._backpressure_ms + (time.perf_counter() - started) * 1000,
                    3,
                )

    def flush(self) -> None:
        """Wait until everything accepted before this call is durable."""
        self.run_after_flush()

    def run_after_flush(self, action: Callable[[], None] | None = None) -> None:
        """Run an action after every write accepted before this call.

        Only the enqueue holds the lifecycle lock.  Capture hooks take that
        lock on the proxy event loop, so waiting under it would freeze the
        proxy and API for as long as the action (e.g. Clear History) runs.
        Captures offered meanwhile queue behind the barrier.
        """
        with self._lifecycle_lock:
            thread = self._thread
            running = thread is not None and thread.is_alive()
            barrier = _FlushBarrier(threading.Event(), action)
            if running:
                self._queue.put(barrier)
        if not running:
            if action is not None:
                action()
            return
        barrier.done.wait()
        if barrier.error is not None:
            raise barrier.error

    def stop(self) -> None:
        """Drain and stop; a later capture automatically starts a new writer."""
        with self._lifecycle_lock:
            thread = self._thread
            if thread is None or not thread.is_alive():
                self._thread = None
                return
            stop = _StopWriter(threading.Event())
            self._queue.put(stop)
            stop.done.wait()
            thread.join()
            self._thread = None

    def status(self) -> dict[str, int | float | str | bool | None]:
        # Lock-free: the lifecycle lock can be held while offer() waits for
        # queue space, and /api/status must stay responsive then.
        thread = self._thread
        running = thread is not None and thread.is_alive()
        depth = self._queue.qsize()
        with self._stats_lock:
            return {
                "enqueued": self._enqueued,
                "batches": self._batches,
                "records_written": self._records_written,
                "coalesced": self._coalesced,
                "backpressure_count": self._backpressure_count,
                "backpressure_ms": self._backpressure_ms,
                "high_watermark": self._high_watermark,
                "write_failures": self._write_failures,
                "last_batch_size": self._last_batch_size,
                "last_db_ms": self._last_db_ms,
                "last_error": self._last_error,
                "queue_depth": depth,
                "queue_capacity": self.queue_size,
                "running": running,
                "dropped": 0,
            }

    def _ensure_started_locked(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run,
            name="lanius-capture-writer",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        while True:
            first = self._queue.get()
            if isinstance(first, _PersistItem):
                batch = [first]
                control: _FlushBarrier | _StopWriter | None = None
                deadline = time.monotonic() + self.flush_seconds
                while True:
                    # A full batch of request-only snapshots is likely to be
                    # followed immediately by responses for the same flows.
                    # Use the remainder of the latency window to coalesce
                    # them, but commit as soon as the target-sized working set
                    # has terminal snapshots for every flow.
                    if (
                        len(batch) >= self.batch_size
                        and self._batch_is_complete(batch)
                    ):
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        candidate = self._queue.get(timeout=remaining)
                    except queue.Empty:
                        break
                    if isinstance(candidate, _PersistItem):
                        batch.append(candidate)
                    else:
                        control = candidate
                        break
                try:
                    self._write_batch(batch)
                finally:
                    for _ in batch:
                        self._queue.task_done()
                if control is not None:
                    if self._finish_control(control):
                        return
                continue

            if self._finish_control(first):
                return

    @staticmethod
    def _batch_is_complete(items: list[_PersistItem]) -> bool:
        latest: dict[str, str] = {}
        for item in items:
            latest[item.record.id] = item.event_type
        return all(
            event_type in {"flow.response", "flow.error", "tcp.end", "tcp.error"}
            for event_type in latest.values()
        )

    def _finish_control(self, control: _FlushBarrier | _StopWriter) -> bool:
        should_stop = isinstance(control, _StopWriter)
        if isinstance(control, _FlushBarrier) and control.action is not None:
            try:
                control.action()
            except BaseException as exc:  # returned to the waiting API task
                control.error = exc
        self._queue.task_done()
        control.done.set()
        return should_stop

    def _write_batch(self, items: list[_PersistItem]) -> None:
        # Dict assignment retains the first insertion position.  The latest
        # snapshot wins, but new-flow request numbers retain arrival order.
        latest: dict[str, FlowRecord] = {}
        for item in items:
            latest[item.record.id] = item.record

        started = time.perf_counter()
        successful: dict[str, int] = {}
        last_error: str | None = None
        try:
            request_numbers = self.store.upsert_prepared_many(list(latest.values()))
            successful.update(zip(latest, request_numbers, strict=True))
        except Exception as exc:  # isolate one malformed record from the batch
            last_error = str(exc)
            logger.exception("failed to persist capture batch; retrying individually")
            for flow_id, record in latest.items():
                try:
                    successful[flow_id] = self.store.upsert_prepared_many((record,))[0]
                except Exception as item_exc:  # pragma: no cover - defensive
                    last_error = str(item_exc)
                    logger.exception("failed to persist flow %s", flow_id)

        for item in items:
            request_number = successful.get(item.record.id)
            if request_number is None:
                continue
            item.record.request_number = request_number
            try:
                item.loop.call_soon_threadsafe(
                    self.broker.publish, item.event_type, item.record.summary()
                )
            except Exception:  # pragma: no cover - publishing must not kill writer
                logger.exception("failed to publish capture event %s", item.event_type)

        elapsed_ms = (time.perf_counter() - started) * 1000
        with self._stats_lock:
            self._batches += 1
            self._records_written += len(successful)
            self._coalesced += len(items) - len(latest)
            self._write_failures += len(latest) - len(successful)
            self._last_batch_size = len(latest)
            self._last_db_ms = round(elapsed_ms, 3)
            self._last_error = last_error


def _addr(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, (tuple, list)) and len(value) >= 2:
        return f"{value[0]}:{value[1]}"
    return str(value)


def _socket_ip(value: Any) -> str | None:
    if isinstance(value, (tuple, list)) and value:
        try:
            return str(ipaddress.ip_address(value[0]))
        except (ValueError, TypeError):
            return None
    return None


def flow_to_record(flow: http.HTTPFlow) -> FlowRecord:
    """Convert a mitmproxy HTTP flow into a persistable record."""
    req = flow.request
    record = FlowRecord(
        id=flow.id,
        type="http",
        client_addr=_addr(getattr(flow.client_conn, "peername", None)),
        server_addr=_addr(getattr(flow.server_conn, "peername", None)),
        local_source_ip=_socket_ip(getattr(flow.server_conn, "sockname", None)),
        scheme=req.scheme,
        method=req.method,
        host=req.pretty_host,
        port=req.port,
        path=req.path.split("?", 1)[0],
        query=req.path.split("?", 1)[1] if "?" in req.path else None,
        http_version=req.http_version,
        http_mode=flow.metadata.get(MODE_KEY),
        upstream_http_version=flow.metadata.get(WIRE_KEY),
        response_http_version=flow.response.http_version if flow.response else None,
        request_headers=[(k, v) for k, v in req.headers.items(multi=True)],
        request_body=req.raw_content or b"",
        request_size=len(req.raw_content or b""),
        started_at=req.timestamp_start,
        # A replayed request is Replay's or Fuzzer's, not traffic that
        # arrived through the proxy. mitmproxy runs a replay through the
        # addons as well, so both halves write the same row: whichever
        # landed last decided what the row said it was, and on a loaded
        # machine that was the wrong one. Both now say the same thing.
        source="replay" if flow.is_replay == "request" else "proxy",
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
        local_source_ip=_socket_ip(getattr(flow.server_conn, "sockname", None)),
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
        *,
        batch_size: int = CAPTURE_BATCH_SIZE,
        flush_seconds: float = CAPTURE_FLUSH_SECONDS,
        queue_size: int = CAPTURE_QUEUE_SIZE,
    ) -> None:
        self.store = store
        self.broker = broker
        self.scope = scope
        self._writer = _CaptureWriter(
            store,
            broker,
            batch_size=batch_size,
            flush_seconds=flush_seconds,
            queue_size=queue_size,
        )
        self._tcp_flushes: dict[str, tuple[asyncio.TimerHandle, tcp.TCPFlow]] = {}

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
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._save_tcp(flow, "tcp.message")
            return
        if flow.id in self._tcp_flushes:
            return
        handle = loop.call_later(TCP_MESSAGE_FLUSH_SECONDS, self._flush_tcp, flow)
        self._tcp_flushes[flow.id] = (handle, flow)

    def tcp_end(self, flow: tcp.TCPFlow) -> None:
        self._cancel_tcp_flush(flow)
        self._save_tcp(flow, "tcp.end")

    def tcp_error(self, flow: tcp.TCPFlow) -> None:
        self._cancel_tcp_flush(flow)
        self._save_tcp(flow, "tcp.error")

    def _flush_tcp(self, flow: tcp.TCPFlow) -> None:
        self._tcp_flushes.pop(flow.id, None)
        self._save_tcp(flow, "tcp.message")

    def _cancel_tcp_flush(self, flow: tcp.TCPFlow) -> None:
        if (pending := self._tcp_flushes.pop(flow.id, None)) is not None:
            pending[0].cancel()

    async def done(self) -> None:
        # Write what open streams hold before shutdown.
        for handle, flow in list(self._tcp_flushes.values()):
            handle.cancel()
            self._flush_tcp(flow)
        await asyncio.to_thread(self._writer.stop)

    async def flush(self) -> None:
        """Make all captures accepted so far durable without stopping."""
        await asyncio.to_thread(self._writer.flush)

    async def clear_history(self) -> None:
        """Delete durable and queued captures as one writer barrier."""
        await asyncio.to_thread(self._writer.run_after_flush, self.store.clear)

    def writer_status(self) -> dict[str, int | float | str | bool | None]:
        return self._writer.status()

    # --- internals --------------------------------------------------------
    def _save(self, flow: http.HTTPFlow, event_type: str) -> None:
        if not self.in_scope(flow):
            return
        try:
            record = self.store.prepare_capture_record(flow_to_record(flow))
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to convert flow %s", flow.id)
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            try:
                self.store.upsert(record)
                self.broker.publish(event_type, record.summary())
            except Exception:  # pragma: no cover - defensive
                logger.exception("failed to persist flow %s", record.id)
            return
        self._writer.offer(loop, record, event_type)

    def _save_tcp(self, flow: tcp.TCPFlow, event_type: str) -> None:
        try:
            record = self.store.prepare_capture_record(tcp_flow_to_record(flow))
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to convert tcp flow %s", flow.id)
            return
        if self.scope is not None and not self.scope.should_capture(
            "tcp", record.host, record.port, "/"
        ):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            try:
                self.store.upsert(record)
                self.broker.publish(event_type, record.summary())
            except Exception:  # pragma: no cover - defensive
                logger.exception("failed to persist flow %s", record.id)
            return
        self._writer.offer(loop, record, event_type)
