from __future__ import annotations

import hashlib
import sqlite3

import pytest

from app.db.database_import import prepare_database
from app.db.schema import SCHEMA_VERSION
from app.db.store import FlowRecord, FlowStore
from app.lockdown import PROJECT_SETTING
from app.tls_trust import TRUSTED_CA_SETTING


def make_backup(path):
    store = FlowStore(path)
    store.upsert(FlowRecord(
        id="raw", method="GET", host="imported.test", scheme="https", port=443,
        path="/raw", request_body=b"\xff\x00request", response_body=b"\xfe\x00response",
        started_at=1, status_code=200,
    ))
    store.set_workspace("decoder", [{"id": "d", "input": "saved payload"}])
    store.payload_sets.save(name="saved list", payloads=["one", "two"])
    store.patch_annotation("raw", {"bookmarked": True, "annotation_color": "blue"})
    store.append_websocket_message({
        "id": "ws", "connection_id": "c", "host": "imported.test", "path": "/ws",
        "from_client": True, "is_text": False, "timestamp": 1,
        "injected": False, "dropped": False, "paused": True,
    }, b"\xff\x01frame")
    return store


def test_restore_keeps_raw_bodies_websockets_tabs_marks_and_payload_store_handles(tmp_path):
    path = tmp_path / "backup.sqlite"
    source = make_backup(path)
    source.close()
    before = hashlib.sha256(path.read_bytes()).digest()
    prepared = prepare_database(path)
    current = FlowStore(tmp_path / "current.sqlite")
    current.upsert(FlowRecord(id="old"))
    payloads = current.payload_sets
    try:
        current.restore_database(prepared.path)
        assert current.get("old") is None
        assert current.get_body_bytes("raw", "request") == b"\xff\x00request"
        assert current.get_body_bytes("raw", "response") == b"\xfe\x00response"
        assert current.get_websocket_message_bytes("ws") == b"\xff\x01frame"
        message = current.page_websocket_messages()["items"][0]
        assert message["paused"] is False and message["dropped"] is True
        assert current.get_workspace("decoder") == [{"id": "d", "input": "saved payload"}]
        assert current.get_annotation("raw")["annotation_color"] == "blue"
        assert payloads.list()[0].name == "saved list"
        assert current.page_summaries()["items"][0]["id"] == "raw"
        # New writes still use the registered SQLite functions and triggers.
        current.upsert(FlowRecord(id="new", started_at=2, method="POST"))
        assert current.page_summaries()["items"][0]["id"] == "new"
        assert hashlib.sha256(path.read_bytes()).digest() == before
    finally:
        current.close()
        prepared.cleanup()


@pytest.mark.parametrize("version", [11, 12])
def test_older_backup_is_upgraded_on_a_copy(tmp_path, version):
    path = tmp_path / "v11.sqlite"
    source = make_backup(path)
    with source._conn:
        for trigger in ("flow_history_insert", "flow_history_delete", "flow_history_update"):
            source._conn.execute(f"DROP TRIGGER {trigger}")
        source._conn.execute("DROP TABLE flow_history")
        source._conn.execute("ALTER TABLE flows DROP COLUMN request_body_omitted")
        source._conn.execute("ALTER TABLE flows DROP COLUMN response_body_omitted")
        if version == 12:
            from app.db.history_index import MIGRATION
            for statement in MIGRATION:
                source._conn.execute(statement)
        source._conn.execute(f"PRAGMA user_version={version}")
    source.close()
    prepared = prepare_database(path)
    try:
        with sqlite3.connect(prepared.path) as conn:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
            assert conn.execute("SELECT id FROM flow_history").fetchone()[0] == "raw"
        with sqlite3.connect(path) as conn:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == version
    finally:
        prepared.cleanup()


@pytest.mark.parametrize("version", [0, SCHEMA_VERSION + 1])
def test_rejects_unrelated_or_future_databases(tmp_path, version):
    path = tmp_path / "other.sqlite"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE unrelated(value TEXT)")
        conn.execute(f"PRAGMA user_version={version}")
    with pytest.raises(ValueError, match="not a supported Lanius"):
        prepare_database(path)


def test_rejects_modified_core_triggers_before_restoration(tmp_path):
    path = tmp_path / "modified.sqlite"
    source = make_backup(path)
    with source._conn:
        source._conn.execute("CREATE TRIGGER unexpected AFTER INSERT ON settings BEGIN DELETE FROM flows; END")
    source.close()
    with pytest.raises(ValueError, match="unsupported SQLite schema object"):
        prepare_database(path)


@pytest.mark.parametrize("trusted_ca", [None, "current approved CA"])
def test_restore_preserves_current_trust_and_enabled_lockdown(tmp_path, trusted_ca):
    path = tmp_path / "backup.sqlite"
    source = make_backup(path)
    source.set_setting(TRUSTED_CA_SETTING, "unapproved imported CA")
    source.set_setting(PROJECT_SETTING, "0")
    source.close()
    prepared = prepare_database(path)
    current = FlowStore(tmp_path / "current.sqlite")
    current.set_setting(PROJECT_SETTING, "1")
    if trusted_ca is not None:
        current.set_setting(TRUSTED_CA_SETTING, trusted_ca)
    try:
        current.restore_database(prepared.path, preserve_settings=(TRUSTED_CA_SETTING,), keep_enabled=(PROJECT_SETTING,))
        assert current.get_setting(TRUSTED_CA_SETTING) == trusted_ca
        assert current.get_setting(PROJECT_SETTING) == "1"
    finally:
        current.close()
        prepared.cleanup()
