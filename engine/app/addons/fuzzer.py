"""Fuzzer: payload positions + wordlist fuzzing.

Fuzz runs use Replay's engine-backed send path, and request
generation is offloaded to a worker thread so the mitmproxy event loop keeps
serving traffic (codex.md §5, §9).
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterator, Literal, Sequence

logger = logging.getLogger(__name__)

OPEN_MARKER = "{{"
CLOSE_MARKER = "}}"
RunMode = Literal["single_position", "shared_payload", "lockstep", "cartesian"]
RUN_MODES: tuple[RunMode, ...] = (
    "single_position",
    "shared_payload",
    "lockstep",
    "cartesian",
)

MAX_REQUESTS = 100_000

# Enough to saturate most targets without being a denial of service by
# accident. Above this the bottleneck is the target, not Lanius.
MAX_CONCURRENCY = 64
DEFAULT_CONCURRENCY = 5
# A minute between requests is slow enough for the most delicate target
# worth testing; beyond that a run is better paused.
MAX_DELAY = 60.0


class FuzzerError(Exception):
    """Invalid run configuration (mapped to HTTP 4xx)."""


@dataclass(slots=True)
class Position:
    """A payload position: the span between two markers."""

    start: int
    end: int
    value: str


def find_positions(
    template: str,
    open_marker: str = OPEN_MARKER,
    close_marker: str = CLOSE_MARKER,
) -> list[Position]:
    """Locate ``{{payload}}`` spans in a request template."""
    positions: list[Position] = []
    index = 0
    while True:
        start = template.find(open_marker, index)
        stray_close = template.find(close_marker, index)
        if start == -1:
            if stray_close != -1:
                raise FuzzerError("unbalanced payload marker")
            break
        if stray_close != -1 and stray_close < start:
            raise FuzzerError("unbalanced payload marker")
        value_start = start + len(open_marker)
        end = template.find(close_marker, value_start)
        if end == -1:
            raise FuzzerError("unbalanced payload marker")
        nested = template.find(open_marker, value_start, end)
        if nested != -1:
            raise FuzzerError("nested payload markers are not supported")
        positions.append(
            Position(
                start=start,
                end=end + len(close_marker),
                value=template[value_start:end],
            )
        )
        index = end + len(close_marker)
    return positions


def strip_markers(template: str) -> str:
    """The request as it would be sent with no payloads applied."""
    positions = find_positions(template)
    out: list[str] = []
    cursor = 0
    for position in positions:
        out.append(template[cursor : position.start])
        out.append(position.value)
        cursor = position.end
    out.append(template[cursor:])
    return "".join(out)


def apply_payloads(
    template: str, payloads: Sequence[str | None]
) -> str:
    """Substitute payloads into positions; ``None`` keeps the base value."""
    positions = find_positions(template)
    if len(payloads) != len(positions):
        raise FuzzerError(
            f"expected {len(positions)} payloads, got {len(payloads)}"
        )
    out: list[str] = []
    cursor = 0
    for position, payload in zip(positions, payloads):
        out.append(template[cursor : position.start])
        out.append(position.value if payload is None else payload)
        cursor = position.end
    out.append(template[cursor:])
    return "".join(out)


def count_requests(
    mode: RunMode, position_count: int, payload_sets: Sequence[Sequence[str]]
) -> int:
    """How many requests a run will generate."""
    if position_count == 0:
        raise FuzzerError("no payload positions marked")
    if not payload_sets or not any(payload_sets):
        raise FuzzerError("no payloads provided")

    if mode == "single_position":
        return position_count * len(payload_sets[0])
    if mode == "shared_payload":
        return len(payload_sets[0])
    if mode == "lockstep":
        sets = payload_sets[:position_count]
        if len(sets) < position_count:
            raise FuzzerError(
                f"lockstep needs {position_count} payload sets, got {len(sets)}"
            )
        return min(len(s) for s in sets)
    # Cartesian product.
    sets = payload_sets[:position_count]
    if len(sets) < position_count:
        raise FuzzerError(
            f"cartesian mode needs {position_count} payload sets, got {len(sets)}"
        )
    total = 1
    for payload_set in sets:
        total *= len(payload_set)
    return total


def generate_payload_tuples(
    mode: RunMode,
    position_count: int,
    payload_sets: Sequence[Sequence[str]],
) -> Iterator[tuple[list[str | None], list[str]]]:
    """Yield ``(payloads_per_position, labels)`` for every request."""
    if mode == "single_position":
        # One position at a time; the rest keep their base value.
        for index in range(position_count):
            for payload in payload_sets[0]:
                slots: list[str | None] = [None] * position_count
                slots[index] = payload
                yield slots, [payload]
    elif mode == "shared_payload":
        for payload in payload_sets[0]:
            yield [payload] * position_count, [payload]
    elif mode == "lockstep":
        sets = [list(s) for s in payload_sets[:position_count]]
        for combo in zip(*sets):
            yield list(combo), list(combo)
    else:  # cartesian
        sets = [list(s) for s in payload_sets[:position_count]]
        for combo in itertools.product(*sets):
            yield list(combo), list(combo)


@dataclass(slots=True)
class RunResult:
    """One request/response pair from a run."""

    index: int
    payloads: list[str]
    status_code: int | None = None
    length: int = 0
    duration_ms: float | None = None
    error: str | None = None
    flow_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "payloads": self.payloads,
            "status_code": self.status_code,
            "length": self.length,
            "duration_ms": self.duration_ms,
            "error": self.error,
            "flow_id": self.flow_id,
        }


@dataclass(slots=True)
class RunSpeed:
    """How hard to push the target.

    Defaults are deliberately gentle: a run that knocks a service
    over tells you nothing, and the person running it usually has
    permission for the traffic rather than for the outage.
    """

    #: Requests in flight at once.
    concurrency: int = DEFAULT_CONCURRENCY
    #: Seconds to wait before each request leaves, per worker. A whole
    #: second here with one worker is one request per second.
    delay: float = 0.0

    def __post_init__(self) -> None:
        if not 1 <= self.concurrency <= MAX_CONCURRENCY:
            raise FuzzerError(
                f"concurrency must be between 1 and {MAX_CONCURRENCY}"
            )
        if not 0 <= self.delay <= MAX_DELAY:
            raise FuzzerError(f"delay must be between 0 and {MAX_DELAY} seconds")

    def as_dict(self) -> dict[str, Any]:
        return {"concurrency": self.concurrency, "delay": self.delay}


@dataclass(slots=True)
class FuzzRun:
    """A running or finished run."""

    id: str
    mode: RunMode
    url: str
    template: str
    total: int
    payload_sets: list[list[str]] = field(default_factory=list)
    speed: RunSpeed = field(default_factory=lambda: RunSpeed())
    results: list[RunResult] = field(default_factory=list)
    completed_count: int = 0
    status: str = "pending"
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None

    @property
    def completed(self) -> int:
        return self.completed_count

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "mode": self.mode,
            "url": self.url,
            "status": self.status,
            "total": self.total,
            "completed": self.completed,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "speed": self.speed.as_dict(),
        }

    def as_dict(self) -> dict[str, Any]:
        return {
            **self.summary(),
            "template": self.template,
            "payload_sets": self.payload_sets,
            "results": [r.as_dict() for r in self.results],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FuzzRun":
        return cls(
            id=data["id"], mode=data["mode"], url=data["url"],
            template=data["template"], total=data["total"],
            payload_sets=data["payload_sets"], speed=RunSpeed(**data["speed"]),
            results=[RunResult(**item) for item in data.get("results", [])],
            completed_count=data.get("completed", len(data.get("results", []))),
            status=data["status"], started_at=data["started_at"],
            finished_at=data["finished_at"], error=data["error"],
        )


def parse_request_template(url: str, text: str) -> dict[str, Any]:
    """Parse raw HTTP text (markers already substituted) into a send payload."""
    normalized = text.replace("\r\n", "\n")
    separator = normalized.find("\n\n")
    head = (normalized if separator == -1 else normalized[:separator]).split("\n")
    head = [line for line in head if line]
    body = "" if separator == -1 else normalized[separator + 2 :]
    if not head:
        raise FuzzerError("empty request")

    parts = head[0].split()
    if len(parts) < 2:
        raise FuzzerError("malformed request line")
    method, target = parts[0], parts[1]

    headers: list[list[str]] = []
    for line in head[1:]:
        name, _, value = line.partition(":")
        if not _:
            continue
        headers.append([name.strip(), value.strip()])

    base = url.rstrip("/")
    absolute = (
        target
        if target.lower().startswith(("http://", "https://"))
        else f"{base}{'' if target.startswith('/') else '/'}{target}"
    )
    return {"url": absolute, "method": method, "headers": headers, "body": body}


class FuzzerAddon:
    """Runs payload fuzzing jobs; the project database owns result history."""

    def __init__(self, replay: Any, broker: Any = None, concurrency: int = 5, store: Any = None) -> None:
        self.replay = replay
        self.broker = broker
        self.concurrency = concurrency
        self.store = store
        self.runs: dict[str, FuzzRun] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._save_locks: dict[str, asyncio.Lock] = {}
        self.reload()

    def reload(self) -> None:
        """Restore the open project's history after startup or import."""
        if self.store is None:
            return
        self.store.interrupt_fuzzer_runs()
        self.runs = {
            run.id: run
            for run in (FuzzRun.from_dict(data) for data in self.store.list_fuzzer_runs(include_results=False))
        }
        self._tasks.clear()
        self._save_locks.clear()

    @staticmethod
    async def _durable_write(method: Any, *args: Any) -> None:
        """Finish a SQLite write even if its caller is cancelled."""
        pending = asyncio.create_task(asyncio.to_thread(method, *args))
        try:
            await asyncio.shield(pending)
        except asyncio.CancelledError:
            await pending
            raise

    async def _save_run(self, run: FuzzRun) -> None:
        if self.store is None:
            return
        async with self._save_locks.setdefault(run.id, asyncio.Lock()):
            await self._durable_write(self.store.save_fuzzer_run, run.as_dict())

    def _publish(self, event: str, data: Any) -> None:
        if self.broker is not None:
            self.broker.publish(event, data)

    def plan(
        self,
        *,
        mode: RunMode,
        template: str,
        payload_sets: Sequence[Sequence[str]],
    ) -> int:
        if mode not in RUN_MODES:
            raise FuzzerError(f"unknown run type: {mode!r}")
        positions = find_positions(template)
        total = count_requests(mode, len(positions), payload_sets)
        if total > MAX_REQUESTS:
            raise FuzzerError(
                f"run would send {total} requests (limit {MAX_REQUESTS})"
            )
        return total

    async def start(
        self,
        *,
        url: str,
        template: str,
        mode: RunMode = "single_position",
        payload_sets: Sequence[Sequence[str]],
        speed: RunSpeed | None = None,
    ) -> FuzzRun:
        total = self.plan(
            mode=mode, template=template, payload_sets=payload_sets
        )
        run = FuzzRun(
            id=uuid.uuid4().hex[:12],
            mode=mode,
            url=url,
            template=template,
            total=total,
            payload_sets=[list(items) for items in payload_sets],
            # Falls back to the addon's configured default, so an
            # existing caller keeps the behaviour it had.
            speed=speed or RunSpeed(concurrency=self.concurrency),
        )
        await self._save_run(run)
        self.runs[run.id] = run
        task = asyncio.create_task(
            self._run(run, payload_sets), name=f"fuzzer-{run.id}"
        )
        self._tasks[run.id] = task
        return run

    async def stop(self, run_id: str) -> FuzzRun:
        run = self.runs.get(run_id)
        if run is None:
            raise FuzzerError(f"run {run_id} not found")
        task = self._tasks.get(run_id)
        run.status = "stopped"
        run.finished_at = time.time()
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._save_run(run)
        if self.store is not None:
            run.results.clear()
        self._publish("fuzzer.finished", run.summary())
        return run

    async def stop_all(self) -> None:
        """Stop all live jobs before a stricter network policy takes effect."""
        tasks: list[asyncio.Task[None]] = []
        for run_id, task in list(self._tasks.items()):
            if task.done():
                continue
            run = self.runs.get(run_id)
            if run is not None:
                run.status = "stopped"
            task.cancel()
            tasks.append(task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for run_id in self._tasks:
            run = self.runs.get(run_id)
            if run is not None and run.status == "stopped":
                run.finished_at = run.finished_at or time.time()
                await self._save_run(run)
                if self.store is not None:
                    run.results.clear()

    def get(self, run_id: str) -> FuzzRun:
        run = self.runs.get(run_id)
        if run is None:
            raise FuzzerError(f"run {run_id} not found")
        return run

    async def _run(
        self, run: FuzzRun, payload_sets: Sequence[Sequence[str]]
    ) -> None:
        from .replay import build_flow

        run.status = "running"
        self._publish("fuzzer.started", run.summary())
        positions = len(find_positions(run.template))

        async def run_one(index: int, slots: list[str | None], labels: list[str]) -> None:
            result = RunResult(index=index, payloads=labels)
            try:
                # Building requests is pure CPU work: keep it off the loop.
                payload = await asyncio.to_thread(
                    _render_request, run.url, run.template, slots
                )
                flow = build_flow(
                    **payload,
                    encode_content_body=self.replay.auto_decompress,
                )
                record = await self.replay.send(flow)
                result.status_code = record.status_code
                result.length = record.response_size
                result.duration_ms = record.duration_ms
                result.error = record.error
                result.flow_id = record.id
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # network/parse errors are per-request
                result.error = str(exc)
            if self.store is not None:
                try:
                    await self._durable_write(self.store.save_fuzzer_result, run.id, result.as_dict())
                except asyncio.CancelledError:
                    # The shielded write finished before cancellation exits.
                    run.completed_count += 1
                    self._publish("fuzzer.result", {"run_id": run.id, "result": result.as_dict()})
                    raise
            else:
                run.results.append(result)
            run.completed_count += 1
            self._publish(
                "fuzzer.result",
                {"run_id": run.id, "result": result.as_dict()},
            )

        try:
            # Fed through a queue rather than scheduled all at once: a
            # gather over the 100k request limit builds 100k coroutines
            # before sending anything, which measured at 139MB of memory
            # held for the whole run.
            queue: asyncio.Queue[tuple[int, list[str | None], list[str]] | None] = (
                asyncio.Queue(maxsize=run.speed.concurrency * 2)
            )

            async def worker() -> None:
                while True:
                    item = await queue.get()
                    try:
                        if item is None:
                            return
                        if run.speed.delay:
                            # Before the request, not after: the last
                            # request of a run should not be followed
                            # by a wait nobody is using.
                            await asyncio.sleep(run.speed.delay)
                        await run_one(*item)
                    finally:
                        queue.task_done()

            workers = [
                asyncio.create_task(worker())
                for _ in range(run.speed.concurrency)
            ]
            try:
                for index, (slots, labels) in enumerate(
                    generate_payload_tuples(
                        run.mode, positions, payload_sets
                    )
                ):
                    await queue.put((index, slots, labels))
                for _ in workers:
                    await queue.put(None)
                await asyncio.gather(*workers)
            except BaseException:
                # Includes cancellation: stopping a run should not
                # leave workers waiting on a queue nobody will fill.
                for task in workers:
                    task.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                raise
            if run.status != "stopped":
                run.status = "completed"
        except asyncio.CancelledError:
            run.status = "stopped"
        except FuzzerError as exc:
            run.status = "failed"
            run.error = str(exc)
        except Exception as exc:  # pragma: no cover - defensive
            run.status = "failed"
            run.error = str(exc)
            logger.exception("run %s crashed", run.id)
        finally:
            run.finished_at = run.finished_at or time.time()
            if self.store is None:
                run.results.sort(key=lambda r: r.index)
            try:
                await self._save_run(run)
                self._publish("fuzzer.finished", run.summary())
            finally:
                if self.store is not None:
                    run.results.clear()
                self._tasks.pop(run.id, None)
                self._save_locks.pop(run.id, None)


def _render_request(
    url: str, template: str, slots: list[str | None]
) -> dict[str, Any]:
    return parse_request_template(url, apply_payloads(template, slots))
