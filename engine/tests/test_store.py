from __future__ import annotations

import time

import sqlite3

from app.db.schema import SCHEMA_VERSION, migrate
from app.db.store import FlowRecord, FlowStore


def make_record(flow_id: str, **kwargs) -> FlowRecord:
    base = dict(
        id=flow_id,
        method="GET",
        host="example.com",
        port=443,
        scheme="https",
        path="/api/items",
        query="page=1",
        request_headers=[("Host", "example.com"), ("Authorization", "Bearer x")],
        request_body=b"",
        started_at=time.time(),
        status_code=200,
        response_headers=[("Content-Type", "application/json")],
        response_body=b'{"ok":true}',
        response_size=11,
    )
    base.update(kwargs)
    return FlowRecord(**base)


def test_migrate_sets_user_version(tmp_path) -> None:
    store = FlowStore(tmp_path / "t.sqlite")
    version = store._conn.execute("PRAGMA user_version").fetchone()[0]
    assert version == SCHEMA_VERSION
    store.close()


def test_migrate_is_idempotent(tmp_path) -> None:
    path = tmp_path / "m.sqlite"
    conn = sqlite3.connect(path)
    assert migrate(conn) == SCHEMA_VERSION
    assert migrate(conn) == SCHEMA_VERSION
    conn.close()


def test_migrate_upgrades_a_v1_database(tmp_path) -> None:
    """An existing v1 project file must gain the v2 tables, not be recreated."""
    path = tmp_path / "old.sqlite"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE flows (id TEXT PRIMARY KEY)")
    conn.execute("INSERT INTO flows (id) VALUES ('legacy')")
    conn.execute("PRAGMA user_version = 1")
    conn.commit()
    conn.close()

    conn = sqlite3.connect(path)
    assert migrate(conn) == SCHEMA_VERSION
    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"scope_rules", "settings"} <= tables
    assert conn.execute("SELECT id FROM flows").fetchone()[0] == "legacy"
    conn.close()


def test_upsert_and_get_roundtrip() -> None:
    store = FlowStore()
    store.upsert(make_record("a"))
    got = store.get("a")
    assert got is not None
    assert got.method == "GET"
    assert got.host == "example.com"
    assert got.response_body == b'{"ok":true}'
    assert ("Authorization", "Bearer x") in got.request_headers
    store.close()


def test_upsert_is_idempotent_on_same_id() -> None:
    store = FlowStore()
    store.upsert(make_record("a"))
    store.upsert(make_record("a", status_code=500))
    assert store.count() == 1
    got = store.get("a")
    assert got is not None and got.status_code == 500
    store.close()


def test_list_filters_and_ordering() -> None:
    store = FlowStore()
    now = time.time()
    store.upsert(make_record("a", host="a.com", started_at=now - 10, method="GET"))
    store.upsert(make_record("b", host="b.com", started_at=now, method="POST"))
    store.upsert(make_record("c", host="b.com", started_at=now - 5, status_code=404))

    assert [r.id for r in store.list()] == ["b", "c", "a"]
    assert [r.id for r in store.list(host="b.com")] == ["b", "c"]
    assert [r.id for r in store.list(method="post")] == ["b"]
    assert [r.id for r in store.list(status_code=404)] == ["c"]
    assert [r.id for r in store.list(search="items")] == ["b", "c", "a"]
    assert [r.id for r in store.list(limit=1, offset=1)] == ["c"]
    store.close()


def test_clear_and_count() -> None:
    store = FlowStore()
    store.upsert(make_record("a"))
    store.upsert(make_record("b"))
    assert store.count() == 2
    store.clear()
    assert store.count() == 0
    store.close()


def test_summary_excludes_bodies_and_headers() -> None:
    summary = make_record("a").summary()
    assert "request_body" not in summary
    assert "response_headers" not in summary
    assert summary["id"] == "a"


def test_detail_decodes_bodies() -> None:
    detail = make_record("a", response_body=b"\xff\xfeabc").detail()
    assert isinstance(detail["response_body"], str)


