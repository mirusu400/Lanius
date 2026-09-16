"""Intruder: payload positions + wordlist fuzzing.

Attacks run through the Repeater's engine-backed send path, and request
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

MARKER = "§"
AttackType = Literal["sniper", "battering_ram", "pitchfork", "cluster_bomb"]
ATTACK_TYPES: tuple[AttackType, ...] = (
    "sniper",
    "battering_ram",
    "pitchfork",
    "cluster_bomb",
)

MAX_REQUESTS = 100_000

# Enough to saturate most targets without being a denial of service by
# accident. Above this the bottleneck is the target, not Lanius.
MAX_CONCURRENCY = 64
DEFAULT_CONCURRENCY = 5
# A minute between requests is slow enough for the most delicate target
# worth testing; beyond that an attack is better paused.
MAX_DELAY = 60.0


class IntruderError(Exception):
    """Invalid attack configuration (mapped to HTTP 4xx)."""


@dataclass(slots=True)
class Position:
    """A payload position: the span between two markers."""

    start: int
    end: int
    value: str


def find_positions(template: str, marker: str = MARKER) -> list[Position]:
    """Locate ``§payload§`` spans in a request template."""
    positions: list[Position] = []
    index = 0
    while True:
        start = template.find(marker, index)
        if start == -1:
            break
        end = template.find(marker, start + len(marker))
        if end == -1:
            raise IntruderError("unbalanced payload marker")
        positions.append(
            Position(
                start=start,
                end=end + len(marker),
                value=template[start + len(marker) : end],
            )
        )
        index = end + len(marker)
    return positions


def strip_markers(template: str, marker: str = MARKER) -> str:
    """The request as it would be sent with no payloads applied."""
    positions = find_positions(template, marker)
    out: list[str] = []
    cursor = 0
    for position in positions:
        out.append(template[cursor : position.start])
        out.append(position.value)
        cursor = position.end
    out.append(template[cursor:])
    return "".join(out)


def apply_payloads(
    template: str, payloads: Sequence[str | None], marker: str = MARKER
) -> str:
    """Substitute payloads into positions; ``None`` keeps the base value."""
    positions = find_positions(template, marker)
    if len(payloads) != len(positions):
        raise IntruderError(
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
    attack_type: AttackType, position_count: int, payload_sets: Sequence[Sequence[str]]
) -> int:
    """How many requests an attack will generate."""
    if position_count == 0:
        raise IntruderError("no payload positions marked")
    if not payload_sets or not any(payload_sets):
        raise IntruderError("no payloads provided")

    if attack_type == "sniper":
        return position_count * len(payload_sets[0])
    if attack_type == "battering_ram":
        return len(payload_sets[0])
    if attack_type == "pitchfork":
        sets = payload_sets[:position_count]
        if len(sets) < position_count:
            raise IntruderError(
                f"pitchfork needs {position_count} payload sets, got {len(sets)}"
            )
        return min(len(s) for s in sets)
    # cluster bomb
    sets = payload_sets[:position_count]
    if len(sets) < position_count:
        raise IntruderError(
            f"cluster bomb needs {position_count} payload sets, got {len(sets)}"
        )
    total = 1
    for payload_set in sets:
        total *= len(payload_set)
    return total


def generate_payload_tuples(
    attack_type: AttackType,
    position_count: int,
    payload_sets: Sequence[Sequence[str]],
) -> Iterator[tuple[list[str | None], list[str]]]:
    """Yield ``(payloads_per_position, labels)`` for every request."""
    if attack_type == "sniper":
        # One position at a time; the rest keep their base value.
        for index in range(position_count):
            for payload in payload_sets[0]:
                slots: list[str | None] = [None] * position_count
                slots[index] = payload
                yield slots, [payload]
    elif attack_type == "battering_ram":
        for payload in payload_sets[0]:
            yield [payload] * position_count, [payload]
    elif attack_type == "pitchfork":
        sets = [list(s) for s in payload_sets[:position_count]]
        for combo in zip(*sets):
            yield list(combo), list(combo)
    else:  # cluster_bomb
        sets = [list(s) for s in payload_sets[:position_count]]
        for combo in itertools.product(*sets):
            yield list(combo), list(combo)


@dataclass(slots=True)
class AttackResult:
    """One request/response pair from an attack."""

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
class AttackSpeed:
    """How hard to push the target.

    Defaults are deliberately gentle: an attack that knocks a service
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
            raise IntruderError(
                f"concurrency must be between 1 and {MAX_CONCURRENCY}"
            )
        if not 0 <= self.delay <= MAX_DELAY:
            raise IntruderError(f"delay must be between 0 and {MAX_DELAY} seconds")

    def as_dict(self) -> dict[str, Any]:
        return {"concurrency": self.concurrency, "delay": self.delay}


@dataclass(slots=True)
class Attack:
    """A running or finished attack."""

    id: str
    attack_type: AttackType
    url: str
    template: str
    total: int
    speed: AttackSpeed = field(default_factory=lambda: AttackSpeed())
    results: list[AttackResult] = field(default_factory=list)
    status: str = "pending"
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None

    @property
    def completed(self) -> int:
        return len(self.results)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "attack_type": self.attack_type,
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
            "results": [r.as_dict() for r in self.results],
        }


def parse_request_template(url: str, text: str) -> dict[str, Any]:
    """Parse raw HTTP text (markers already substituted) into a send payload."""
    normalized = text.replace("\r\n", "\n")
    separator = normalized.find("\n\n")
    head = (normalized if separator == -1 else normalized[:separator]).split("\n")
    head = [line for line in head if line]
    body = "" if separator == -1 else normalized[separator + 2 :]
    if not head:
        raise IntruderError("empty request")

    parts = head[0].split()
    if len(parts) < 2:
        raise IntruderError("malformed request line")
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


