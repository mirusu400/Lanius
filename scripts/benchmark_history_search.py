"""Measure history searches against a disposable, deterministic project.

Run with engine/.venv/bin/python scripts/benchmark_history_search.py --rows 50000.
No network connections are made. First-query timings include SQLite cache misses,
but do not imply a cold operating-system file cache.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))

from app.db.store import FlowRecord, FlowStore  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=50_000)
    parser.add_argument("--body-bytes", type=int, default=1024)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if min(args.rows, args.repeats) < 1 or args.body_bytes < 0:
        parser.error("rows and repeats must be positive; body-bytes must be non-negative")

    with tempfile.TemporaryDirectory(prefix="lanius_history_search_") as directory:
        path = Path(directory) / "benchmark.sqlite"
        store = FlowStore(path)
        started = time.perf_counter()
        for base in range(0, args.rows, 500):
            store.upsert_many([
                FlowRecord(
                    id=str(index), scheme="https", port=443, method="GET",
                    host=f"host{index % 20}.example.test", path=f"/items/{index}",
                    started_at=float(index), status_code=200,
                    response_headers=[("content-type", "text/plain")],
                    response_body=(
                        b"oldest-needle " if index == 0 else
                        b"scattered-needle " if index % 20 == 0 else b""
                    ) + b"common-needle " + b"x" * args.body_bytes,
                )
                for index in range(base, min(base + 500, args.rows))
            ])
        store.close()
        print(json.dumps({"rows": args.rows, "body_bytes": args.body_bytes,
                          "sqlite": sqlite3.sqlite_version,
                          "seed_seconds": round(time.perf_counter() - started, 3)}), flush=True)

        cases = {
            "common": {"search": "common-needle"},
            "scattered": {"search": "scattered-needle"},
            "oldest": {"search": "oldest-needle"},
            "absent": {"search": "absent-needle"},
            "short_common": {"search": "xx"},
            "short_absent": {"search": "zz"},
            "scoped_common": {"search": "common-needle", "scope_predicate":
                              lambda _scheme, host, _port, _path: host == "host0.example.test"},
            "scoped_oldest": {"search": "oldest-needle", "scope_predicate":
                              lambda _scheme, host, _port, _path: host == "host0.example.test"},
            "host_sorted_common": {"search": "common-needle", "sort_by": "host"},
            "host_sorted_oldest": {"search": "oldest-needle", "sort_by": "host"},
            "deep_common": {"search": "common-needle", "offset": args.rows // 2},
        }
        for label, kwargs in cases.items():
            store = FlowStore(path)
            timings = []
            for _ in range(args.repeats):
                started = time.perf_counter()
                page = store.page_summaries(limit=200, **kwargs)
                timings.append((time.perf_counter() - started) * 1000)
            print(json.dumps({"case": label, "first_ms": round(timings[0], 2),
                              "median_ms": round(statistics.median(timings), 2),
                              "items": len(page["items"]), "has_more": page["has_more"]}), flush=True)
            store.close()


if __name__ == "__main__":
    main()
