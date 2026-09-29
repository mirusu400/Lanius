from __future__ import annotations

import time
import threading

import sqlite3
import pytest

from app.db.schema import SCHEMA_VERSION, _MIGRATIONS, migrate
from app.db.endpoint_index import register_functions as register_endpoint_functions
from app.db.store import FlowRecord, FlowStore, RequestSnapshot


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
    for statement in _MIGRATIONS[1]:
        conn.execute(statement)
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


def test_failed_large_migration_rolls_back_its_schema(tmp_path) -> None:
    conn = sqlite3.connect(tmp_path / "broken.sqlite")
    conn.execute("CREATE TABLE flows (id TEXT PRIMARY KEY)")
    conn.execute("PRAGMA user_version = 5")
    conn.commit()
    with pytest.raises(sqlite3.OperationalError):
        migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 5
    assert conn.execute(
        "SELECT name FROM sqlite_master WHERE name = 'flow_totals'"
    ).fetchone() is None
    conn.close()


def test_endpoint_index_follows_replacement_and_delete() -> None:
    store = FlowStore()
    store.upsert(FlowRecord(
        id="a", scheme="https", host="api.test", port=443,
        method="GET", path="/users/1", query="page=1", status_code=200,
        started_at=1,
    ))
    store.upsert(FlowRecord(
        id="b", scheme="https", host="api.test", port=443,
        method="GET", path="/users/2", query="sort=asc", status_code=404,
        started_at=2,
    ))
    group = store.page_endpoints()["items"][0]
    assert group["count"] == 2
    assert group["statuses"] == [200, 404]
    assert group["query_params"] == ["page", "sort"]
    assert group["last_seen"] == 2

    store.upsert(FlowRecord(
        id="b", scheme="https", host="api.test", port=443,
        method="POST", path="/orders/2", query="new=1", status_code=201,
        started_at=3,
    ))
    groups = {group["template"]: group for group in store.page_endpoints()["items"]}
    assert groups["/users/{id}"]["count"] == 1
    assert groups["/users/{id}"]["statuses"] == [200]
    assert groups["/users/{id}"]["query_params"] == ["page"]
    assert groups["/users/{id}"]["last_seen"] == 1
    assert groups["/orders/{id}"]["count"] == 1
    store.delete(["a"])
    assert [group["template"] for group in store.page_endpoints()["items"]] == ["/orders/{id}"]
    store.close()


def test_endpoint_index_backfills_existing_v6_history(tmp_path) -> None:
    path = tmp_path / "v6.sqlite"
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA recursive_triggers=ON")
    for version in range(1, 7):
        for statement in _MIGRATIONS[version]:
            conn.execute(statement)
    conn.execute("PRAGMA user_version=6")
    conn.executemany(
        "INSERT INTO flows(id, type, scheme, host, port, method, path, query,"
        " status_code, started_at) VALUES (?, 'http', 'https', 'api.test',"
        " 443, 'GET', ?, ?, ?, ?)",
        [("old-1", "/users/1", "page=1", 200, 1),
         ("old-2", "/users/2", "sort=asc", 404, 2)],
    )
    conn.commit()
    conn.close()

    store = FlowStore(path)
    group = store.page_endpoints()["items"][0]
    assert group["template"] == "/users/{id}"
    assert group["count"] == 2
    assert group["statuses"] == [200, 404]
    assert group["query_params"] == ["page", "sort"]
    assert store.page_endpoint_flows(
        "https", "api.test", 443, "GET", "/users/{id}", limit=1,
    )["count"] == 2
    store.close()

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


def test_request_modification_snapshots_roundtrip() -> None:
    store = FlowStore()
    original = RequestSnapshot(
        method="POST",
        scheme="https",
        host="example.com",
        port=443,
        path="/before",
        http_version="HTTP/1.1",
        headers=[("X-Stage", "original")],
        body=b"before",
    )
    automatic = RequestSnapshot(
        method="POST",
        scheme="https",
        host="example.com",
        port=443,
        path="/auto",
        http_version="HTTP/1.1",
        headers=[("X-Stage", "auto")],
        body=b"automatic",
    )
    store.upsert(
        make_record(
            "modified",
            method="PUT",
            path="/final",
            request_headers=[("X-Stage", "final")],
            request_body=b"final",
            request_original=original,
            request_auto_modified=automatic,
            auto_modified=True,
            modified=True,
        )
    )

    loaded = store.get("modified")
    assert loaded is not None
    assert loaded.summary()["modified"] is True
    variants = loaded.detail()["request_variants"]
    assert variants["original"]["path"] == "/before"
    assert variants["auto_modified"]["body"] == "automatic"
    assert variants["modified"]["path"] == "/final?page=1"
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


