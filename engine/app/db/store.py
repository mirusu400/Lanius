"""Flow persistence (SQLite).

All public methods are synchronous and thread-safe; callers running inside the
mitmproxy asyncio loop must go through :mod:`app.db.async_store` (or
``asyncio.to_thread``) so the event loop is never blocked.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, List

from .schema import migrate

MAX_BODY_BYTES = 5 * 1024 * 1024


@dataclass(slots=True)
class FlowRecord:
    """A captured flow (request, and optionally response)."""

    id: str
    type: str = "http"
    client_addr: str | None = None
    server_addr: str | None = None
    scheme: str | None = None
    method: str | None = None
    host: str | None = None
    port: int | None = None
    path: str | None = None
    query: str | None = None
    http_version: str | None = None
    request_headers: list[tuple[str, str]] = field(default_factory=list)
    request_body: bytes = b""
    request_size: int = 0
    started_at: float | None = None
    status_code: int | None = None
    reason: str | None = None
    response_headers: list[tuple[str, str]] | None = None
    response_body: bytes | None = None
    response_size: int = 0
    response_mime: str | None = None
    completed_at: float | None = None
    duration_ms: float | None = None
    error: str | None = None
    source: str = "proxy"
    comment: str | None = None

    def summary(self) -> dict[str, Any]:
        """Lightweight dict for list views / WS events (no bodies)."""
        data = asdict(self)
        data.pop("request_body", None)
        data.pop("response_body", None)
        data.pop("request_headers", None)
        data.pop("response_headers", None)
        return data

    def detail(self) -> dict[str, Any]:
        """Full dict with headers and bodies rendered as text-safe values."""
        data = asdict(self)
        data["request_body"] = _decode(self.request_body)
        data["response_body"] = _decode(self.response_body)
        return data


def _decode(body: bytes | None) -> str | None:
    if body is None:
        return None
    return body.decode("utf-8", errors="replace")


def _dump_headers(headers: Iterable[tuple[str, str]] | None) -> str | None:
    if headers is None:
        return None
    return json.dumps([list(h) for h in headers])


def _load_headers(raw: str | None) -> list[tuple[str, str]] | None:
    if raw is None:
        return None
    return [(k, v) for k, v in json.loads(raw)]


_COLUMNS = (
    "id, type, client_addr, server_addr, scheme, method, host, port, path, query,"
    " http_version, request_headers, request_body, request_size, started_at,"
    " status_code, reason, response_headers, response_body, response_size,"
    " response_mime, completed_at, duration_ms, error, source, comment"
)


class FlowStore:
    """Thread-safe SQLite-backed flow store."""

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        migrate(self._conn)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- writes -----------------------------------------------------------
    def upsert(self, record: FlowRecord) -> None:
        values = (
            record.id,
            record.type,
            record.client_addr,
            record.server_addr,
            record.scheme,
            record.method,
            record.host,
            record.port,
            record.path,
            record.query,
            record.http_version,
            _dump_headers(record.request_headers),
            _truncate(record.request_body),
            record.request_size,
            record.started_at,
            record.status_code,
            record.reason,
            _dump_headers(record.response_headers),
            _truncate(record.response_body),
            record.response_size,
            record.response_mime,
            record.completed_at,
            record.duration_ms,
            record.error,
            record.source,
            record.comment,
        )
        placeholders = ", ".join(["?"] * len(values))
        with self._lock:
            self._conn.execute(
                f"INSERT OR REPLACE INTO flows ({_COLUMNS}) VALUES ({placeholders})",
                values,
            )
            self._conn.commit()

    def log_event(self, ts: float, level: str, message: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO events (ts, level, message) VALUES (?, ?, ?)",
                (ts, level, message),
            )
            self._conn.commit()

    def clear(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM flows")
            self._conn.commit()

    # --- reads ------------------------------------------------------------
    def get(self, flow_id: str) -> FlowRecord | None:
        with self._lock:
            row = self._conn.execute(
                f"SELECT {_COLUMNS} FROM flows WHERE id = ?", (flow_id,)
            ).fetchone()
        return _row_to_record(row) if row else None

    def list(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        host: str | None = None,
        method: str | None = None,
        status_code: int | None = None,
        search: str | None = None,
    ) -> List[FlowRecord]:
        clauses: list[str] = []
        params: list[Any] = []
        if host:
            clauses.append("host LIKE ?")
            params.append(f"%{host}%")
        if method:
            clauses.append("method = ?")
            params.append(method.upper())
        if status_code is not None:
            clauses.append("status_code = ?")
            params.append(status_code)
        if search:
            clauses.append("(path LIKE ? OR query LIKE ? OR host LIKE ?)")
            params.extend([f"%{search}%"] * 3)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([limit, offset])
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {_COLUMNS} FROM flows {where}"
                " ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?",
                params,
            ).fetchall()
        return [_row_to_record(row) for row in rows]

    def count(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) FROM flows").fetchone()[0])

    # --- scope rules (M4) -------------------------------------------------
    def list_scope_rules(self) -> List[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, kind, host, path, protocol, port, match_type, enabled"
                " FROM scope_rules ORDER BY id"
            ).fetchall()
        return [
            {
                "id": row["id"],
                "kind": row["kind"],
                "host": row["host"],
                "path": row["path"],
                "protocol": row["protocol"],
                "port": row["port"],
                "match_type": row["match_type"],
                "enabled": bool(row["enabled"]),
            }
            for row in rows
        ]

    def add_scope_rule(self, rule: dict[str, Any]) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO scope_rules (kind, host, path, protocol, port,"
                " match_type, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    rule["kind"],
                    rule["host"],
                    rule["path"],
                    rule["protocol"],
                    rule["port"],
                    rule["match_type"],
                    int(rule["enabled"]),
                ),
            )
            self._conn.commit()
            return int(cursor.lastrowid or 0)

    def update_scope_rule(self, rule_id: int, changes: dict[str, Any]) -> bool:
        allowed = {
            "kind",
            "host",
            "path",
            "protocol",
            "port",
            "match_type",
            "enabled",
        }
        fields = {k: v for k, v in changes.items() if k in allowed}
        if not fields:
            return False
        assignments = ", ".join(f"{k} = ?" for k in fields)
        values: list[Any] = [
            int(v) if k == "enabled" else v for k, v in fields.items()
        ]
        values.append(rule_id)
        with self._lock:
            cursor = self._conn.execute(
                f"UPDATE scope_rules SET {assignments} WHERE id = ?", values
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def delete_scope_rule(self, rule_id: int) -> bool:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM scope_rules WHERE id = ?", (rule_id,)
            )
            self._conn.commit()
            return cursor.rowcount > 0

    # --- settings ---------------------------------------------------------
    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )
            self._conn.commit()

    def list_events(self, limit: int = 200) -> List[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, ts, level, message FROM events"
                " ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    # --- sitemap / endpoints (M4) -----------------------------------------
    def distinct_sites(self) -> List[dict[str, Any]]:
        """One row per (scheme, host, port) with flow counts."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT scheme, host, port, COUNT(*) AS flows,"
                " COUNT(DISTINCT path) AS paths, MAX(started_at) AS last_seen"
                " FROM flows WHERE host IS NOT NULL"
                " GROUP BY scheme, host, port ORDER BY host"
            ).fetchall()
        return [dict(row) for row in rows]

    def distinct_paths_for_site(
        self, scheme: str, host: str, port: int | None
    ) -> List[str]:
        """Distinct paths for one site (used for scope evaluation)."""
        clauses = ["host = ?", "scheme = ?"]
        params: list[Any] = [host, scheme]
        if port is not None:
            clauses.append("port = ?")
            params.append(port)
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT path FROM flows"
                f" WHERE {' AND '.join(clauses)} AND path IS NOT NULL",
                params,
            ).fetchall()
        return [row["path"] for row in rows]

    def paths_for_site(
        self, scheme: str, host: str, port: int | None
    ) -> List[dict[str, Any]]:
        clauses = ["host = ?", "scheme = ?"]
        params: list[Any] = [host, scheme]
        if port is not None:
            clauses.append("port = ?")
            params.append(port)
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, method, path, query, status_code, response_size,"
                " started_at FROM flows"
                f" WHERE {' AND '.join(clauses)}"
                " ORDER BY path, method",
                params,
            ).fetchall()
        return [dict(row) for row in rows]


def _truncate(body: bytes | None) -> bytes | None:
    if body is None:
        return None
    return body[:MAX_BODY_BYTES]


def _row_to_record(row: sqlite3.Row) -> FlowRecord:
    return FlowRecord(
        id=row["id"],
        type=row["type"],
        client_addr=row["client_addr"],
        server_addr=row["server_addr"],
        scheme=row["scheme"],
        method=row["method"],
        host=row["host"],
        port=row["port"],
        path=row["path"],
        query=row["query"],
        http_version=row["http_version"],
        request_headers=_load_headers(row["request_headers"]) or [],
        request_body=row["request_body"] or b"",
        request_size=row["request_size"] or 0,
        started_at=row["started_at"],
        status_code=row["status_code"],
        reason=row["reason"],
        response_headers=_load_headers(row["response_headers"]),
        response_body=row["response_body"],
        response_size=row["response_size"] or 0,
        response_mime=row["response_mime"],
        completed_at=row["completed_at"],
        duration_ms=row["duration_ms"],
        error=row["error"],
        source=row["source"],
        comment=row["comment"],
    )
