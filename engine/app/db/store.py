"""Flow persistence (SQLite).

All public methods are synchronous and thread-safe; callers running inside the
mitmproxy asyncio loop must go through :mod:`app.db.async_store` (or
``asyncio.to_thread``) so the event loop is never blocked.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from dataclasses import fields as dataclasses_fields
from pathlib import Path
from typing import Any, List

import logging

from .. import charset

logger = logging.getLogger(__name__)

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
        """Full dict with headers and bodies rendered as text-safe values.

        Bodies are read with the charset each message declares. Decoding
        everything as UTF-8 turned a Korean EUC-KR page into replacement
        characters, which cannot be turned back into the original bytes.
        """
        data = asdict(self)
        request_charset = charset.charset_of(
            _content_type(self.request_headers), self.request_body
        )
        response_charset = charset.charset_of(
            _content_type(self.response_headers), self.response_body
        )
        data["request_body"] = (
            None
            if self.request_body is None
            else charset.decode(self.request_body, request_charset)
        )
        data["response_body"] = (
            None
            if self.response_body is None
            else charset.decode(self.response_body, response_charset)
        )
        # So the UI can say how it was read, and reply in the same charset.
        data["request_charset"] = request_charset
        data["response_charset"] = response_charset
        return data


def _record_from_export(data: dict[str, Any]) -> "FlowRecord":
    """Rebuild a record from an exported flow.

    ``detail()`` renders bodies as text so the export stays JSON, so they
    have to be encoded back on the way in. Bytes that were not valid
    UTF-8 were replaced on the way out and cannot be recovered; that is a
    property of a readable export, not a bug to chase.
    """
    fields = {f.name for f in dataclasses_fields(FlowRecord)}
    kwargs = {key: value for key, value in data.items() if key in fields}
    for key in ("request_body", "response_body"):
        value = kwargs.get(key)
        if isinstance(value, str):
            kwargs[key] = value.encode("utf-8")
    for key in ("request_headers", "response_headers"):
        value = kwargs.get(key)
        if isinstance(value, list):
            kwargs[key] = [tuple(pair) for pair in value]
    return FlowRecord(**kwargs)


def _content_type(headers: list[tuple[str, str]] | None) -> str | None:
    for name, value in headers or []:
        if name.lower() == "content-type":
            return value
    return None


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

    # --- workspace (Repeater/Decoder/Intruder state) ----------------------
    def get_workspace(self, key: str) -> Any | None:
        """Saved workspace state, or None if this key was never written."""
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM workspace WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            # Corrupt state must not stop the app from opening.
            logger.warning("discarding unreadable workspace entry %r", key)
            return None

    def set_workspace(self, key: str, value: Any) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO workspace (key, value, updated_at)"
                " VALUES (?, ?, ?)",
                (key, json.dumps(value), time.time()),
            )
            self._conn.commit()

    def all_workspace(self) -> dict[str, Any]:
        """Everything saved, for export."""
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM workspace").fetchall()
        out: dict[str, Any] = {}
        for row in rows:
            try:
                out[row["key"]] = json.loads(row["value"])
            except json.JSONDecodeError:
                continue
        return out

    def clear_workspace(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM workspace")
            self._conn.commit()

    def all_settings(self) -> dict[str, str]:
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def import_project(self, data: dict[str, Any]) -> dict[str, int]:
        """Replace the open project with an exported one.

        Everything happens in one transaction: a half-imported project
        would be worse than a failed import.
        """
        scope = data.get("scope") or []
        workspace = data.get("workspace") or {}
        settings = data.get("settings") or {}
        flows = data.get("flows") or []

        with self._lock:
            with self._conn:  # transaction
                self._conn.execute("DELETE FROM scope_rules")
                self._conn.execute("DELETE FROM workspace")
                if flows:
                    self._conn.execute("DELETE FROM flows")

                for rule in scope:
                    self._conn.execute(
                        "INSERT INTO scope_rules (kind, host, path, protocol,"
                        " port, match_type, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            rule.get("kind", "include"),
                            rule.get("host", "*"),
                            rule.get("path", "*"),
                            rule.get("protocol", "any"),
                            rule.get("port"),
                            rule.get("match_type", "glob"),
                            int(bool(rule.get("enabled", True))),
                        ),
                    )
                now = time.time()
                for key, value in workspace.items():
                    self._conn.execute(
                        "INSERT OR REPLACE INTO workspace (key, value, updated_at)"
                        " VALUES (?, ?, ?)",
                        (key, json.dumps(value), now),
                    )
                for key, value in settings.items():
                    self._conn.execute(
                        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                        (key, str(value)),
                    )

        imported_flows = 0
        for flow in flows:
            try:
                self.upsert(_record_from_export(flow))
                imported_flows += 1
            except Exception:
                # One malformed flow must not abandon the rest.
                logger.warning("skipping an unreadable flow during import")

        return {
            "scope": len(scope),
            "workspace": len(workspace),
            "settings": len(settings),
            "flows": imported_flows,
        }

    def delete_setting(self, key: str) -> None:
        """Remove a setting, so its absence is distinct from an empty value."""
        with self._lock:
            self._conn.execute("DELETE FROM settings WHERE key = ?", (key,))
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
    # --- dashboard aggregates --------------------------------------------
    def dashboard(self, top: int = 8, recent_window: float = 300.0) -> dict[str, Any]:
        """Counts for the dashboard, aggregated in SQL.

        Doing this in the database keeps a large capture from being pulled
        into memory just to be counted.
        """
        with self._lock:
            totals = self._conn.execute(
                "SELECT COUNT(*) AS flows,"
                " COUNT(DISTINCT host) AS hosts,"
                " SUM(COALESCE(request_size, 0) + COALESCE(response_size, 0))"
                "   AS bytes,"
                " AVG(duration_ms) AS avg_ms,"
                " SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,"
                " MIN(started_at) AS first_seen,"
                " MAX(started_at) AS last_seen"
                " FROM flows"
            ).fetchone()

            # Group by hundreds so 2xx/3xx/4xx/5xx fall out directly. A flow
            # still in flight has no status yet, so it is reported separately
            # rather than silently counted as a success.
            status_rows = self._conn.execute(
                "SELECT status_code / 100 AS bucket, COUNT(*) AS count"
                " FROM flows WHERE status_code IS NOT NULL"
                " GROUP BY bucket ORDER BY bucket"
            ).fetchall()
            pending = int(
                self._conn.execute(
                    "SELECT COUNT(*) FROM flows WHERE status_code IS NULL"
                ).fetchone()[0]
            )

            method_rows = self._conn.execute(
                "SELECT method, COUNT(*) AS count FROM flows"
                " WHERE method IS NOT NULL"
                " GROUP BY method ORDER BY count DESC, method"
            ).fetchall()

            host_rows = self._conn.execute(
                "SELECT host, scheme, port, COUNT(*) AS flows,"
                " SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,"
                " SUM(COALESCE(request_size, 0) + COALESCE(response_size, 0))"
                "   AS bytes,"
                " MAX(started_at) AS last_seen"
                " FROM flows WHERE host IS NOT NULL"
                " GROUP BY host ORDER BY flows DESC, host LIMIT ?",
                (top, ),
            ).fetchall()

            cutoff = (totals["last_seen"] or 0.0) - recent_window
            recent = int(
                self._conn.execute(
                    "SELECT COUNT(*) FROM flows WHERE started_at >= ?",
                    (cutoff, ),
                ).fetchone()[0]
            )

        status_groups = {
            f"{int(row['bucket'])}xx": int(row["count"])
            for row in status_rows
            if row["bucket"] is not None
        }

        first_seen = totals["first_seen"]
        last_seen = totals["last_seen"]
        span = (last_seen - first_seen) if (first_seen and last_seen) else 0.0

        return {
            "flows": int(totals["flows"] or 0),
            "hosts": int(totals["hosts"] or 0),
            "bytes": int(totals["bytes"] or 0),
            "avg_duration_ms": (
                round(float(totals["avg_ms"]), 2) if totals["avg_ms"] else None
            ),
            "errors": int(totals["errors"] or 0),
            "pending": pending,
            "first_seen": first_seen,
            "last_seen": last_seen,
            "span_seconds": round(span, 3),
            "recent_flows": recent,
            "recent_window_seconds": recent_window,
            "status_groups": status_groups,
            "methods": [
                {"method": row["method"], "count": int(row["count"])}
                for row in method_rows
            ],
            "top_hosts": [
                {
                    "host": row["host"],
                    "scheme": row["scheme"],
                    "port": row["port"],
                    "flows": int(row["flows"]),
                    "errors": int(row["errors"] or 0),
                    "bytes": int(row["bytes"] or 0),
                    "last_seen": row["last_seen"],
                }
                for row in host_rows
            ],
        }

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