def test_full_bodies_and_text_search_survive_restart(tmp_path) -> None:
    import gzip

    path = tmp_path / "full.sqlite"
    body = b"a" * (5 * 1024 * 1024) + b"end-of-body-marker"
    store = FlowStore(path)
    store.upsert(make_record(
        "full", path="/other", request_body=body,
        request_headers=[("Content-Type", "text/plain"), ("X-Find", "header-marker")],
        response_body=gzip.compress("압축본문-needle".encode()),
        response_headers=[("Content-Encoding", "gzip"), ("Content-Type", "text/plain; charset=utf-8")],
        comment="comment-marker",
    ))
    assert store.get_body_bytes("full", "request") == body
    for term in ("end-of-body-marker", "header-marker", "압축본문", "comment-marker"):
        assert [item["id"] for item in store.page_summaries(search=term)["items"]] == ["full"]
    store.close()
    reopened = FlowStore(path)
    assert reopened.get_body_bytes("full", "request") == body
    assert reopened.page_summaries(search="end-of-body-marker")["items"][0]["id"] == "full"
    reopened.close()


def test_v7_upgrade_indexes_all_existing_history(tmp_path) -> None:
    path = tmp_path / "v7.sqlite"
    conn = sqlite3.connect(path)
    register_endpoint_functions(conn)
    conn.execute("PRAGMA recursive_triggers=ON")
    for version in range(1, 8):
        for statement in _MIGRATIONS[version]:
            conn.execute(statement)
    conn.execute(
        "INSERT INTO flows(id,host,path,request_headers,response_body) VALUES(?,?,?,?,?)",
        ("old", "old.example", "/other", '[["X-Old", "header-needle"]]', b"body-needle"),
    )
    conn.execute("PRAGMA user_version=7")
    conn.commit()
    conn.close()
    store = FlowStore(path)
    for term in ("old.example", "header-needle", "body-needle"):
        assert store.page_summaries(search=term)["items"][0]["id"] == "old"
    store.close()


def test_search_index_tracks_updates_deletes_and_literal_metacharacters() -> None:
    store = FlowStore()
    store.upsert(make_record("a", path="/other", request_body=b"alpha %_?*[ marker"))
    store.upsert(make_record("binary", path="/other", request_body=b"\x00hidden-needle"))
    assert store.page_summaries(search="%_?*[")["items"][0]["id"] == "a"
    assert store.page_summaries(search="hidden-needle")["items"][0]["id"] == "binary"
    store.upsert(make_record("a", path="/other", request_body=b"beta marker"))
    assert store.page_summaries(search="alpha")["items"] == []
    assert store.page_summaries(search="BETA")["items"][0]["id"] == "a"
    store.delete(["a"])
    assert store.page_summaries(search="beta")["items"] == []
    store.close()


def test_history_anchor_remains_stable_while_new_flows_arrive() -> None:
    store = FlowStore()
    for i in range(4):
        store.upsert(make_record(str(i), started_at=float(i)))
    first = store.page_summaries(limit=2)
    assert [item["id"] for item in first["items"]] == ["3", "2"]
    store.upsert(make_record("new", started_at=100))
    store.upsert(make_record("2", started_at=2, response_body=b"updated"))
    second = store.page_summaries(limit=2, offset=2, anchor=first["anchor"])
    assert [item["id"] for item in second["items"]] == ["1", "0"]
    store.close()


def test_history_cursor_does_not_skip_survivors_after_deletion() -> None:
    store = FlowStore()
    for i in range(4):
        store.upsert(make_record(str(i), started_at=float(i)))
    first = store.page_summaries(limit=2)
    store.delete(["3"])
    second = store.page_summaries(
        limit=2, anchor=first["anchor"], cursor=first["next_cursor"]
    )
    assert [item["id"] for item in second["items"]] == ["1", "0"]
    store.close()


