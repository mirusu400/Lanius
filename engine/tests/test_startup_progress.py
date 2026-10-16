"""Startup stage lines for the desktop shell."""

from __future__ import annotations

import json
import sqlite3

from app import startup_progress
from app.db.schema import SCHEMA_VERSION, migrate


def stages(output: str) -> list[dict]:
    return [
        json.loads(line[len(startup_progress.MARKER):])
        for line in output.splitlines()
        if line.startswith(startup_progress.MARKER)
    ]


def test_silent_unless_the_shell_asks(monkeypatch, capsys) -> None:
    monkeypatch.delenv("LANIUS_STARTUP_PROGRESS", raising=False)
    startup_progress.report("database")
    assert capsys.readouterr().out == ""


def test_migrations_report_each_pending_version(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.setenv("LANIUS_STARTUP_PROGRESS", "1")
    conn = sqlite3.connect(tmp_path / "new.sqlite")
    migrate(conn)
    reported = stages(capsys.readouterr().out)
    assert [entry["version"] for entry in reported] == list(range(1, SCHEMA_VERSION + 1))
    assert {entry["stage"] for entry in reported} == {"migrating"}
    assert reported[-1]["target"] == SCHEMA_VERSION
    # An up-to-date database reports nothing.
    migrate(conn)
    assert stages(capsys.readouterr().out) == []
    conn.close()


def test_migration_status_reads_without_upgrading(tmp_path) -> None:
    from app.db.schema import migration_status

    path = tmp_path / "old.sqlite"
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 15")
    conn.commit()
    conn.close()
    status = migration_status(path)
    assert (status["current"], status["target"], status["pending"]) == (15, SCHEMA_VERSION, True)
    assert status["size_bytes"] > 0
    assert migration_status(path)["current"] == 15  # still not upgraded


def test_missing_or_current_database_needs_no_upgrade(tmp_path) -> None:
    from app.db.schema import migration_status

    missing = tmp_path / "missing.sqlite"
    assert migration_status(missing)["pending"] is False
    assert not missing.exists()
    current = tmp_path / "current.sqlite"
    conn = sqlite3.connect(current)
    migrate(conn)
    conn.close()
    assert migration_status(current)["pending"] is False


def test_migration_status_flag_prints_json(tmp_path, monkeypatch, capsys) -> None:
    from app.main import main

    monkeypatch.setenv("LANIUS_DATA_DIR", str(tmp_path))
    conn = sqlite3.connect(tmp_path / "lanius.sqlite")
    conn.execute("PRAGMA user_version = 15")
    conn.commit()
    conn.close()
    main(["--migration-status"])
    assert json.loads(capsys.readouterr().out)["pending"] is True
