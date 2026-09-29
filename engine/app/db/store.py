"""Flow persistence (SQLite).

All public methods are synchronous and thread-safe; callers running inside the
mitmproxy asyncio loop must go through :mod:`app.db.async_store` (or
``asyncio.to_thread``) so the event loop is never blocked.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from dataclasses import fields as dataclasses_fields
from pathlib import Path
from typing import Any, List, Sequence

import logging

from .. import charset
from ..content_encoding import body_for_display

logger = logging.getLogger(__name__)

from .schema import migrate
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .payloads import PayloadSetStore

MAX_BODY_BYTES = 5 * 1024 * 1024


@dataclass(slots=True)
class RequestSnapshot:
    """A request as it existed at one point in the proxy pipeline."""

    method: str
    scheme: str
    host: str
    port: int
    path: str
    http_version: str
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: bytes = b""

    @classmethod
    def from_mapping(cls, value: dict[str, Any]) -> "RequestSnapshot":
        return cls(
            method=str(value.get("method") or "GET"),
            scheme=str(value.get("scheme") or "http"),
            host=str(value.get("host") or ""),
            port=int(value.get("port") or 80),
            path=str(value.get("path") or "/"),
            http_version=str(value.get("http_version") or "HTTP/1.1"),
            headers=[tuple(item) for item in value.get("headers", [])],
            body=bytes(value.get("body") or b""),
        )

    def detail(self, *, auto_decompress: bool) -> dict[str, Any]:
        shown, content_encoding, decoded, decode_error = body_for_display(
            self.headers, self.body, enabled=auto_decompress
        )
        content_type = _content_type(self.headers)
        body_charset = charset.charset_of(content_type, shown)
        return {
            "method": self.method,
            "scheme": self.scheme,
            "host": self.host,
            "port": self.port,
            "path": self.path,
            "http_version": self.http_version,
            "headers": self.headers,
            "body": charset.decode(shown, body_charset),
            "charset": body_charset,
            "content_encoding": content_encoding,
            "body_decoded": decoded,
            "decode_error": decode_error,
        }


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
    request_original: RequestSnapshot | None = None
    request_auto_modified: RequestSnapshot | None = None
    auto_modified: bool = False
    modified: bool = False

    def summary(self) -> dict[str, Any]:
        """Lightweight dict for list views / WS events (no bodies)."""
        data = asdict(self)
        data.pop("request_body", None)
        data.pop("response_body", None)
        data.pop("request_headers", None)
        data.pop("response_headers", None)
        data.pop("request_original", None)
        data.pop("request_auto_modified", None)
        return data

    def detail(self, *, auto_decompress: bool = False) -> dict[str, Any]:
        """Full dict with headers and bodies rendered as text-safe values.

        Bodies are read with the charset each message declares. Decoding
        everything as UTF-8 turned a Korean EUC-KR page into replacement
        characters, which cannot be turned back into the original bytes.
        """
        data = asdict(self)
        data.pop("request_original", None)
        data.pop("request_auto_modified", None)
        request_display, request_encoding, request_decoded, request_error = (
            body_for_display(
                self.request_headers,
                self.request_body,
                enabled=auto_decompress,
            )
        )
        response_display, response_encoding, response_decoded, response_error = (
            body_for_display(
                self.response_headers,
                self.response_body,
                enabled=auto_decompress,
            )
        )
        request_charset = charset.charset_of(
            _content_type(self.request_headers), request_display
        )
        response_charset = charset.charset_of(
            _content_type(self.response_headers), response_display
        )
        data["request_body"] = (
            None
            if request_display is None
            else charset.decode(request_display, request_charset)
        )
        data["response_body"] = (
            None
            if response_display is None
            else charset.decode(response_display, response_charset)
        )
        # So the UI can say how it was read, and reply in the same charset.
        data["request_charset"] = request_charset
        data["response_charset"] = response_charset
        data["request_content_encoding"] = request_encoding
        data["response_content_encoding"] = response_encoding
        data["request_body_decoded"] = request_decoded
        data["response_body_decoded"] = response_decoded
        data["request_decode_error"] = request_error
        data["response_decode_error"] = response_error
        data["request_variants"] = None
        if self.modified and self.request_original is not None:
            final = RequestSnapshot(
                method=self.method or "GET",
                scheme=self.scheme or "http",
                host=self.host or "",
                port=self.port or (443 if self.scheme == "https" else 80),
                path=(self.path or "/") + (f"?{self.query}" if self.query else ""),
                http_version=self.http_version or "HTTP/1.1",
                headers=self.request_headers,
                body=self.request_body,
            )
            automatic = self.request_auto_modified or self.request_original
            data["request_variants"] = {
                "original": self.request_original.detail(
                    auto_decompress=auto_decompress
                ),
                "auto_modified": automatic.detail(
                    auto_decompress=auto_decompress
                ),
                "modified": final.detail(auto_decompress=auto_decompress),
            }
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
    for key in ("request_original", "request_auto_modified"):
        value = kwargs.get(key)
        if isinstance(value, dict):
            body = value.get("body", "")
            value["body"] = body.encode("utf-8") if isinstance(body, str) else body
            kwargs[key] = RequestSnapshot.from_mapping(value)
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


def _dump_snapshot(snapshot: RequestSnapshot | None) -> str | None:
    if snapshot is None:
        return None
    data = asdict(snapshot)
    data["body"] = base64.b64encode(snapshot.body).decode("ascii")
    return json.dumps(data, ensure_ascii=False)


def _load_snapshot(raw: str | None) -> RequestSnapshot | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
        data["body"] = base64.b64decode(data.get("body") or "", validate=True)
        return RequestSnapshot.from_mapping(data)
    except (TypeError, ValueError, json.JSONDecodeError):
        logger.warning("discarding unreadable request snapshot")
        return None


_COLUMNS = (
    "id, type, client_addr, server_addr, scheme, method, host, port, path, query,"
    " http_version, request_headers, request_body, request_size, started_at,"
    " status_code, reason, response_headers, response_body, response_size,"
    " response_mime, completed_at, duration_ms, error, source, comment,"
    " request_original, request_auto_modified, auto_modified, modified"
)

_SUMMARY_COLUMNS = (
    "id, type, client_addr, server_addr, scheme, method, host, port, path, query,"
    " http_version, request_size, started_at, status_code, reason, response_size,"
    " response_mime, completed_at, duration_ms, error, source, comment,"
    " auto_modified, modified"
)


def _like_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


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
        self._conn.execute("PRAGMA recursive_triggers=ON")
        self._payload_sets: "PayloadSetStore | None" = None
        self._conn.execute("PRAGMA synchronous=NORMAL")
        migrate(self._conn)
        # WAL allows capture writes to commit while a reader holds a snapshot.
        # An in-memory store cannot be reopened, so tests share its connection.
        self._read_lock = threading.RLock() if self.path != ":memory:" else self._lock
        if self.path == ":memory:":
            self._read_conn = self._conn
        else:
            uri = Path(self.path).resolve().as_uri() + "?mode=ro"
            self._read_conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
            self._read_conn.row_factory = sqlite3.Row
            self._read_conn.execute("PRAGMA query_only=ON")

    def close(self) -> None:
        if self._read_conn is not self._conn:
            with self._read_lock:
                self._read_conn.close()
        with self._lock:
            self._conn.close()

    # --- writes -----------------------------------------------------------
    def upsert(self, record: FlowRecord) -> None:
        with self._lock:
            self._upsert_uncommitted(record)
            self._conn.commit()

    def _upsert_uncommitted(self, record: FlowRecord) -> None:
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
            _dump_snapshot(record.request_original),
            _dump_snapshot(record.request_auto_modified),
            int(record.auto_modified),
            int(record.modified),
        )
        placeholders = ", ".join(["?"] * len(values))
        self._conn.execute(
            f"INSERT OR REPLACE INTO flows ({_COLUMNS}) VALUES ({placeholders})",
            values,
        )

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

    def delete(self, flow_ids: Sequence[str]) -> int:
        """Remove flows by id. Returns how many rows went."""
        return self.delete_selection(flow_ids, [])

    def delete_by_prefix(
        self,
        *,
        host: str | None = None,
        port: int | None = None,
        port_is_null: bool = False,
        scheme: str | None = None,
        path_prefix: str | None = None,
    ) -> int:
        """Remove everything under a host, or under a path on that host.

        What the site map's folders stand for. Deleting a subtree one id
        at a time would mean shipping thousands of ids to say something
        the database can work out itself.
        """
        if not any((host, port is not None, port_is_null, scheme, path_prefix)):
            # Refuse to read an empty filter as "everything": clear() is
            # the way to do that, and it is not reached by accident.
            return 0
        return self.delete_selection([], [(host, port, port_is_null, scheme, path_prefix)])

    def delete_selection(
        self,
        flow_ids: Sequence[str],
        subtrees: Sequence[tuple[str | None, int | None, bool, str | None, str | None]],
    ) -> int:
        """Delete mixed request and folder selections in one transaction.

        A parent folder and its selected child can overlap; row counts only
        include rows actually deleted. IDs are batched for SQLite's bind limit.
        """
        if not flow_ids and not subtrees:
            return 0
        deleted = 0
        with self._lock:
            with self._conn:
                for offset in range(0, len(flow_ids), 500):
                    batch = flow_ids[offset : offset + 500]
                    placeholders = ", ".join("?" for _ in batch)
                    cursor = self._conn.execute(
                        f"DELETE FROM flows WHERE id IN ({placeholders})", batch
                    )
                    deleted += cursor.rowcount
                for host, port, port_is_null, scheme, path_prefix in subtrees:
                    clauses: list[str] = []
                    params: list[Any] = []
                    if host:
                        clauses.append("host = ?")
                        params.append(host)
                    if port_is_null:
                        clauses.append("port IS NULL")
                    elif port is not None:
                        clauses.append("port = ?")
                        params.append(port)
                    if scheme:
                        clauses.append("scheme = ?")
                        params.append(scheme)
                    if path_prefix:
                        # Binary range preserves path case and treats %, _
                        # and backslash as ordinary characters.
                        low, high = _folder_bounds(path_prefix)
                        clauses.append("(path = ? OR (path >= ? AND path < ?))")
                        params.extend([path_prefix, low, high])
                    if not clauses:
                        raise ValueError("empty subtree cannot be deleted")
                    cursor = self._conn.execute(
                        f"DELETE FROM flows WHERE {' AND '.join(clauses)}", params
                    )
                    deleted += cursor.rowcount
        return deleted

    def reclaim_space(self) -> None:
        """Hand freed pages back to the filesystem.

        Deleting rows only marks pages reusable, so the file does not
        shrink, and saving space is the whole reason for deleting.

        The checkpoint is not optional. In WAL mode the vacuum's own
        writes land in the -wal file and the main database keeps its old
        size until something moves them across, so vacuuming alone left
        the file exactly as large as before.
        """
        with self._lock:
            self._conn.execute("VACUUM")
            self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def compact_overview(self) -> dict[str, Any]:
        """Disk use and captured sites for a project cleanup preview.

        Content bytes count the bytes stored in body, header and snapshot
        columns. They are useful for ranking sites, but are not a promise
        about how much VACUUM will return to the filesystem.
        """
        with self._read_lock:
            rows = self._read_conn.execute(
                "SELECT scheme, host, port, COUNT(*) AS flows,"
                " SUM(COALESCE(length(request_body), 0)"
                " + COALESCE(length(response_body), 0)"
                " + COALESCE(length(CAST(request_headers AS BLOB)), 0)"
                " + COALESCE(length(CAST(response_headers AS BLOB)), 0)"
                " + COALESCE(length(CAST(request_original AS BLOB)), 0)"
                " + COALESCE(length(CAST(request_auto_modified AS BLOB)), 0))"
                " AS content_bytes"
                " FROM flows GROUP BY scheme, host, port"
                " ORDER BY content_bytes DESC, flows DESC"
            ).fetchall()
            page_size = int(self._read_conn.execute("PRAGMA page_size").fetchone()[0])
            free_pages = int(self._read_conn.execute("PRAGMA freelist_count").fetchone()[0])
            total_flows = int(self._read_conn.execute("SELECT flows FROM flow_totals").fetchone()[0])
        path = Path(self.path)
        db_bytes = (
            sum(
                candidate.stat().st_size if candidate.exists() else 0
                for candidate in (path, Path(f"{self.path}-wal"))
            )
            if self.path != ":memory:"
            else 0
        )
        return {
            "db_bytes": db_bytes,
            "reclaimable_bytes": page_size * free_pages,
            "total_flows": total_flows,
            "sites": [dict(row) for row in rows],
        }

    def delete_sites(
        self, sites: Sequence[tuple[str | None, str | None, int | None, int]]
    ) -> int:
        """Delete exact sites only if their previewed counts still match."""
        if not sites:
            return 0
        with self._lock:
            deleted = 0
            with self._conn:
                for scheme, host, port, expected in sites:
                    count = self._conn.execute(
                        "SELECT COUNT(*) FROM flows"
                        " WHERE scheme IS ? AND host IS ? AND port IS ?",
                        (scheme, host, port),
                    ).fetchone()[0]
                    if count != expected:
                        raise ValueError("capture changed; refresh the cleanup preview")
                for scheme, host, port, _ in sites:
                    cursor = self._conn.execute(
                        "DELETE FROM flows WHERE scheme IS ? AND host IS ? AND port IS ?",
                        (scheme, host, port),
                    )
                    deleted += cursor.rowcount
            return deleted

    # --- reads ------------------------------------------------------------
    def get(self, flow_id: str) -> FlowRecord | None:
        with self._read_lock:
            row = self._read_conn.execute(
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
        methods: Sequence[str] | None = None,
        status_classes: Sequence[int] | None = None,
        extensions: Sequence[str] | None = None,
        exclude_extensions: Sequence[str] | None = None,
    ) -> List[FlowRecord]:
        where, params = self._flow_filters(
            host=host, method=method, status_code=status_code, search=search,
            methods=methods, status_classes=status_classes,
            extensions=extensions, exclude_extensions=exclude_extensions,
        )
        with self._read_lock:
            rows = self._read_conn.execute(
                f"SELECT {_COLUMNS} FROM flows {where}"
                " ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
        return [_row_to_record(row) for row in rows]

    @staticmethod
    def _flow_filters(
        *, host: str | None = None, method: str | None = None,
        status_code: int | None = None, search: str | None = None,
        methods: Sequence[str] | None = None,
        status_classes: Sequence[int] | None = None,
        extensions: Sequence[str] | None = None,
        exclude_extensions: Sequence[str] | None = None,
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if host:
            clauses.append("host LIKE ? ESCAPE '\\'")
            params.append(f"%{_like_literal(host)}%")
        if method:
            clauses.append("method = ?")
            params.append(method.upper())
        if methods:
            # A list rather than one value, so the filter can be a set of
            # checkboxes instead of a single choice.
            placeholders = ", ".join("?" for _ in methods)
            clauses.append(f"method IN ({placeholders})")
            params.extend(m.upper() for m in methods)
        if status_code is not None:
            clauses.append("status_code = ?")
            params.append(status_code)
        if status_classes:
            # By class, because 2xx is the useful unit, not 204 vs 200.
            # A flow with no response yet is kept out rather than falling
            # into whichever class happens to be selected.
            ranges = " OR ".join(
                "(status_code >= ? AND status_code < ?)" for _ in status_classes
            )
            clauses.append(f"({ranges})")
            for cls in status_classes:
                params.extend([cls * 100, cls * 100 + 100])
        if extensions:
            # The query string lives in its own column, so matching the
            # end of the path is exact rather than a guess.
            matches = " OR ".join("lower(path) LIKE ? ESCAPE '\\'" for _ in extensions)
            clauses.append(f"({matches})")
            params.extend(f"%.{_like_literal(ext.lower().lstrip('.'))}" for ext in extensions)
        if exclude_extensions:
            for ext in exclude_extensions:
                clauses.append("(path IS NULL OR lower(path) NOT LIKE ? ESCAPE '\\')")
                params.append(f"%.{_like_literal(ext.lower().lstrip('.'))}")
        if search:
            clauses.append("(path LIKE ? ESCAPE '\\' OR query LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\')")
            params.extend([f"%{_like_literal(search)}%"] * 3)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return where, params

    def page_summaries(
        self, *, limit: int = 200, offset: int = 0,
        scope_predicate: Callable[[str | None, str | None, int | None, str | None], bool] | None = None,
        host: str | None = None, method: str | None = None,
        status_code: int | None = None, search: str | None = None,
        methods: Sequence[str] | None = None,
        status_classes: Sequence[int] | None = None,
        extensions: Sequence[str] | None = None,
        exclude_extensions: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        """A bounded page over all matching flows, without loading body BLOBs.

        Scope rules may depend on arbitrary paths, so apply them while
        streaming the SQL result before counting the requested page offset.
        """
        where, params = self._flow_filters(
            host=host, method=method, status_code=status_code, search=search,
            methods=methods, status_classes=status_classes,
            extensions=extensions, exclude_extensions=exclude_extensions,
        )
        items: list[dict[str, Any]] = []
        matched = 0
        with self._read_lock:
            if scope_predicate is None:
                rows = self._read_conn.execute(
                    f"SELECT {_SUMMARY_COLUMNS} FROM flows {where}"
                    " ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?",
                    (*params, limit + 1, offset),
                ).fetchall()
                return {"items": [dict(row) for row in rows[:limit]],
                        "has_more": len(rows) > limit}
            cursor = self._read_conn.execute(
                f"SELECT {_SUMMARY_COLUMNS} FROM flows {where}"
                " ORDER BY started_at DESC, rowid DESC", params,
            )
            for row in cursor:
                if not scope_predicate(row["scheme"], row["host"], row["port"], row["path"]):
                    continue
                if matched < offset:
                    matched += 1
                    continue
                if len(items) == limit:
                    return {"items": items, "has_more": True}
                items.append(dict(row))
        return {"items": items, "has_more": False}

    def count(self) -> int:
        with self._read_lock:
            return int(self._read_conn.execute("SELECT flows FROM flow_totals").fetchone()[0])

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

        imported_flows = 0
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
                for flow in flows:
                    try:
                        self._upsert_uncommitted(_record_from_export(flow))
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
        """Read counters maintained by flow triggers, without a table scan."""
        with self._read_lock:
            conn = self._read_conn
            totals = conn.execute("SELECT * FROM flow_totals WHERE id = 1").fetchone()
            hosts = conn.execute(
                "SELECT COUNT(DISTINCT host) FROM flow_site_stats"
            ).fetchone()[0]
            first_row = conn.execute(
                "SELECT started_at FROM flows WHERE started_at IS NOT NULL"
                " ORDER BY started_at ASC LIMIT 1"
            ).fetchone()
            last_row = conn.execute(
                "SELECT started_at FROM flows WHERE started_at IS NOT NULL"
                " ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
            status_rows = conn.execute(
                "SELECT bucket, flows AS count FROM flow_status_stats ORDER BY bucket"
            ).fetchall()
            method_rows = conn.execute(
                "SELECT method, flows AS count FROM flow_method_stats"
                " ORDER BY flows DESC, method"
            ).fetchall()
            host_rows = conn.execute(
                "SELECT host, MIN(scheme) AS scheme, MIN(port) AS port,"
                " SUM(flows) AS flows, SUM(errors) AS errors, SUM(bytes) AS bytes,"
                " MAX(last_seen) AS last_seen FROM flow_site_stats"
                " GROUP BY host ORDER BY flows DESC, host LIMIT ?",
                (top,),
            ).fetchall()
            first_seen = first_row[0] if first_row else None
            last_seen = last_row[0] if last_row else None
            cutoff = (last_seen or 0.0) - recent_window
            recent = int(conn.execute(
                "SELECT COUNT(*) FROM flows WHERE started_at >= ?", (cutoff,)
            ).fetchone()[0])

        status_groups = {
            f"{int(row['bucket'])}xx": int(row["count"])
            for row in status_rows
            if row["bucket"] is not None
        }

        span = (last_seen - first_seen) if (first_seen and last_seen) else 0.0

        return {
            "flows": int(totals["flows"] or 0),
            "hosts": int(hosts or 0),
            "bytes": int(totals["bytes"] or 0),
            "avg_duration_ms": (
                round(totals["duration_sum"] / totals["duration_count"], 2)
                if totals["duration_count"] else None
            ),
            "errors": int(totals["errors"] or 0),
            "pending": int(totals["pending"]),
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
                    "scheme": row["scheme"] or None,
                    "port": None if row["port"] == -1 else row["port"],
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
        with self._read_lock:
            rows = self._read_conn.execute(
                "SELECT scheme, host, port, flows, paths, last_seen"
                " FROM flow_site_stats ORDER BY host"
            ).fetchall()
        return [
            {**dict(row), "scheme": row["scheme"] or None,
             "port": None if row["port"] == -1 else row["port"]}
            for row in rows
        ]

    def distinct_paths_for_site(
        self, scheme: str, host: str, port: int | None
    ) -> List[str]:
        """Distinct paths for one site (used for scope evaluation)."""
        with self._read_lock:
            rows = self._read_conn.execute(
                "SELECT path FROM flow_path_stats WHERE scheme = ? AND host = ?"
                " AND port = ?",
                (scheme or "", host, -1 if port is None else port),
            ).fetchall()
        return [row["path"] for row in rows]

    def any_path_for_site(
        self,
        scheme: str | None,
        host: str,
        port: int | None,
        predicate: Callable[[str], bool],
    ) -> bool:
        """Evaluate scope on distinct paths without materializing a capture."""
        with self._read_lock:
            cursor = self._read_conn.execute(
                "SELECT path FROM flow_path_stats WHERE scheme = ? AND host = ?"
                " AND port = ?",
                (scheme or "", host, -1 if port is None else port),
            )
            return any(predicate(row[0]) for row in cursor)

    def page_paths_for_site(
        self,
        scheme: str | None,
        host: str,
        port: int | None,
        *,
        limit: int = 200,
        offset: int = 0,
        path_prefix: str | None = None,
        port_is_null: bool = False,
    ) -> dict[str, Any]:
        """Fetch one bounded site or folder page for the Target tree."""
        clauses = ["scheme IS ?", "host = ?"]
        params: list[Any] = [scheme, host]
        stat_clauses = ["scheme = ?", "host = ?"]
        stat_params: list[Any] = [scheme or "", host]
        if port is not None or port_is_null:
            clauses.append("port IS ?")
            params.append(port)
            stat_clauses.append("port = ?")
            stat_params.append(-1 if port is None else port)
        if path_prefix:
            low, high = _folder_bounds(path_prefix)
            clauses.append("(path = ? OR (path >= ? AND path < ?))")
            params.extend([path_prefix, low, high])
        with self._read_lock:
            if path_prefix:
                total = self._read_conn.execute(
                    "SELECT COALESCE(SUM(flows), 0) FROM flow_path_stats"
                    f" WHERE {' AND '.join(stat_clauses)}"
                    " AND (path = ? OR (path >= ? AND path < ?))",
                    (*stat_params, path_prefix, low, high),
                ).fetchone()[0]
            else:
                row = self._read_conn.execute(
                    "SELECT COALESCE(SUM(flows), 0) FROM flow_site_stats"
                    f" WHERE {' AND '.join(stat_clauses)}", stat_params,
                ).fetchone()
                total = row[0] if row else 0
            rows = self._read_conn.execute(
                "SELECT id, method, path, query, status_code, response_size,"
                " started_at FROM flows"
                f" WHERE {' AND '.join(clauses)}"
                " ORDER BY path, method, id LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
        return {"items": [dict(row) for row in rows], "count": int(total)}

    def paths_for_site(
        self, scheme: str, host: str, port: int | None
    ) -> List[dict[str, Any]]:
        clauses = ["host = ?", "scheme = ?"]
        params: list[Any] = [host, scheme]
        if port is not None:
            clauses.append("port = ?")
            params.append(port)
        with self._read_lock:
            rows = self._read_conn.execute(
                "SELECT id, method, path, query, status_code, response_size,"
                " started_at FROM flows"
                f" WHERE {' AND '.join(clauses)}"
                " ORDER BY path, method",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    @property
    def payload_sets(self) -> "PayloadSetStore":
        """Payload sets, sharing this connection and its lock."""
        if self._payload_sets is None:
            from .payloads import PayloadSetStore

            self._payload_sets = PayloadSetStore(self._conn, self._lock)
        return self._payload_sets

    def paths_by_site(self) -> dict[tuple[str, str, int | None], List[dict[str, Any]]]:
        """Every site's paths in one pass.

        The site map needs this for every host it shows. Asking per host
        meant one request and one query per host, which on a real capture
        with sixty hosts took seconds and grew with every new host seen.
        """
        with self._read_lock:
            rows = self._read_conn.execute(
                "SELECT id, scheme, host, port, method, path, query,"
                " status_code, response_size, started_at FROM flows"
                " ORDER BY host, path, method"
            ).fetchall()
        grouped: dict[tuple[str, str, int | None], List[dict[str, Any]]] = {}
        for row in rows:
            item = dict(row)
            key = (item.pop("scheme"), item.pop("host"), item.pop("port"))
            grouped.setdefault(key, []).append(item)
        return grouped


def _truncate(body: bytes | None) -> bytes | None:
    if body is None:
        return None
    return body[:MAX_BODY_BYTES]


def _folder_bounds(prefix: str) -> tuple[str, str]:
    stem = prefix.rstrip("/")
    return f"{stem}/", f"{stem}0"


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
        request_original=_load_snapshot(row["request_original"]),
        request_auto_modified=_load_snapshot(row["request_auto_modified"]),
        auto_modified=bool(row["auto_modified"]),
        modified=bool(row["modified"]),
    )
