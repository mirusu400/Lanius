"""SQLite schema and migrations for Lanius."""

from __future__ import annotations

import sqlite3

from .metrics import MIGRATION as METRICS_MIGRATION
from .endpoint_index import MIGRATION as ENDPOINT_MIGRATION, register_functions
from .search_index import MIGRATION as SEARCH_MIGRATION, register_functions as register_search_functions

SCHEMA_VERSION = 8

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
        # Workspace state: Repeater tabs, Decoder tabs, Intruder configs.
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
        # Named payload lists for Intruder, so a wordlist is pasted once
        # rather than every time an attack is set up.
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
