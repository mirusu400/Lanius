"""Benchmark a large, disposable Lanius project database.

Example: python3 scripts/benchmark_large_project.py --rows 2000000
The script creates a v5 database in a temporary directory, upgrades it using
the current FlowStore, measures common views and removes the database on exit.
It measures persistence and queries, not mitmproxy network throughput or UI FPS.
"""

from __future__ import annotations

import argparse
import resource
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from app.db.schema import _MIGRATIONS  # noqa: E402
from app.db.store import FlowRecord, FlowStore  # noqa: E402


def measure(label: str, fn) -> None:
    start = time.perf_counter()
    fn()
    print(f"{label}: {time.perf_counter() - start:.3f}s", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=100_000)
    parser.add_argument("--body-bytes", type=int, default=256)
    parser.add_argument("--unique-paths", action="store_true",
                        help="Use distinct static paths to stress endpoint group count")
    args = parser.parse_args()
    if args.rows < 1 or not 0 <= args.body_bytes <= 5 * 1024 * 1024:
        parser.error("rows must be positive; body-bytes must be between 0 and 5 MiB")

    with tempfile.TemporaryDirectory(prefix="lanius_large_project_") as directory:
        path = Path(directory) / "capture.sqlite"
        conn = sqlite3.connect(path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        for version in range(1, 6):
            for statement in _MIGRATIONS[version]:
                conn.execute(statement)
        conn.execute("PRAGMA user_version=5")
        conn.commit()

        body = b"x" * args.body_bytes
        headers = '[["accept","*/*"],["user-agent","stress-probe"]]'
        sql = """INSERT INTO flows (
          id, type, scheme, method, host, port, path, query, request_headers,
          request_body, request_size, started_at, status_code, response_headers,
          response_body, response_size, response_mime, completed_at, duration_ms, source
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""
        start = time.perf_counter()
        for base in range(0, args.rows, 10_000):
            rows = []
            for index in range(base, min(base + 10_000, args.rows)):
                host = f"host{index % 50}.example.test"
                rows.append((
                    f"{index:032x}", "http", "https", "GET", host, 443,
                    ("/legacy-only" if index == 0 else
                     f"/p/item-{index:08d}" if args.unique_paths else
                     f"/api/products/{index % 1000}"),
                    f"page={index % 20}",
                    headers, body, args.body_bytes, float(index), 200,
                    headers, body, args.body_bytes, "application/json",
                    float(index) + 0.05, 50.0, "proxy",
                ))
            with conn:
                conn.executemany(sql, rows)
            if (base + 10_000) % 500_000 == 0:
                print(f"seeded {base + 10_000} rows", flush=True)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        print(f"v5 seed: {time.perf_counter() - start:.3f}s", flush=True)
        conn.close()

        start = time.perf_counter()
        store = FlowStore(path)
        print(f"v5 to current migration: {time.perf_counter() - start:.3f}s", flush=True)
        print(f"database: {path.stat().st_size / 1024**2:.1f} MiB", flush=True)
        measure("count", store.count)
        measure("dashboard", store.dashboard)
        measure("site list", store.distinct_sites)
        measure("site first page", lambda: store.page_paths_for_site(
            "https", "host12.example.test", 443, limit=200))
        measure("folder first page", lambda: store.page_paths_for_site(
            "https", "host12.example.test", 443, limit=200,
            path_prefix="/api/products"))
        measure("latest 200 flows", lambda: store.list(limit=200))
        measure("oldest flow search", lambda: store.page_summaries(
            search="/legacy-only", limit=200))
        measure("site folders", lambda: store.page_folders_for_site(
            "https", "host12.example.test", 443, limit=200))
        measure("endpoint groups", lambda: store.page_endpoints(limit=200))
        measure("endpoint groups, host scope", lambda: store.page_endpoints(
            limit=200, scope_predicate=lambda _scheme, host, _port, _path:
                host == "host12.example.test", scope_site_wide=True))
        measure("endpoint detail", lambda: store.page_endpoint_flows(
            "https", "host12.example.test", 443, "GET",
            "/p/item-00000012" if args.unique_paths else "/api/products/{id}",
            limit=200))

        start = time.perf_counter()
        for index in range(1_000):
            store.upsert(FlowRecord(
                id=f"new-{index}", scheme="https", method="GET",
                host="host12.example.test", port=443, path=f"/new/{index}",
                request_body=body, request_size=args.body_bytes,
                response_body=body, response_size=args.body_bytes,
                started_at=float(args.rows + index), status_code=200,
            ))
        print(f"1000 committed upserts: {time.perf_counter() - start:.3f}s", flush=True)
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rss_mib = rss / (1024 if sys.platform.startswith("linux") else 1024**2)
        print(f"peak process RSS: {rss_mib:.1f} MiB", flush=True)
        store.close()


if __name__ == "__main__":
    main()