def test_persistence_across_reopen(tmp_path) -> None:
    path = tmp_path / "p.sqlite"
    store = FlowStore(path)
    store.upsert(make_record("a"))
    store.close()

    reopened = FlowStore(path)
    assert reopened.count() == 1
    assert reopened.get("a") is not None
    reopened.close()


# --- dashboard aggregates ---------------------------------------------------


def _dashboard_fixture() -> FlowStore:
    """A capture with a mix of statuses, hosts, methods and timings."""
    store = FlowStore()
    now = time.time()
    store.upsert(make_record("a", host="a.com", status_code=200, duration_ms=10.0,
                             request_size=100, response_size=200, started_at=now))
    store.upsert(make_record("b", host="a.com", status_code=404, duration_ms=20.0,
                             request_size=100, response_size=50, started_at=now))
    store.upsert(make_record("c", host="a.com", method="POST", status_code=500,
                             duration_ms=300.0, request_size=10, response_size=10,
                             started_at=now))
    store.upsert(make_record("d", host="b.com", status_code=301, duration_ms=5.0,
                             request_size=1, response_size=1, started_at=now))
    return store


def test_dashboard_counts_by_status_group() -> None:
    data = _dashboard_fixture().dashboard()
    assert data["status_groups"] == {"2xx": 1, "3xx": 1, "4xx": 1, "5xx": 1}
    assert data["flows"] == 4
    assert data["hosts"] == 2


def test_dashboard_sums_traffic_and_averages_duration() -> None:
    data = _dashboard_fixture().dashboard()
    assert data["bytes"] == 100 + 200 + 100 + 50 + 10 + 10 + 1 + 1
    assert data["avg_duration_ms"] == round((10.0 + 20.0 + 300.0 + 5.0) / 4, 2)


def test_dashboard_ranks_hosts_by_volume() -> None:
    data = _dashboard_fixture().dashboard()
    top = data["top_hosts"]
    assert [h["host"] for h in top] == ["a.com", "b.com"]
    assert top[0]["flows"] == 3
    # 404 and 500 are failures; the 200 is not.
    assert top[0]["errors"] == 2
    assert top[1]["errors"] == 0


def test_dashboard_lists_the_slowest_requests_first() -> None:
    data = _dashboard_fixture().dashboard()
    assert [f["duration_ms"] for f in data["slowest"]] == [300.0, 20.0, 10.0, 5.0]
    assert data["slowest"][0]["method"] == "POST"


def test_dashboard_reports_methods_by_frequency() -> None:
    data = _dashboard_fixture().dashboard()
    assert data["methods"] == [{"method": "GET", "count": 3},
                               {"method": "POST", "count": 1}]


def test_dashboard_counts_in_flight_flows_separately() -> None:
    """A request with no response yet must not be counted as a success."""
    store = _dashboard_fixture()
    store.upsert(make_record("e", host="c.com", status_code=None,
                             duration_ms=None))
    data = store.dashboard()
    assert data["pending"] == 1
    assert sum(data["status_groups"].values()) == 4, "pending is not a status"
    assert data["flows"] == 5


def test_dashboard_honours_the_top_limit() -> None:
    store = FlowStore()
    for i in range(12):
        store.upsert(make_record(f"h{i}", host=f"h{i}.com"))
    assert len(store.dashboard(top=3)["top_hosts"]) == 3


def test_dashboard_on_an_empty_capture_is_all_zeroes() -> None:
    """The tab renders before any traffic arrives, so this must not blow up."""
    data = FlowStore().dashboard()
    assert data["flows"] == 0
    assert data["avg_duration_ms"] is None
    assert data["status_groups"] == {}
    assert data["top_hosts"] == []
    assert data["span_seconds"] == 0.0


def test_dashboard_counts_recent_flows_within_the_window() -> None:
    store = FlowStore()
    now = time.time()
    store.upsert(make_record("old", started_at=now - 1000))
    store.upsert(make_record("new", started_at=now))
    data = store.dashboard(recent_window=60.0)
    assert data["recent_flows"] == 1, "the 1000s-old flow is outside the window"
    assert data["span_seconds"] > 900
