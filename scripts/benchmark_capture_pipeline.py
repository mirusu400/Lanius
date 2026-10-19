"""Compare per-snapshot commits with Lanius's batched capture writer.

This is a local SQLite benchmark; it opens no network connections and removes
its temporary databases on exit.

Example:
    python3 scripts/benchmark_capture_pipeline.py --flows 10000 --body-bytes 128
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from app.addons.capture import (  # noqa: E402
    CAPTURE_BATCH_SIZE,
    CAPTURE_FLUSH_SECONDS,
    CAPTURE_QUEUE_SIZE,
    _CaptureWriter,
)
from app.db.store import FlowRecord, FlowStore  # noqa: E402
from app.events import EventBroker  # noqa: E402


def snapshots(index: int, body: bytes) -> tuple[FlowRecord, FlowRecord]:
    common = dict(
        id=f"capture-{index}",
        scheme="http",
        method="GET",
        host="benchmark.invalid",
        port=80,
        path=f"/api/items/{index}",
        request_headers=[("accept", "application/json")],
        request_body=body,
        request_size=len(body),
        started_at=float(index),
    )
    request = FlowRecord(**common)
    response = FlowRecord(
        **common,
        status_code=200,
        response_headers=[("content-type", "application/json")],
        response_body=body,
        response_size=len(body),
        completed_at=float(index) + 0.01,
        duration_ms=10.0,
    )
    return request, response


def legacy_two_commits(path: Path, flows: int, body: bytes) -> float:
    store = FlowStore(path)
    started = time.perf_counter()
    for index in range(flows):
        request, response = snapshots(index, body)
        store.upsert(request)
        store.upsert(response)
    elapsed = time.perf_counter() - started
    assert store.count() == flows
    store.close()
    return elapsed


async def batched_writer(
    path: Path,
    flows: int,
    body: bytes,
    *,
    batch_size: int,
    flush_seconds: float,
    queue_size: int,
) -> tuple[float, dict[str, object]]:
    store = FlowStore(path)
    writer = _CaptureWriter(
        store,
        EventBroker(),
        batch_size=batch_size,
        flush_seconds=flush_seconds,
        queue_size=queue_size,
    )
    loop = asyncio.get_running_loop()
    started = time.perf_counter()
    for index in range(flows):
        request, response = snapshots(index, body)
        writer.offer(
            loop,
            store.prepare_capture_record(request),
            "flow.request",
        )
        writer.offer(
            loop,
            store.prepare_capture_record(response),
            "flow.response",
        )
    await asyncio.to_thread(writer.stop)
    elapsed = time.perf_counter() - started
    assert store.count() == flows
    status = writer.status()
    store.close()
    return elapsed, status


def rate(flows: int, elapsed: float) -> str:
    return f"{flows / elapsed:,.0f} completed flows/s ({elapsed:.3f}s)"


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flows", type=int, default=5_000)
    parser.add_argument("--body-bytes", type=int, default=128)
    parser.add_argument("--batch-size", type=int, default=CAPTURE_BATCH_SIZE)
    parser.add_argument("--flush-ms", type=float, default=CAPTURE_FLUSH_SECONDS * 1000)
    parser.add_argument("--queue-size", type=int, default=CAPTURE_QUEUE_SIZE)
    args = parser.parse_args()
    if min(args.flows, args.batch_size, args.queue_size) < 1:
        parser.error("flows, batch-size and queue-size must be positive")
    if args.body_bytes < 0 or args.flush_ms < 0:
        parser.error("body-bytes and flush-ms must be non-negative")

    body = b"x" * args.body_bytes
    with tempfile.TemporaryDirectory(prefix="lanius_capture_benchmark_") as directory:
        root = Path(directory)
        legacy = legacy_two_commits(root / "legacy.sqlite", args.flows, body)
        current, status = await batched_writer(
            root / "batched.sqlite",
            args.flows,
            body,
            batch_size=args.batch_size,
            flush_seconds=args.flush_ms / 1000,
            queue_size=args.queue_size,
        )

    print(f"legacy request+response commits: {rate(args.flows, legacy)}")
    print(f"bounded batched writer:          {rate(args.flows, current)}")
    print(f"speedup: {legacy / current:.2f}x")
    print(f"writer stats: {json.dumps(status, sort_keys=True)}")


if __name__ == "__main__":
    asyncio.run(main())