class IntruderAddon:
    """Runs attacks and keeps their results in memory."""

    def __init__(self, repeater: Any, broker: Any = None, concurrency: int = 5) -> None:
        self.repeater = repeater
        self.broker = broker
        self.concurrency = concurrency
        self.attacks: dict[str, Attack] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def _publish(self, event: str, data: Any) -> None:
        if self.broker is not None:
            self.broker.publish(event, data)

    def plan(
        self,
        *,
        attack_type: AttackType,
        template: str,
        payload_sets: Sequence[Sequence[str]],
    ) -> int:
        if attack_type not in ATTACK_TYPES:
            raise IntruderError(f"unknown attack type: {attack_type!r}")
        positions = find_positions(template)
        total = count_requests(attack_type, len(positions), payload_sets)
        if total > MAX_REQUESTS:
            raise IntruderError(
                f"attack would send {total} requests (limit {MAX_REQUESTS})"
            )
        return total

    async def start(
        self,
        *,
        url: str,
        template: str,
        attack_type: AttackType = "sniper",
        payload_sets: Sequence[Sequence[str]],
        speed: AttackSpeed | None = None,
    ) -> Attack:
        total = self.plan(
            attack_type=attack_type, template=template, payload_sets=payload_sets
        )
        attack = Attack(
            id=uuid.uuid4().hex[:12],
            attack_type=attack_type,
            url=url,
            template=template,
            total=total,
            # Falls back to the addon's configured default, so an
            # existing caller keeps the behaviour it had.
            speed=speed or AttackSpeed(concurrency=self.concurrency),
        )
        self.attacks[attack.id] = attack
        task = asyncio.create_task(
            self._run(attack, payload_sets), name=f"intruder-{attack.id}"
        )
        self._tasks[attack.id] = task
        return attack

    def stop(self, attack_id: str) -> Attack:
        attack = self.attacks.get(attack_id)
        if attack is None:
            raise IntruderError(f"attack {attack_id} not found")
        task = self._tasks.get(attack_id)
        if task is not None and not task.done():
            task.cancel()
        attack.status = "stopped"
        attack.finished_at = time.time()
        self._publish("intruder.finished", attack.summary())
        return attack

    def get(self, attack_id: str) -> Attack:
        attack = self.attacks.get(attack_id)
        if attack is None:
            raise IntruderError(f"attack {attack_id} not found")
        return attack

    async def _run(
        self, attack: Attack, payload_sets: Sequence[Sequence[str]]
    ) -> None:
        from .repeater import build_flow

        attack.status = "running"
        self._publish("intruder.started", attack.summary())
        positions = len(find_positions(attack.template))

        async def run_one(index: int, slots: list[str | None], labels: list[str]) -> None:
            result = AttackResult(index=index, payloads=labels)
            try:
                # Building requests is pure CPU work: keep it off the loop.
                payload = await asyncio.to_thread(
                    _render_request, attack.url, attack.template, slots
                )
                flow = build_flow(**payload)
                record = await self.repeater.send(flow)
                result.status_code = record.status_code
                result.length = record.response_size
                result.duration_ms = record.duration_ms
                result.error = record.error
                result.flow_id = record.id
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # network/parse errors are per-request
                result.error = str(exc)
            attack.results.append(result)
            self._publish(
                "intruder.result",
                {"attack_id": attack.id, "result": result.as_dict()},
            )

        try:
            # Fed through a queue rather than scheduled all at once: a
            # gather over the 100k request limit builds 100k coroutines
            # before sending anything, which measured at 139MB of memory
            # held for the whole attack.
            queue: asyncio.Queue[tuple[int, list[str | None], list[str]] | None] = (
                asyncio.Queue(maxsize=attack.speed.concurrency * 2)
            )

            async def worker() -> None:
                while True:
                    item = await queue.get()
                    try:
                        if item is None:
                            return
                        if attack.speed.delay:
                            # Before the request, not after: the last
                            # request of an attack should not be followed
                            # by a wait nobody is using.
                            await asyncio.sleep(attack.speed.delay)
                        await run_one(*item)
                    finally:
                        queue.task_done()

            workers = [
                asyncio.create_task(worker())
                for _ in range(attack.speed.concurrency)
            ]
            try:
                for index, (slots, labels) in enumerate(
                    generate_payload_tuples(
                        attack.attack_type, positions, payload_sets
                    )
                ):
                    await queue.put((index, slots, labels))
                for _ in workers:
                    await queue.put(None)
                await asyncio.gather(*workers)
            except BaseException:
                # Includes cancellation: stopping an attack should not
                # leave workers waiting on a queue nobody will fill.
                for task in workers:
                    task.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                raise
            attack.status = "completed"
        except asyncio.CancelledError:
            attack.status = "stopped"
        except IntruderError as exc:
            attack.status = "failed"
            attack.error = str(exc)
        except Exception as exc:  # pragma: no cover - defensive
            attack.status = "failed"
            attack.error = str(exc)
            logger.exception("attack %s crashed", attack.id)
        finally:
            attack.finished_at = time.time()
            attack.results.sort(key=lambda r: r.index)
            self._publish("intruder.finished", attack.summary())


def _render_request(
    url: str, template: str, slots: list[str | None]
) -> dict[str, Any]:
    return parse_request_template(url, apply_payloads(template, slots))
