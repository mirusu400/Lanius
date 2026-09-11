"""SQLite schema and migrations for Lanius."""

from __future__ import annotations

import sqlite3

SCHEMA_VERSION = 2

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
}


def migrate(conn: sqlite3.Connection) -> int:
    """Apply pending migrations; returns the resulting schema version."""
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    for version in sorted(_MIGRATIONS):
        if version <= current:
            continue
        for statement in _MIGRATIONS[version]:
            conn.execute(statement)
        conn.execute(f"PRAGMA user_version = {version}")
        current = version
    conn.commit()
    return current
