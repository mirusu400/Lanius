"""Plugin scanner checks, issue persistence, and bounded active scan jobs."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import time
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Literal
from urllib.parse import parse_qsl, quote, urlencode

from mitmproxy import http

from lanius_sdk import ActiveScanContext, InsertionPoint, ScanIssue

from ..db.store import FlowRecord, FlowStore
from ..events import EventBroker
from ..plugin_registry import Contribution, ContributionRegistry
from .capture import flow_to_record
from .repeater import RepeaterAddon, build_flow

MAX_ACTIVE_REQUESTS = 1_000
MAX_ACTIVE_CONCURRENCY = 10
MAX_REQUESTS_PER_SECOND = 50.0
MAX_EVIDENCE_BYTES = 256 * 1024
MAX_SCAN_BODY_BYTES = 1024 * 1024
MAX_PENDING_PASSIVE_SCANS = 1_000
PASSIVE_ENABLED_SETTING = "scanner.passive_enabled"

IssueStatus = Literal["open", "resolved", "false_positive"]


class ScannerError(ValueError):
    """Invalid scan configuration or unknown scan job."""


@dataclass(slots=True)
class ScanJob:
    id: str
    flow_id: str
    check_ids: list[str]
    concurrency: int
    requests_per_second: float
    total: int = 0
    completed: int = 0
    requests: int = 0
    issues: int = 0
    status: str = "pending"
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class _RateLimiter:
    def __init__(self, requests_per_second: float) -> None:
        self.interval = 1.0 / requests_per_second
        self._next = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if self._next > now:
                await asyncio.sleep(self._next - now)
                now = time.monotonic()
            self._next = max(now, self._next) + self.interval


def _url(record: FlowRecord) -> str:
    scheme = record.scheme or "http"
    host = record.host or ""
    port = record.port
    default_port = 443 if scheme == "https" else 80
    authority = host if port in (None, default_port) else f"{host}:{port}"
    path = record.path or "/"
    if record.query:
        path += f"?{record.query}"
    return f"{scheme}://{authority}{path}"


def _request_body(record: FlowRecord) -> str:
    detail = record.detail(auto_decompress=True)
    return str(detail.get("request_body") or "")


def request_snapshot(record: FlowRecord) -> dict[str, Any]:
    limited = replace(
        record,
        request_body=record.request_body[:MAX_SCAN_BODY_BYTES],
        response_body=(
            record.response_body[:MAX_SCAN_BODY_BYTES]
            if record.response_body is not None
            else None
        ),
    )
    detail = limited.detail(auto_decompress=True)
    return {
        "flow_id": record.id,
        "url": _url(record),
        "method": record.method or "GET",
        "scheme": record.scheme,
        "host": record.host,
        "port": record.port,
        "path": record.path,
        "query": record.query,
        "http_version": record.http_version,
        "request_headers": detail.get("request_headers") or [],
        "request_body": detail.get("request_body") or "",
        "status_code": record.status_code,
        "response_headers": detail.get("response_headers") or [],
        "response_body": detail.get("response_body") or "",
        "duration_ms": record.duration_ms,
        "error": record.error,
    }


def insertion_points(record: FlowRecord) -> list[InsertionPoint]:
    points: list[InsertionPoint] = []
    for index, (name, value) in enumerate(parse_qsl(record.query or "", keep_blank_values=True)):
        points.append(InsertionPoint(f"query:{index}", "query", name, value))
    for index, (name, value) in enumerate(record.request_headers):
        if name.lower() not in {"host", "content-length", "transfer-encoding"}:
            points.append(InsertionPoint(f"header:{index}", "header", name, value))
    segments = [segment for segment in (record.path or "/").split("/") if segment]
    for index, value in enumerate(segments):
        points.append(InsertionPoint(f"path:{index}", "path", str(index + 1), value))

    body = _request_body(record)
    content_type = next(
        (value for name, value in record.request_headers if name.lower() == "content-type"),
        "",
    ).lower()
    if "application/x-www-form-urlencoded" in content_type:
        for index, (name, value) in enumerate(parse_qsl(body, keep_blank_values=True)):
            points.append(InsertionPoint(f"form:{index}", "form", name, value))
    elif "json" in content_type:
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            for name, value in parsed.items():
                if isinstance(value, (str, int, float, bool)) or value is None:
                    points.append(
                        InsertionPoint(f"json:{name}", "json", str(name), str(value or ""))
                    )
    elif body:
        points.append(InsertionPoint("body:0", "body", "body", body))
    return points


def _mutated_request(
    record: FlowRecord, point: InsertionPoint, payload: str
) -> dict[str, Any]:
    path = record.path or "/"
    query = record.query or ""
    headers = [list(item) for item in record.request_headers]
    body = _request_body(record)
    kind, _, locator = point.id.partition(":")
    if kind == "query":
        pairs = parse_qsl(query, keep_blank_values=True)
        index = int(locator)
        pairs[index] = (pairs[index][0], payload)
        query = urlencode(pairs)
    elif kind == "header":
        headers[int(locator)][1] = payload
    elif kind == "path":
        segments = [segment for segment in path.split("/") if segment]
        segments[int(locator)] = quote(payload, safe="")
        path = "/" + "/".join(segments)
    elif kind == "form":
        pairs = parse_qsl(body, keep_blank_values=True)
        index = int(locator)
        pairs[index] = (pairs[index][0], payload)
        body = urlencode(pairs)
    elif kind == "json":
        parsed = json.loads(body)
        parsed[locator] = payload
        body = json.dumps(parsed, ensure_ascii=False)
    else:
        body = payload
    scheme = record.scheme or "http"
    host = record.host or ""
    port = record.port
    default_port = 443 if scheme == "https" else 80
    authority = host if port in (None, default_port) else f"{host}:{port}"
    url = f"{scheme}://{authority}{path}"
    if query:
        url += f"?{query}"
    return {
        "url": url,
        "method": record.method or "GET",
        "headers": headers,
        "body": body,
        "http_version": record.http_version or "HTTP/1.1",
    }


def _issues(value: Any) -> list[ScanIssue]:
    if value is None:
        return []
    if isinstance(value, ScanIssue):
        return [value]
    if isinstance(value, Mapping):
        return [ScanIssue(**dict(value))]
    if isinstance(value, (str, bytes)) or not isinstance(value, Iterable):
        raise ScannerError("scanner check must return ScanIssue values")
    result: list[ScanIssue] = []
    for item in value:
        if isinstance(item, ScanIssue):
            result.append(item)
        elif isinstance(item, Mapping):
            result.append(ScanIssue(**dict(item)))
        else:
            raise ScannerError("scanner check returned an invalid issue")
    return result


async def _invoke(handler: Any, value: Any) -> list[ScanIssue]:
    if inspect.iscoroutinefunction(handler):
        result = await handler(value)
    else:
        result = await asyncio.to_thread(handler, value)
        if inspect.isawaitable(result):
            result = await result
    return _issues(result)


class ScannerAddon:
    """Runs live passive checks and schedules explicitly requested active scans."""

    def __init__(
        self,
        registry: ContributionRegistry,
        store: FlowStore,
        broker: EventBroker,
        repeater: RepeaterAddon,
        scope: Any | None = None,
    ) -> None:
        self.registry = registry
        self.store = store
        self.broker = broker
        self.repeater = repeater
        self.scope = scope
        self.jobs: dict[str, ScanJob] = {}
        self._job_tasks: dict[str, asyncio.Task[None]] = {}
        self._pending: set[asyncio.Task[Any]] = set()

    @property
    def passive_enabled(self) -> bool:
        return self.store.get_setting(PASSIVE_ENABLED_SETTING, "1") != "0"

    def set_passive_enabled(self, enabled: bool) -> None:
        self.store.set_setting(PASSIVE_ENABLED_SETTING, "1" if enabled else "0")
        self.broker.publish("scanner.settings", {"passive_enabled": enabled})

    def response(self, flow: http.HTTPFlow) -> None:
        if not self.passive_enabled:
            return
        if not self.registry.scan_handlers("passive_scanners"):
            return
        record = flow_to_record(flow)
        if self.scope is not None and record.host and not self.scope.contains(
            record.scheme, record.host, record.port, record.path or "/"
        ):
            return
        if len(self._pending) >= MAX_PENDING_PASSIVE_SCANS:
            self.broker.publish(
                "scanner.dropped", {"flow_id": record.id, "reason": "queue full"}
            )
            return
        snapshot = request_snapshot(record)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self.scan_passive(snapshot))
            return
        task = loop.create_task(
            self.scan_passive(snapshot),
            name=f"passive-scan-{record.id}",
        )
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def done(self) -> None:
        for task in self._job_tasks.values():
            task.cancel()
        if self._job_tasks:
            await asyncio.gather(*self._job_tasks.values(), return_exceptions=True)
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)

    async def scan_passive(self, snapshot: Mapping[str, Any]) -> list[dict[str, Any]]:
        saved: list[dict[str, Any]] = []
        for contribution in self.registry.scan_handlers("passive_scanners"):
            try:
                for issue in await _invoke(contribution.handler, snapshot):
                    saved.append(
                        await self._report(contribution, "passive", issue, snapshot)
                    )
            except Exception as exc:
                self.broker.publish(
                    "scanner.check_error",
                    {"check_id": contribution.id, "error": str(exc)},
                )
        return saved

    async def _report(
        self,
        contribution: Contribution,
        mode: str,
        issue: ScanIssue,
        target: Mapping[str, Any],
    ) -> dict[str, Any]:
        if issue.severity not in {"info", "low", "medium", "high", "critical"}:
            raise ScannerError(f"invalid issue severity: {issue.severity}")
        if issue.confidence not in {"tentative", "firm", "certain"}:
            raise ScannerError(f"invalid issue confidence: {issue.confidence}")
        fingerprint_source = json.dumps(
            {
                "plugin": contribution.owner,
                "check": contribution.local_id,
                "custom": issue.fingerprint,
                "title": issue.title,
                "host": target.get("host"),
                "path": target.get("path"),
                "parameter": issue.parameter,
            },
            sort_keys=True,
        )
        fingerprint = hashlib.sha256(fingerprint_source.encode()).hexdigest()
        if not issue.title.strip() or not issue.detail.strip():
            raise ScannerError("issue title and detail must not be empty")
        evidence = dict(issue.evidence) if issue.evidence is not None else None
        if evidence is not None and len(
            json.dumps(evidence, ensure_ascii=False).encode()
        ) > MAX_EVIDENCE_BYTES:
            raise ScannerError("issue evidence exceeds 256 KiB")
        now = time.time()
        value = {
            "id": uuid.uuid4().hex,
            "fingerprint": fingerprint,
            "plugin_id": contribution.owner,
            "check_id": contribution.local_id,
            "scan_mode": mode,
            "title": issue.title,
            "severity": issue.severity,
            "confidence": issue.confidence,
            "status": "open",
            "detail": issue.detail,
            "remediation": issue.remediation,
            "url": target.get("url"),
            "host": target.get("host"),
            "path": target.get("path"),
            "parameter": issue.parameter,
            "flow_id": target.get("flow_id"),
            "evidence": evidence,
            "first_seen": now,
            "last_seen": now,
            "occurrences": 1,
        }
        saved = await asyncio.to_thread(self.store.upsert_issue, value)
        self.broker.publish("issues.changed", saved)
        return saved

    async def start_active(
        self,
        flow_id: str,
        *,
        check_ids: list[str] | None = None,
        concurrency: int = 3,
        requests_per_second: float = 5.0,
    ) -> ScanJob:
        if not 1 <= concurrency <= MAX_ACTIVE_CONCURRENCY:
            raise ScannerError(
                f"concurrency must be between 1 and {MAX_ACTIVE_CONCURRENCY}"
            )
        if not 0 < requests_per_second <= MAX_REQUESTS_PER_SECOND:
            raise ScannerError(
                f"requests_per_second must be between 0 and {MAX_REQUESTS_PER_SECOND}"
            )
        record = await asyncio.to_thread(self.store.get, flow_id)
        if record is None or record.type != "http":
            raise ScannerError(f"HTTP flow not found: {flow_id}")
        available = self.registry.scan_handlers("active_scanners")
        selected = (
            [item for item in available if item.id in set(check_ids)]
            if check_ids
            else available
        )
        if check_ids and len(selected) != len(set(check_ids)):
            raise ScannerError("one or more active scanner checks were not found")
        if not selected:
            raise ScannerError("no active scanner checks are enabled")
        points = insertion_points(record)
        if not points:
            raise ScannerError("request has no insertion points")
        job = ScanJob(
            id=uuid.uuid4().hex[:12],
            flow_id=flow_id,
            check_ids=[item.id for item in selected],
            concurrency=concurrency,
            requests_per_second=requests_per_second,
            total=len(selected) * len(points),
        )
        self.jobs[job.id] = job
        task = asyncio.create_task(
            self._run_active(job, record, selected, points),
            name=f"active-scan-{job.id}",
        )
        self._job_tasks[job.id] = task
        task.add_done_callback(lambda _task: self._job_tasks.pop(job.id, None))
        return job

    async def _run_active(
        self,
        job: ScanJob,
        record: FlowRecord,
        checks: list[Contribution],
        points: list[InsertionPoint],
    ) -> None:
        limiter = _RateLimiter(job.requests_per_second)
        request_semaphore = asyncio.Semaphore(job.concurrency)
        budget_lock = asyncio.Lock()
        snapshot = request_snapshot(record)

        async def send(point: InsertionPoint, payload: str) -> Mapping[str, Any]:
            async with budget_lock:
                if job.requests >= MAX_ACTIVE_REQUESTS:
                    raise ScannerError(
                        f"active scan request limit is {MAX_ACTIVE_REQUESTS}"
                    )
                job.requests += 1
            await limiter.wait()
            async with request_semaphore:
                request = _mutated_request(record, point, payload)
                flow = build_flow(**request, encode_content_body=self.repeater.auto_decompress)
                response = await self.repeater.send(flow)
                return request_snapshot(response)

        queue: asyncio.Queue[tuple[Contribution, InsertionPoint] | None] = (
            asyncio.Queue()
        )
        for check in checks:
            for point in points:
                queue.put_nowait((check, point))
        for _ in range(job.concurrency):
            queue.put_nowait(None)

        async def worker() -> None:
            while True:
                item = await queue.get()
                try:
                    if item is None:
                        return
                    check, point = item

                    async def send_point(
                        payload: str, current: InsertionPoint = point
                    ) -> Mapping[str, Any]:
                        return await send(current, payload)

                    context = ActiveScanContext(
                        snapshot,
                        point,
                        send_point,
                    )
                    try:
                        for issue in await _invoke(check.handler, context):
                            await self._report(check, "active", issue, snapshot)
                            job.issues += 1
                    except Exception as exc:
                        self.broker.publish(
                            "scanner.check_error",
                            {"job_id": job.id, "check_id": check.id, "error": str(exc)},
                        )
                    job.completed += 1
                    self.broker.publish("scanner.progress", job.as_dict())
                finally:
                    queue.task_done()

        workers = [asyncio.create_task(worker()) for _ in range(job.concurrency)]
        job.status = "running"
        self.broker.publish("scanner.started", job.as_dict())
        try:
            await asyncio.gather(*workers)
            job.status = "completed"
        except asyncio.CancelledError:
            job.status = "stopped"
            for worker_task in workers:
                worker_task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)
        finally:
            job.finished_at = time.time()
            self.broker.publish("scanner.finished", job.as_dict())

    def get_job(self, job_id: str) -> ScanJob:
        try:
            return self.jobs[job_id]
        except KeyError as exc:
            raise ScannerError(f"scan job not found: {job_id}") from exc

    def stop_job(self, job_id: str) -> ScanJob:
        job = self.get_job(job_id)
        task = self._job_tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()
        return job
