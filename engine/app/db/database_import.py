"""Validate and upgrade a SQLite backup before replacing an open project."""

from __future__ import annotations

import contextlib
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .schema import SCHEMA_VERSION, _MIGRATIONS, migrate, register_functions, register_search_functions

SQLITE_HEADER = b"SQLite format 3\x00"


@dataclass
class PreparedDatabase:
    path: Path
    settings: dict[str, str]
    counts: dict[str, int]

    def cleanup(self) -> None:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(str(self.path) + suffix).unlink(missing_ok=True)


def _schema(conn: sqlite3.Connection) -> dict[str, tuple[str, str, str]]:
    return {
        name: (kind, table, " ".join(sql.split()))
        for name, kind, table, sql in conn.execute(
            "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL"
        )
        if not name.startswith("sqlite_")
    }


def _validate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if not 1 <= version <= SCHEMA_VERSION:
        raise ValueError(f"not a supported Lanius SQLite backup (schema version {version})")
    if conn.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise ValueError("the SQLite backup is corrupt or incomplete")
    # Only the known project schema may govern writes after restoration.
    # In particular, do not accept changed or additional triggers on our tables.
    with contextlib.closing(sqlite3.connect(":memory:")) as reference:
        register_functions(reference)
        register_search_functions(reference)
        for migration in range(1, version + 1):
            for statement in _MIGRATIONS[migration]:
                reference.execute(statement)
        expected = _schema(reference)
    actual = _schema(conn)
    for name, definition in expected.items():
        if actual.get(name) != definition:
            raise ValueError(f"not a recognized Lanius SQLite schema: {name}")
    core_tables = {table for kind, table, _ in expected.values() if kind == "table"}
    for name, (kind, table, _) in actual.items():
        if name not in expected and (kind in {"trigger", "view"} or table in core_tables and kind != "index"):
            raise ValueError(f"unsupported SQLite schema object: {name}")


def prepare_database(path: str | Path) -> PreparedDatabase:
    """Read-only input; all migration work happens on a private temporary copy."""
    with tempfile.NamedTemporaryFile(prefix="lanius_restore_", suffix=".sqlite", delete=False) as file:
        staged = Path(file.name)
    prepared = PreparedDatabase(staged, {}, {})
    try:
        # Uploads are standalone snapshots: do not create WAL/SHM sidecars.
        uri = Path(path).resolve().as_uri() + "?mode=ro&immutable=1"
        with contextlib.closing(sqlite3.connect(uri, uri=True)) as source:
            source.execute("PRAGMA query_only=ON")
            _validate(source)
            with contextlib.closing(sqlite3.connect(staged)) as target:
                source.backup(target)
                migrate(target)
                # IF NOT EXISTS migrations can silently keep a preexisting
                # table with the right name but incompatible columns.
                _validate(target)
                # Old held frames have no live connection to resume.
                target.execute("UPDATE websocket_messages SET paused=0, dropped=1 WHERE paused=1")
                target.commit()
                prepared.settings = dict(target.execute("SELECT key, value FROM settings"))
                prepared.counts = {
                    key: target.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    for key, table in {
                        "flows": "flow_history", "scope": "scope_rules", "workspace": "workspace",
                        "settings": "settings", "issues": "issues", "websockets": "websocket_messages",
                    }.items()
                }
        return prepared
    except Exception:
        prepared.cleanup()
        raise
