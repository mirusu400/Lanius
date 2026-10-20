"""History optimizations must preserve exact matching, order and pagination."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.db.store import FlowRecord, FlowStore


SORTS = {
    "started_at": "started_at", "method": "method", "host": "host",
    "url": "path || COALESCE('?' || query, '')", "status_code": "status_code",
    "modified": "modified", "response_size": "response_size", "duration_ms": "duration_ms",
}


@pytest.fixture(scope="module", params=[":memory:", "file"])
def history(request, tmp_path_factory):
    path = ":memory:" if request.param == ":memory:" else tmp_path_factory.mktemp("history") / "history.sqlite"
    store = FlowStore(path)
    store.upsert_many([
        FlowRecord(
            id=str(i), scheme="https", port=443, host=f"host{i % 3}.test",
            path=f"/items/{i}", query=f"n={i % 7}" if i % 2 else None,
            method="GET" if i % 2 else "POST", status_code=200 if i % 5 else 404,
            started_at=float(i // 3) if i % 19 else None,
            modified=bool(i % 2), response_size=i % 10,
            duration_ms=float(i % 8) if i % 4 else None,
            response_body=("COMMON xx [*] Straße" + (" oldest" if i == 0 else "")).encode(),
        )
        for i in range(1430)
    ])
    yield store
    store.close()


@pytest.mark.parametrize("sort_by", SORTS)
@pytest.mark.parametrize("descending", [True, False])
@pytest.mark.parametrize("scoped", [True, False])
@pytest.mark.parametrize("term", ["COMMON", "oldest", "xx", "zz", "[*]", "SS"])
def test_search_matches_literal_scan_in_every_order(history, sort_by, descending, scoped, term):
    # Independent full scan: no trigram query or bounded probe, including ties,
    # NULL timestamps, case folding, literal metacharacters and old matches.
    direction = "DESC" if descending else "ASC"
    scope = " AND host = 'host1.test'" if scoped else ""
    with history._read_lock:
        expected = [row[0] for row in history._read_conn.execute(
            "SELECT flows.id FROM flow_history AS flows"
            " JOIN flow_search AS text ON text.rowid = flows.rowid"
            f" WHERE instr(text.text, ?) > 0{scope}"
            f" ORDER BY {SORTS[sort_by]} {direction}, flows.rowid {direction}",
            (term.casefold(),),
        )]
    kwargs = dict(search=term, sort_by=sort_by, sort_desc=descending,
                  scope_predicate=(lambda _scheme, host, _port, _path: host == "host1.test") if scoped else None)
    first = history.page_summaries(limit=7, **kwargs)
    assert [row["id"] for row in first["items"]] == expected[:7]
    assert first["has_more"] == (len(expected) > 7)
    if sort_by == "started_at" and descending and first["next_cursor"]:
        second = history.page_summaries(limit=7, cursor=first["next_cursor"], anchor=first["anchor"], **kwargs)
    else:
        second = history.page_summaries(limit=7, offset=7, anchor=first["anchor"], **kwargs)
        if sort_by != "started_at" or not descending:
            assert first["next_cursor"] is None
    assert [row["id"] for row in second["items"]] == expected[7:14]
    assert second["has_more"] == (len(expected) > 14)
    # An offset beyond the probe budget exercises the full-index fallback.
    deep = history.page_summaries(limit=7, offset=1001, **kwargs)
    assert [row["id"] for row in deep["items"]] == expected[1001:1008]
    assert deep["has_more"] == (len(expected) > 1008)


def test_scope_function_is_replaced_and_removed_between_queries(history):
    first = history.page_summaries(search="common", limit=7, scope_predicate=lambda *_: False)
    second = history.page_summaries(search="common", limit=7, scope_predicate=lambda *_: True)
    third = history.page_summaries(search="common", limit=7)
    assert first["items"] == []
    assert second == third


def test_rare_search_does_not_check_scope_for_unrelated_history(history):
    visited = []

    def in_scope(_scheme, host, _port, path):
        visited.append(path)
        return True

    page = history.page_summaries(search="oldest", scope_predicate=in_scope)
    assert [row["id"] for row in page["items"]] == ["0"]
    assert visited == ["/items/0"]


def test_search_probe_respects_filters_and_annotations(tmp_path):
    store = FlowStore(tmp_path / "filtered.sqlite")
    try:
        store.upsert_many([
            FlowRecord(id=str(i), started_at=float(i), method="GET" if i % 2 else "POST",
                       path="/test.json", status_code=200, response_body=b"common")
            for i in range(420)
        ])
        for i in range(0, 420, 3):
            store.patch_annotation(str(i), {"bookmarked": True, "annotation_color": "blue"})
        expected = [str(i) for i in reversed(range(420)) if i % 2 and i % 3 == 0]
        page = store.page_summaries(search="common", methods=["GET"], status_classes=[2],
                                    extensions=["json"], bookmarked_only=True, annotation_color="blue", limit=7)
        assert [row["id"] for row in page["items"]] == expected[:7]
        assert page["has_more"]
        assert all(row["bookmarked"] and row["annotation_color"] == "blue" for row in page["items"])
    finally:
        store.close()


def test_blocked_history_search_does_not_block_details_settings_or_capture(tmp_path):
    store = FlowStore(tmp_path / "concurrent.sqlite")
    store.upsert(FlowRecord(id="first", response_body=b"body"))
    store.set_setting("test", "value")
    entered, release = threading.Event(), threading.Event()

    def pause(*_args):
        entered.set()
        assert release.wait(timeout=5)
        return True

    def other_work():
        assert store.get_preview("first", body_limit=4)[0].response_body == b"body"
        assert store.get_setting("test") == "value"
        assert store.count() == 1
        store.upsert(FlowRecord(id="second"))

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            searching = pool.submit(store.page_summaries, scope_predicate=pause)
            try:
                assert entered.wait(timeout=2)
                pool.submit(other_work).result(timeout=2)
            finally:
                release.set()
            searching.result(timeout=2)
        assert store.count() == 2
    finally:
        release.set()
        store.close()


def test_history_reader_sees_external_writes_clear_and_restore(tmp_path):
    path = tmp_path / "live.sqlite"
    store = FlowStore(path)
    peer = FlowStore(path)
    source = FlowStore(tmp_path / "source.sqlite")
    try:
        assert store.page_summaries(search="needle")["items"] == []
        peer.upsert(FlowRecord(id="external", response_body=b"needle"))
        assert store.page_summaries(search="needle")["items"][0]["id"] == "external"
        peer.patch_annotation("external", {"bookmarked": True, "annotation_color": "blue"})
        assert store.page_summaries(search="needle", bookmarked_only=True)["items"][0]["bookmarked"]
        peer.clear()
        assert store.page_summaries(search="needle")["items"] == []
        source.upsert(FlowRecord(id="restored", response_body=b"needle"))
        store.restore_database(source.path)
        assert store.page_summaries(search="needle")["items"][0]["id"] == "restored"
    finally:
        source.close()
        peer.close()
        store.close()
