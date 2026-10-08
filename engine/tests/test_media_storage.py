from __future__ import annotations

import pytest
from pathlib import Path
from mitmproxy.test import tflow, tutils

from app.addons.capture import CaptureAddon
from app.db.store import FlowRecord, FlowStore, RequestSnapshot
from app.events import EventBroker
from app.media_storage import MEDIA_BODY_LIMIT_SETTING, MIB, is_media
from app.addons.replay import render_raw


@pytest.mark.parametrize("mime,path,expected", [
    ("Image/PNG; charset=binary", "/blob", True), ("audio/mpeg", "/blob", True),
    ("video/mp4", "/blob", True), ("application/ogg", "/blob", True),
    ("application/octet-stream", "/clip.MP4?token=1", True), ("", "/pic%2Epng", True),
    ("text/html", "/clip.mp4", False), ("application/json", "/blob", False),
    ("application/octet-stream", "/installer.exe", False),
])
def test_media_classification(mime, path, expected):
    assert is_media([("Content-Type", mime)], path) is expected


@pytest.mark.parametrize("delta,omitted", [(-1, False), (0, True), (1, True)])
def test_threshold_uses_actual_body_bytes_and_keeps_metadata(tmp_path, delta, omitted):
    store = FlowStore(tmp_path / "capture.sqlite")
    body = b"x" * (5 * MIB + delta)
    record = FlowRecord(id="media", path="/video", response_mime="video/mp4", response_headers=[("Content-Length", "1")],
                        response_body=body, response_size=len(body), status_code=200)
    try:
        store.upsert(record)
        saved = store.get("media")
        assert saved.response_body_omitted is omitted
        assert saved.response_body == (b"" if omitted else body)
        assert saved.response_size == len(body) and saved.status_code == 200
        assert saved.response_headers == record.response_headers
        assert store.page_summaries()["items"][0]["response_body_omitted"] is omitted
        # Storage filtering never mutates the record used by live traffic.
        assert record.response_body == body and not record.response_body_omitted
        if omitted:
            assert store.get_body_bytes("media", "response") is None
            assert "xxxxx" not in store._conn.execute("SELECT text FROM flow_search").fetchone()[0]
            assert (tmp_path / "capture.sqlite").stat().st_size + (tmp_path / "capture.sqlite-wal").stat().st_size < MIB
    finally:
        store.close()


def test_limit_applies_to_uploads_and_modified_request_snapshots_and_can_be_disabled(tmp_path):
    path = tmp_path / "capture.sqlite"
    store = FlowStore(path)
    store.set_setting(MEDIA_BODY_LIMIT_SETTING, "1")
    body = b"x" * MIB
    headers = [("Content-Type", "image/png")]
    snapshot = RequestSnapshot(method="POST", scheme="https", host="upload.test", port=443, path="/upload",
                               http_version="HTTP/1.1", headers=headers, body=body)
    record = FlowRecord(id="upload", request_headers=headers, request_body=body, request_size=len(body),
                        request_original=snapshot, request_auto_modified=snapshot, modified=True)
    try:
        store.upsert(record)
        saved = store.get("upload")
        assert saved.request_body_omitted and saved.request_body == b""
        assert saved.request_original.body_omitted and saved.request_original.body_size == len(body)
        assert saved.request_auto_modified.body == b""
        assert saved.detail()["request_variants"]["original"]["body_omitted"]
        assert snapshot.body == body
        store.set_setting(MEDIA_BODY_LIMIT_SETTING, "0")
        store.upsert(record)
        assert store.get_body_bytes("upload", "request") == body
        assert not store.get("upload").request_body_omitted
    finally:
        store.close()
    reopened = FlowStore(path)
    assert reopened.media_body_limit_mb == 0
    reopened.close()


def test_non_media_and_raw_tcp_bodies_are_preserved():
    store = FlowStore()
    store.set_setting(MEDIA_BODY_LIMIT_SETTING, "1")
    body = b"x" * MIB
    try:
        for kind, mime in [("http", "text/html"), ("http", "application/json"), ("tcp", "video/mp4")]:
            store.upsert(FlowRecord(id=kind+mime, type=kind, response_body=body, response_mime=mime))
            assert store.get_body_bytes(kind+mime, "response") == body
    finally:
        store.close()


@pytest.mark.asyncio
async def test_capture_events_report_omission_and_forwarded_bytes_are_untouched():
    store = FlowStore()
    store.set_setting(MEDIA_BODY_LIMIT_SETTING, "1")
    broker = EventBroker()
    queue = broker.subscribe()
    addon = CaptureAddon(store, broker)
    body = b"x" * MIB
    flow = tflow.tflow(req=tutils.treq(), resp=tutils.tresp(content=body))
    flow.response.headers["Content-Type"] = "video/mp4"
    try:
        addon.response(flow)
        await addon.done()
        event = await queue.get()
        assert event["data"]["response_body_omitted"] is True
        assert flow.response.raw_content == body
        assert store.get(flow.id).response_body == b""
    finally:
        store.close()


def test_omitted_compressed_bodies_do_not_report_decode_errors():
    store = FlowStore()
    store.set_setting(MEDIA_BODY_LIMIT_SETTING, "1")
    headers = [("Content-Type", "image/png"), ("Content-Encoding", "gzip")]
    snapshot = RequestSnapshot(method="POST", scheme="http", host="media.test", port=80,
                               path="/image", http_version="HTTP/1.1", headers=headers, body=b"x" * MIB)
    try:
        store.upsert(FlowRecord(id="compressed", request_headers=headers, request_body=b"x" * MIB,
                                response_headers=headers, response_body=b"x" * MIB,
                                request_original=snapshot, modified=True))
        saved = store.get("compressed")
        detail = saved.detail(auto_decompress=True)
        assert detail["request_decode_error"] is None
        assert detail["response_decode_error"] is None
        assert detail["request_variants"]["original"]["decode_error"] is None
        assert render_raw(saved)["decode_error"] is None
        assert render_raw(saved)["body_omitted"] is True
    finally:
        store.close()


@pytest.mark.parametrize("kind", ["json", "sqlite"])
def test_import_restores_limit_without_trimming_existing_media(tmp_path, kind):
    source = FlowStore(tmp_path / "source.sqlite")
    target = FlowStore(tmp_path / "target.sqlite")
    body = b"x" * MIB
    try:
        source.set_setting(MEDIA_BODY_LIMIT_SETTING, "0")
        source.upsert(FlowRecord(id="old-media", response_body=body, response_mime="image/png"))
        source.set_setting(MEDIA_BODY_LIMIT_SETTING, "1")
        if kind == "json":
            target.import_project({"settings": source.all_settings(), "flows": [source.get("old-media").detail()]})
        else:
            backup = Path(source.backup_database())
            try:
                target.restore_database(backup)
            finally:
                backup.unlink()
        assert target.media_body_limit_mb == 1
        assert target.get_body_bytes("old-media", "response") == body
        target.upsert(FlowRecord(id="new-media", response_body=body, response_mime="image/png"))
        assert target.get("new-media").response_body_omitted
        target.delete_setting(MEDIA_BODY_LIMIT_SETTING)
        assert target.media_body_limit_mb == 5
    finally:
        source.close()
        target.close()