def test_common_full_text_search_pages_without_losing_old_matches() -> None:
    store = FlowStore()
    for i in range(420):
        store.upsert(make_record(
            str(i), path="/other", host="common.example", started_at=float(i),
            request_body=b"common-search" if i != 0 else b"rare-old-marker",
        ))
    first = store.page_summaries(search="common-search", limit=200)
    assert len(first["items"]) == 200 and first["has_more"]
    store.delete(["419"])
    second = store.page_summaries(
        search="common-search", limit=200, anchor=first["anchor"],
        cursor=first["next_cursor"],
    )
    assert len(second["items"]) == 200 and second["has_more"]
    assert second["items"][0]["id"] == "219"
    third = store.page_summaries(
        search="common-search", limit=200, anchor=first["anchor"],
        cursor=second["next_cursor"],
    )
    assert len(third["items"]) == 19 and not third["has_more"]
    assert store.page_summaries(search="rare-old-marker")["items"][0]["id"] == "0"
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


def test_materialized_counts_follow_replacements_updates_and_deletes(tmp_path) -> None:
    store = FlowStore(tmp_path / "metrics.sqlite")
    store.upsert(make_record("a", host="a.test", path="/one", status_code=None,
                             response_size=0, duration_ms=None))
    assert store.dashboard()["pending"] == 1
    store.upsert(make_record("a", host="b.test", path="/two", status_code=404,
                             response_size=10, duration_ms=20.0))
    assert store.count() == 1
    assert [(s["host"], s["flows"], s["paths"]) for s in store.distinct_sites()] == [
        ("b.test", 1, 1)
    ]
    assert store.dashboard()["status_groups"] == {"4xx": 1}
    assert store.dashboard()["pending"] == 0
    store._conn.execute("UPDATE flows SET status_code = 500 WHERE id = 'a'")
    store._conn.commit()
    assert store.dashboard()["status_groups"] == {"5xx": 1}
    assert store.delete(["a"]) == 1
    assert store.count() == 0
    assert store.distinct_sites() == []
    assert store.dashboard()["status_groups"] == {}
    store.close()


def test_site_pages_are_bounded_and_prefix_counts_are_exact() -> None:
    store = FlowStore()
    for index, path in enumerate(("/api/x", "/api/x", "/api/y", "/api_%/z", "/API/z")):
        store.upsert(make_record(str(index), host="a.test", path=path))
    first = store.page_paths_for_site("https", "a.test", 443, limit=2)
    second = store.page_paths_for_site("https", "a.test", 443, limit=2, offset=2)
    third = store.page_paths_for_site("https", "a.test", 443, limit=2, offset=4)
    assert first["count"] == second["count"] == 5
    assert len(first["items"]) == len(second["items"]) == 2
    assert {row["id"] for row in first["items"] + second["items"] + third["items"]} == {
        "0", "1", "2", "3", "4"
    }
    assert store.page_paths_for_site(
        "https", "a.test", 443, path_prefix="/api"
    )["count"] == 3
    assert store.page_paths_for_site(
        "https", "a.test", 443, path_prefix="/api_%"
    )["count"] == 1
    store.close()


def test_file_reader_does_not_hold_capture_write_lock(tmp_path) -> None:
    store = FlowStore(tmp_path / "separate.sqlite")
    store.upsert(make_record("first"))
    entered = threading.Event()
    release = threading.Event()
    written = threading.Event()

    def pause(value: str) -> str:
        entered.set()
        release.wait(timeout=3)
        return value

    store._read_conn.create_function("pause", 1, pause)

    def read() -> None:
        with store._read_lock:
            store._read_conn.execute("SELECT pause(id) FROM flows LIMIT 1").fetchone()

    def write() -> None:
        store.upsert(make_record("second"))
        written.set()

    reader = threading.Thread(target=read)
    writer = threading.Thread(target=write)
    reader.start()
    assert entered.wait(timeout=2)
    try:
        writer.start()
        assert written.wait(timeout=2), "a read query stalled capture writes"
    finally:
        release.set()
        reader.join(timeout=3)
        writer.join(timeout=3)
        store.close()
