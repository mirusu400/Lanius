"""SQLite schema and migrations for Lanius."""

from __future__ import annotations

import sqlite3

from .metrics import MIGRATION as METRICS_MIGRATION
from .endpoint_index import MIGRATION as ENDPOINT_MIGRATION, register_functions
from .search_index import MIGRATION as SEARCH_MIGRATION, register_functions as register_search_functions
from .history_index import MIGRATION as HISTORY_MIGRATION

SCHEMA_VERSION = 12

_MIGRATIONS: dict[int, tuple[str, ...]] = {
    1: (
        """
        CREATE TABLE IF NOT EXISTS flows (
            id                  TEXT PRIMARY KEY,
            type                TEXT NOT NULL DEFAULT 'http',
            client_addr         TEXT,
            server_addr         TEXT,
            scheme              TEXT,
            method              TEXT,
            host                TEXT,
            port                INTEGER,
            path                TEXT,
            query               TEXT,
            http_version        TEXT,
            request_headers     TEXT,
            request_body        BLOB,
            request_size        INTEGER DEFAULT 0,
            started_at          REAL,
            status_code         INTEGER,
            reason              TEXT,
            response_headers    TEXT,
            response_body       BLOB,
            response_size       INTEGER DEFAULT 0,
            response_mime       TEXT,
            completed_at        REAL,
            duration_ms         REAL,
            error               TEXT,
            source              TEXT NOT NULL DEFAULT 'proxy',
            comment             TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_flows_started_at ON flows(started_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_flows_host ON flows(host)",
        "CREATE INDEX IF NOT EXISTS idx_flows_status ON flows(status_code)",
        """
        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          REAL NOT NULL,
            level       TEXT NOT NULL DEFAULT 'info',
            message     TEXT NOT NULL
        )
        """,
    ),
    2: (
        """
        CREATE TABLE IF NOT EXISTS scope_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL DEFAULT 'include',
            host        TEXT NOT NULL DEFAULT '*',
            path        TEXT NOT NULL DEFAULT '*',
            protocol    TEXT NOT NULL DEFAULT 'any',
            port        INTEGER,
            match_type  TEXT NOT NULL DEFAULT 'glob',
            enabled     INTEGER NOT NULL DEFAULT 1
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        )
        """,
    ),
    3: (
        # Workspace state: Replay tabs, Decoder tabs, Fuzzer configs.
        # These lived only in the browser, so closing Lanius threw away
        # every request you had been working on.
        """
        CREATE TABLE IF NOT EXISTS workspace (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  REAL NOT NULL
        )
        """,
    ),
    4: (
        # Named payload lists for Fuzzer, so a wordlist is pasted once
        # rather than every time a fuzz run is set up.
        """
        CREATE TABLE IF NOT EXISTS payload_sets (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            payloads    TEXT NOT NULL,
            source      TEXT,
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL
        )
        """,
        # Listed by name in a picker, so that is what the index is for.
        "CREATE INDEX IF NOT EXISTS idx_payload_sets_name ON payload_sets(name)",
    ),
    5: (
        # The request at three points in its lifecycle: as received, after
        # automatic Match & Replace, and the final request in the normal flow
        # columns. Snapshots are only stored when something changed.
        "ALTER TABLE flows ADD COLUMN request_original TEXT",
        "ALTER TABLE flows ADD COLUMN request_auto_modified TEXT",
        "ALTER TABLE flows ADD COLUMN auto_modified INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE flows ADD COLUMN modified INTEGER NOT NULL DEFAULT 0",
    ),
    6: METRICS_MIGRATION,
    7: ENDPOINT_MIGRATION,
    8: SEARCH_MIGRATION + (
        """CREATE TABLE websocket_messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            connection_id TEXT NOT NULL,
            host TEXT NOT NULL,
            path TEXT NOT NULL,
            from_client INTEGER NOT NULL,
            is_text INTEGER NOT NULL,
            timestamp REAL NOT NULL,
            content BLOB NOT NULL,
            injected INTEGER NOT NULL,
            dropped INTEGER NOT NULL,
            paused INTEGER NOT NULL
        )""",
        "CREATE INDEX idx_websocket_messages_connection ON websocket_messages(connection_id, seq DESC)",
        "CREATE INDEX idx_websocket_messages_paused ON websocket_messages(paused) WHERE paused = 1",
    ),
    9: (
        """
        CREATE TABLE IF NOT EXISTS issues (
            id              TEXT PRIMARY KEY,
            fingerprint     TEXT NOT NULL UNIQUE,
            plugin_id       TEXT NOT NULL,
            check_id        TEXT NOT NULL,
            scan_mode       TEXT NOT NULL,
            title           TEXT NOT NULL,
            severity        TEXT NOT NULL,
            confidence      TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'open',
            detail          TEXT NOT NULL,
            remediation     TEXT,
            url             TEXT,
            host            TEXT,
            path            TEXT,
            parameter       TEXT,
            flow_id         TEXT,
            evidence        TEXT,
            first_seen      REAL NOT NULL,
            last_seen       REAL NOT NULL,
            occurrences     INTEGER NOT NULL DEFAULT 1
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_issues_status_severity ON issues(status, severity)",
        "CREATE INDEX IF NOT EXISTS idx_issues_host ON issues(host)",
        "CREATE INDEX IF NOT EXISTS idx_issues_last_seen ON issues(last_seen DESC)",
    ),
    10: (
        """CREATE TABLE flow_annotations (
            flow_id TEXT PRIMARY KEY,
            bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0, 1)),
            color TEXT CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple'))
        )""",
        "CREATE INDEX idx_flow_annotations_bookmarked ON flow_annotations(bookmarked) WHERE bookmarked = 1",
        "CREATE INDEX idx_flow_annotations_color ON flow_annotations(color) WHERE color IS NOT NULL",
        """CREATE TRIGGER flow_annotations_cleanup AFTER DELETE ON flows BEGIN
            DELETE FROM flow_annotations WHERE flow_id = old.id;
        END""",
    ),
    11: (
        # Address on the actual upstream socket, before any NAT or VPN
        # translation. Existing captures cannot be reconstructed.
        "ALTER TABLE flows ADD COLUMN local_source_ip TEXT",
    ),
    12: HISTORY_MIGRATION,
}


def migrate(conn: sqlite3.Connection) -> int:
    """Apply pending migrations; returns the resulting schema version."""
    register_functions(conn)
    register_search_functions(conn)
    conn.execute("PRAGMA recursive_triggers=ON")
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    for version in sorted(_MIGRATIONS):
        if version <= current:
            continue
        # A large existing capture can take seconds to backfill. Keep each
        # version atomic so a crash cannot leave half-created summary tables
        # while user_version still points to the older schema.
        conn.execute("SAVEPOINT lanius_migration")
        try:
            for statement in _MIGRATIONS[version]:
                conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {version}")
            conn.execute("RELEASE SAVEPOINT lanius_migration")
        except Exception:
            conn.execute("ROLLBACK TO SAVEPOINT lanius_migration")
            conn.execute("RELEASE SAVEPOINT lanius_migration")
            raise
        current = version
    conn.commit()
    return current
