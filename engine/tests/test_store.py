from __future__ import annotations

import time

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
    assert version == 1
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
