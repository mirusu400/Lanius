"""Flow persistence (SQLite).

All public methods are synchronous and thread-safe; callers running inside the
mitmproxy asyncio loop must go through :mod:`app.db.async_store` (or
``asyncio.to_thread``) so the event loop is never blocked.
"""

from __future__ import annotations

import base64
import contextlib
import json
import math
import os
import sqlite3
import stat
import tempfile
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

ANNOTATION_COLORS = frozenset({"red", "orange", "yellow", "green", "blue", "purple"})
COMPACT_DELETE_BATCH_SIZE = 250

from .schema import migrate
from .search_index import MIGRATION as SEARCH_MIGRATION
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .payloads import PayloadSetStore

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
    local_source_ip: str | None = None
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
    "id, type, client_addr, server_addr, local_source_ip, scheme, method, host, port, path, query,"
    " http_version, request_headers, request_body, request_size, started_at,"
    " status_code, reason, response_headers, response_body, response_size,"
    " response_mime, completed_at, duration_ms, error, source, comment,"
    " request_original, request_auto_modified, auto_modified, modified"
)

_SUMMARY_COLUMNS = (
    "id, type, client_addr, server_addr, local_source_ip, scheme, method, host, port, path, query,"
    " http_version, request_size, started_at, status_code, reason, response_size,"
    " response_mime, completed_at, duration_ms, error, source, comment,"
    " auto_modified, modified, flows.rowid AS history_rowid,"
    " COALESCE((SELECT bookmarked FROM flow_annotations WHERE flow_id = flows.id), 0) AS bookmarked,"
    " (SELECT color FROM flow_annotations WHERE flow_id = flows.id) AS annotation_color"
)


def _like_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _glob_literal(value: str) -> str:
    return value.replace("[", "[[]").replace("*", "[*]").replace("?", "[?]")


def _summary_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data.pop("history_rowid", None)
    data["request_size"] = data["request_size"] or 0
    data["response_size"] = data["response_size"] or 0
    data["source"] = data["source"] or "proxy"
    data["auto_modified"] = bool(data["auto_modified"])
    data["modified"] = bool(data["modified"])
    data["bookmarked"] = bool(data["bookmarked"])
    return data


def _history_cursor(row: sqlite3.Row) -> str:
    return json.dumps([row["started_at"], row["history_rowid"]], separators=(",", ":"))


def _cursor_filter(cursor: str) -> tuple[str, list[Any]]:
    try:
        started_at, rowid = json.loads(cursor)
        if (started_at is not None and (
                isinstance(started_at, bool) or not isinstance(started_at, (int, float))
                or not math.isfinite(started_at))) \
                or not isinstance(rowid, int) or isinstance(rowid, bool) or rowid < 1:
            raise ValueError
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid history cursor") from exc
    if started_at is None:
        return "(started_at IS NULL AND rowid < ?)", [rowid]
    return "(started_at < ? OR started_at IS NULL OR (started_at = ? AND rowid < ?))", [started_at, started_at, rowid]


class FlowStore:
    """Thread-safe SQLite-backed flow store."""

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            parent = Path(self.path).parent
            parent.mkdir(parents=True, exist_ok=True)
            if os.name == "posix":
                parent.chmod(stat.S_IRWXU)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        if self.path != ":memory:" and os.name == "posix":
            Path(self.path).chmod(stat.S_IRUSR | stat.S_IWUSR)
            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{self.path}{suffix}")
                if sidecar.exists():
                    sidecar.chmod(stat.S_IRUSR | stat.S_IWUSR)
        self._conn.execute("PRAGMA recursive_triggers=ON")
        self._payload_sets: "PayloadSetStore | None" = None
        self._conn.execute("PRAGMA synchronous=NORMAL")
        migrate(self._conn)
        # A held frame cannot be resumed after its proxy process has gone.
        self._conn.execute(
            "UPDATE websocket_messages SET paused = 0, dropped = 1 WHERE paused = 1"
        )
        self._conn.commit()
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

    def backup_database(self) -> str:
        """Create a consistent complete SQLite snapshot without stopping capture."""
        if self.path == ":memory:":
            raise ValueError("in-memory projects have no database file to back up")
        with tempfile.NamedTemporaryFile(prefix="lanius_backup_", suffix=".sqlite", delete=False) as temp:
            destination = temp.name
        try:
            uri = Path(self.path).resolve().as_uri() + "?mode=ro"
            with contextlib.closing(sqlite3.connect(uri, uri=True)) as source:
                with contextlib.closing(sqlite3.connect(destination)) as target:
                    source.backup(target)
            return destination
        except Exception:
            Path(destination).unlink(missing_ok=True)
            raise

    def restore_database(
        self, path: str | Path, *, preserve_settings: Sequence[str] = (),
        keep_enabled: Sequence[str] = (),
    ) -> None:
        """Atomically restore a validated, migrated snapshot into this store.

        Keep the same connection object for payload stores and capture writers.
        The proxy must be stopped and drained before this method is called.
        """
        with self._read_lock, self._lock:
            with contextlib.closing(sqlite3.connect(path)) as source:
                with source:
                    for key in preserve_settings:
                        current = self.get_setting(key)
                        source.execute("DELETE FROM settings WHERE key=?", (key,))
                        if current is not None:
                            source.execute("INSERT INTO settings(key,value) VALUES (?,?)", (key, current))
                    for key in keep_enabled:
                        if self.get_setting(key) == "1":
                            source.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?, '1')", (key,))
                # SQLite's backup API commits the destination as one transaction;
                # a failed copy cannot leave a partially restored project.
                source.backup(self._conn)
            self._conn.execute("PRAGMA recursive_triggers=ON")

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
            record.local_source_ip,
            record.scheme,
            record.method,
            record.host,
            record.port,
            record.path,
            record.query,
            record.http_version,
            _dump_headers(record.request_headers),
            record.request_body,
            record.request_size,
            record.started_at,
            record.status_code,
            record.reason,
            _dump_headers(record.response_headers),
            record.response_body,
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
        updates = ", ".join(
            (f"{column.strip()} = COALESCE(excluded.{column.strip()}, flows.{column.strip()})"
             if column.strip() == "local_source_ip"
             else f"{column.strip()} = excluded.{column.strip()}")
            for column in _COLUMNS.split(",") if column.strip() != "id"
        )
        self._conn.execute(
            f"INSERT INTO flows ({_COLUMNS}) VALUES ({placeholders})"
            f" ON CONFLICT(id) DO UPDATE SET {updates}",
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
            # Deleting rows through the FTS trigger re-tokenizes each old body.
            # A few large captures can keep Clear busy for minutes. Drop the
            # entire search index first, then rebuild it empty in the same
            # transaction so a failed clear restores both history and search.
            # sqlite3's context manager does not begin a transaction for DDL.
            self._conn.execute("BEGIN IMMEDIATE")
            with self._conn:
                for trigger in (
                    "flow_search_insert", "flow_search_delete", "flow_search_update"
                ):
                    self._conn.execute(f"DROP TRIGGER {trigger}")
                self._conn.execute("DROP TABLE flow_search")
                self._conn.execute("DELETE FROM flows")
                for statement in (SEARCH_MIGRATION[0], *SEARCH_MIGRATION[2:]):
                    self._conn.execute(statement)

    def get_annotation(self, flow_id: str) -> dict[str, Any] | None:
        with self._read_lock:
            exists = self._read_conn.execute("SELECT 1 FROM flows WHERE id = ?", (flow_id,)).fetchone()
            if exists is None:
                return None
            row = self._read_conn.execute(
                "SELECT bookmarked, color FROM flow_annotations WHERE flow_id = ?", (flow_id,)
            ).fetchone()
        return {"id": flow_id, "bookmarked": bool(row["bookmarked"]) if row else False,
                "annotation_color": row["color"] if row else None}

    def patch_annotation(self, flow_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        """Keep user marks independent from later request/response capture upserts."""
        if "bookmarked" in changes and not isinstance(changes["bookmarked"], bool):
            raise ValueError("bookmarked must be a boolean")
        if "annotation_color" in changes:
            color = changes["annotation_color"]
            if color is not None and (not isinstance(color, str) or color not in ANNOTATION_COLORS):
                raise ValueError("invalid annotation color")
        with self._lock:
            if self._conn.execute("SELECT 1 FROM flows WHERE id = ?", (flow_id,)).fetchone() is None:
                return None
            row = self._conn.execute(
                "SELECT bookmarked, color FROM flow_annotations WHERE flow_id = ?", (flow_id,)
            ).fetchone()
            bookmarked = changes.get("bookmarked", bool(row["bookmarked"]) if row else False)
            color = changes.get("annotation_color", row["color"] if row else None)
            if bookmarked or color:
                self._conn.execute(
                    "INSERT INTO flow_annotations (flow_id, bookmarked, color) VALUES (?, ?, ?)"
                    " ON CONFLICT(flow_id) DO UPDATE SET bookmarked = excluded.bookmarked, color = excluded.color",
                    (flow_id, int(bookmarked), color),
                )
            else:
                self._conn.execute("DELETE FROM flow_annotations WHERE flow_id = ?", (flow_id,))
            self._conn.commit()
        return {"id": flow_id, "bookmarked": bookmarked, "annotation_color": color}

    def all_annotations(self) -> dict[str, dict[str, Any]]:
        with self._read_lock:
            rows = self._read_conn.execute("SELECT flow_id, bookmarked, color FROM flow_annotations").fetchall()
        return {row["flow_id"]: {"bookmarked": bool(row["bookmarked"]),
                                  "annotation_color": row["color"]} for row in rows}

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

    def reclaim_space(self, on_phase: Callable[[str], None] | None = None) -> None:
        """Hand freed pages back to the filesystem.

        Deleting rows only marks pages reusable, so the file does not
        shrink, and saving space is the whole reason for deleting.

        The checkpoint is not optional. In WAL mode the vacuum's own
        writes land in the -wal file and the main database keeps its old
        size until something moves them across, so vacuuming alone left
        the file exactly as large as before.
        """
        with self._lock:
            # FTS5 keeps deleted document text in old index segments until
            # they are merged. VACUUM alone cannot reclaim those pages.
            if on_phase:
                on_phase("optimizing")
            self._conn.execute("INSERT INTO flow_search(flow_search) VALUES ('optimize')")
            self._conn.commit()
            if on_phase:
                on_phase("vacuuming")
            self._conn.execute("VACUUM")
            if on_phase:
                on_phase("checkpointing")
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
        self,
        sites: Sequence[tuple[str | None, str | None, int | None, int]],
        on_progress: Callable[[int, int], None] | None = None,
    ) -> int:
        """Delete exact sites only if their previewed counts still match."""
        if not sites:
            return 0
        total = sum(site[3] for site in sites)
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
                    while True:
                        rows = self._conn.execute(
                            "SELECT rowid FROM flows"
                            " WHERE scheme IS ? AND host IS ? AND port IS ?"
                            " LIMIT ?",
                            (scheme, host, port, COMPACT_DELETE_BATCH_SIZE),
                        ).fetchall()
                        if not rows:
                            break
                        placeholders = ",".join("?" for _ in rows)
                        cursor = self._conn.execute(
                            f"DELETE FROM flows WHERE rowid IN ({placeholders})",
                            [row[0] for row in rows],
                        )
                        deleted += cursor.rowcount
                        if on_progress:
                            on_progress(deleted, total)
            return deleted

    # --- reads ------------------------------------------------------------
    def get(self, flow_id: str) -> FlowRecord | None:
        with self._read_lock:
            row = self._read_conn.execute(
                f"SELECT {_COLUMNS} FROM flows WHERE id = ?", (flow_id,)
            ).fetchone()
        return _row_to_record(row) if row else None

    def get_body_bytes(self, flow_id: str, side: str) -> bytes | None:
        if side not in {"request", "response"}:
            raise ValueError("side must be request or response")
        with self._read_lock:
            row = self._read_conn.execute(
                f"SELECT {side}_body FROM flows WHERE id = ?", (flow_id,)
            ).fetchone()
        return bytes(row[0]) if row is not None and row[0] is not None else None

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
        bookmarked_only: bool = False, annotation_color: str | None = None,
    ) -> tuple[str, List[Any]]:
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
            clauses.append("rowid IN (SELECT rowid FROM flow_search WHERE text GLOB ?)")
            params.append(f"*{_glob_literal(search.casefold())}*")
        if bookmarked_only:
            clauses.append("EXISTS (SELECT 1 FROM flow_annotations WHERE flow_id = flows.id AND bookmarked = 1)")
        if annotation_color:
            clauses.append("EXISTS (SELECT 1 FROM flow_annotations WHERE flow_id = flows.id AND color = ?)")
            params.append(annotation_color)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return where, params

    def page_summaries(
        self, *, limit: int = 200, offset: int = 0,
        anchor: int | None = None,
        cursor: str | None = None,
        sort_by: str = "started_at", sort_desc: bool = True,
        scope_predicate: Callable[[str | None, str | None, int | None, str | None], bool] | None = None,
        host: str | None = None, method: str | None = None,
        status_code: int | None = None, search: str | None = None,
        methods: Sequence[str] | None = None,
        status_classes: Sequence[int] | None = None,
        extensions: Sequence[str] | None = None,
        exclude_extensions: Sequence[str] | None = None,
        bookmarked_only: bool = False, annotation_color: str | None = None,
    ) -> dict[str, Any]:
        """A bounded page over small history rows, without touching body pages.

        Scope rules may depend on arbitrary paths, so apply them while
        streaming the SQL result before counting the requested page offset.
        """
        if cursor is not None and offset:
            raise ValueError("cursor and offset cannot be combined")
        if annotation_color is not None and annotation_color not in ANNOTATION_COLORS:
            raise ValueError("invalid annotation color")
        sort_columns = {
            "started_at": "started_at", "method": "method", "host": "host",
            "url": "path || COALESCE('?' || query, '')", "status_code": "status_code",
            "modified": "modified", "response_size": "response_size",
            "duration_ms": "duration_ms",
        }
        if sort_by not in sort_columns:
            raise ValueError("invalid history sort column")
        default_sort = sort_by == "started_at" and sort_desc
        if cursor is not None and not default_sort:
            raise ValueError("cursor is only available for newest-first history")
        direction = "DESC" if sort_desc else "ASC"
        order = f"{sort_columns[sort_by]} {direction}, rowid {direction}"
        where, params = self._flow_filters(
            host=host, method=method, status_code=status_code, search=search,
            methods=methods, status_classes=status_classes,
            extensions=extensions, exclude_extensions=exclude_extensions,
            bookmarked_only=bookmarked_only, annotation_color=annotation_color,
        )
        items: list[dict[str, Any]] = []
        matched = 0
        with self._read_lock:
            if anchor is None:
                anchor = int(self._read_conn.execute(
                    "SELECT COALESCE(MAX(rowid), 0) FROM flow_history"
                ).fetchone()[0])
            where = f"{where} {'AND' if where else 'WHERE'} rowid <= ?"
            params.append(anchor)
            if cursor is not None:
                cursor_sql, cursor_params = _cursor_filter(cursor)
                where += f" AND {cursor_sql}"
                params.extend(cursor_params)
            # A common search term can match millions of rows. Probe a
            # bounded newest slice first, so the usual first few pages do
            # not materialize every matching FTS rowid. If the slice does
            # not prove has_more, the complete index query below decides.
            needed = offset + limit + 1
            if default_sort and search and scope_predicate is None and needed <= 1000:
                base_where, base_params = self._flow_filters(
                    host=host, method=method, status_code=status_code,
                    methods=methods, status_classes=status_classes,
                    extensions=extensions,
                    exclude_extensions=exclude_extensions,
                    bookmarked_only=bookmarked_only, annotation_color=annotation_color,
                )
                base_where = (
                    f"{base_where} {'AND' if base_where else 'WHERE'} rowid <= ?"
                )
                if cursor is not None:
                    base_where += f" AND {cursor_sql}"
                probe = max(needed, 300)
                recent = self._read_conn.execute(
                    "WITH recent AS MATERIALIZED ("
                    f" SELECT rowid FROM flow_history AS flows {base_where}"
                    " ORDER BY started_at DESC, rowid DESC LIMIT ?)"
                    f" SELECT {_SUMMARY_COLUMNS} FROM flow_history AS flows"
                    " JOIN recent ON flows.rowid = recent.rowid"
                    " WHERE EXISTS (SELECT 1 FROM flow_search AS hit"
                    " WHERE hit.rowid = flows.rowid AND instr(hit.text, ?) > 0)"
                    " ORDER BY started_at DESC, flows.rowid DESC LIMIT ?",
                    (*base_params, anchor,
                     *(cursor_params if cursor is not None else []), probe,
                     search.casefold(), needed),
                ).fetchall()
                if len(recent) == needed:
                    return {
                        "items": [_summary_row(row) for row in recent[offset:offset + limit]],
                        "has_more": True, "anchor": anchor,
                        "next_cursor": _history_cursor(recent[offset + limit - 1]),
                    }
            if scope_predicate is None:
                rows = self._read_conn.execute(
                    f"SELECT {_SUMMARY_COLUMNS} FROM flow_history AS flows {where}"
                    f" ORDER BY {order} LIMIT ? OFFSET ?",
                    (*params, limit + 1, offset),
                ).fetchall()
                return {"items": [_summary_row(row) for row in rows[:limit]],
                        "has_more": len(rows) > limit, "anchor": anchor,
                        "next_cursor": (_history_cursor(rows[limit - 1])
                        if len(rows) >= limit else (_history_cursor(rows[-1]) if rows else None))
                        if default_sort else None}
            last_cursor: str | None = None
            rows_cursor = self._read_conn.execute(
                f"SELECT {_SUMMARY_COLUMNS} FROM flow_history AS flows {where}"
                f" ORDER BY {order}", params,
            )
            for row in rows_cursor:
                if not scope_predicate(row["scheme"], row["host"], row["port"], row["path"]):
                    continue
                if matched < offset:
                    matched += 1
                    continue
                if len(items) == limit:
                    return {"items": items, "has_more": True, "anchor": anchor,
                            "next_cursor": last_cursor}
                items.append(_summary_row(row))
                last_cursor = _history_cursor(row) if default_sort else None
        return {"items": items, "has_more": False, "anchor": anchor,
                "next_cursor": last_cursor}

    def count(self) -> int:
        with self._read_lock:
            return int(self._read_conn.execute("SELECT flows FROM flow_totals").fetchone()[0])

    # --- WebSocket history ------------------------------------------------
    def append_websocket_message(self, item: dict[str, Any], content: bytes) -> int:
        """Commit raw message bytes before announcing the live event."""
        with self._lock:
            cursor = self._conn.execute(
                """INSERT INTO websocket_messages
                (id, connection_id, host, path, from_client, is_text, timestamp,
                 content, injected, dropped, paused)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (item["id"], item["connection_id"], item["host"], item["path"],
                 int(item["from_client"]), int(item["is_text"]), item["timestamp"],
                 content, int(item["injected"]), int(item["dropped"]), int(item["paused"])),
            )
            self._conn.commit()
            return int(cursor.lastrowid or 0)

    def update_websocket_message(
        self, message_id: str, content: bytes, *, dropped: bool
    ) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE websocket_messages SET content = ?, dropped = ?, paused = 0 WHERE id = ?",
                (content, int(dropped), message_id),
            )
            self._conn.commit()

    def page_websocket_messages(
        self, *, limit: int = 200, before: int | None = None
    ) -> dict[str, Any]:
        from ..addons.websocket_proxy import _encoded

        with self._read_lock:
            rows = self._read_conn.execute(
                "SELECT * FROM websocket_messages"
                + (" WHERE seq < ?" if before is not None else "")
                + " ORDER BY seq DESC LIMIT ?",
                ((before,) if before is not None else ()) + (limit + 1,),
            ).fetchall()
        items = []
        for row in rows[:limit]:
            raw = bytes(row["content"])
            item = {key: row[key] for key in (
                "seq", "id", "connection_id", "host", "path", "timestamp"
            )}
            item.update({key: bool(row[key]) for key in (
                "from_client", "is_text", "injected", "dropped", "paused"
            )})
            item.update({"size": len(raw), **_encoded(raw, item["is_text"])})
            items.append(item)
        return {
            "items": items,
            "has_more": len(rows) > limit,
            "next_before": items[-1]["seq"] if items else None,
        }

    def clear_websocket_messages(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM websocket_messages")
            self._conn.commit()

    def get_websocket_message_bytes(self, message_id: str) -> bytes | None:
        with self._read_lock:
            row = self._read_conn.execute(
                "SELECT content FROM websocket_messages WHERE id = ?", (message_id,)
            ).fetchone()
        return bytes(row[0]) if row is not None else None

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

    # --- workspace (Replay/Decoder/Fuzzer state) ----------------------
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
        issues = data.get("issues") or []

        imported_flows = 0
        imported_issues = 0
        with self._lock:
            with self._conn:  # transaction
                self._conn.execute("DELETE FROM scope_rules")
                self._conn.execute("DELETE FROM workspace")
                self._conn.execute("DELETE FROM issues")
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
                        bookmarked = flow.get("bookmarked", False)
                        color = flow.get("annotation_color")
                        if isinstance(bookmarked, bool) and color in (
                            None, "red", "orange", "yellow", "green", "blue", "purple"
                        ) and (bookmarked or color):
                            self._conn.execute(
                                "INSERT OR REPLACE INTO flow_annotations (flow_id, bookmarked, color) VALUES (?, ?, ?)",
                                (flow["id"], int(bookmarked), color),
                            )
                        imported_flows += 1
                    except Exception:
                        # One malformed flow must not abandon the rest.
                        logger.warning("skipping an unreadable flow during import")
                issue_columns = (
                    "id", "fingerprint", "plugin_id", "check_id", "scan_mode",
                    "title", "severity", "confidence", "status", "detail",
                    "remediation", "url", "host", "path", "parameter", "flow_id",
                    "evidence", "first_seen", "last_seen", "occurrences",
                )
                for issue in issues:
                    try:
                        values = tuple(
                            json.dumps(issue.get(name), ensure_ascii=False)
                            if name == "evidence" and issue.get(name) is not None
                            else issue.get(name)
                            for name in issue_columns
                        )
                        self._conn.execute(
                            f"INSERT INTO issues ({', '.join(issue_columns)})"
                            f" VALUES ({', '.join('?' for _ in issue_columns)})",
                            values,
                        )
                        imported_issues += 1
                    except Exception:
                        logger.warning("skipping an unreadable issue during import")

        return {
            "scope": len(scope),
            "workspace": len(workspace),
            "settings": len(settings),
            "flows": imported_flows,
            "issues": imported_issues,
        }

    def delete_setting(self, key: str) -> None:
        """Remove a setting, so its absence is distinct from an empty value."""
        with self._lock:
            self._conn.execute("DELETE FROM settings WHERE key = ?", (key,))
            self._conn.commit()

    # --- scanner issues --------------------------------------------------
    def upsert_issue(self, issue: dict[str, Any]) -> dict[str, Any]:
        """Insert a finding or merge another observation into its fingerprint."""

        columns = (
            "id", "fingerprint", "plugin_id", "check_id", "scan_mode", "title",
            "severity", "confidence", "status", "detail", "remediation", "url",
            "host", "path", "parameter", "flow_id", "evidence", "first_seen",
            "last_seen", "occurrences",
        )
        values = tuple(
            json.dumps(issue.get(name), ensure_ascii=False)
            if name == "evidence" and issue.get(name) is not None
            else issue.get(name)
            for name in columns
        )
        with self._lock:
            self._conn.execute(
                f"INSERT INTO issues ({', '.join(columns)})"
                f" VALUES ({', '.join('?' for _ in columns)})"
                " ON CONFLICT(fingerprint) DO UPDATE SET"
                " last_seen=excluded.last_seen,"
                " occurrences=issues.occurrences + 1,"
                " severity=excluded.severity,"
                " confidence=excluded.confidence,"
                " detail=excluded.detail,"
                " remediation=excluded.remediation,"
                " evidence=excluded.evidence,"
                " flow_id=COALESCE(excluded.flow_id, issues.flow_id)",
                values,
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM issues WHERE fingerprint = ?",
                (issue["fingerprint"],),
            ).fetchone()
        assert row is not None
        return self._issue_row(row)

    @staticmethod
    def _issue_row(row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        try:
            value["evidence"] = json.loads(value["evidence"]) if value["evidence"] else None
        except (TypeError, ValueError):
            value["evidence"] = None
        return value

    def list_issues(
        self,
        *,
        status: str | None = None,
        severity: str | None = None,
        host: str | None = None,
        search: str | None = None,
        limit: int = 500,
    ) -> List[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if severity:
            clauses.append("severity = ?")
            params.append(severity)
        if host:
            clauses.append("host = ?")
            params.append(host)
        if search:
            clauses.append("(title LIKE ? OR detail LIKE ? OR parameter LIKE ?)")
            pattern = f"%{search}%"
            params.extend([pattern, pattern, pattern])
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM issues" + where
                + " ORDER BY CASE severity"
                " WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2"
                " WHEN 'low' THEN 3 ELSE 4 END, last_seen DESC LIMIT ?",
                params,
            ).fetchall()
        return [self._issue_row(row) for row in rows]

    def get_issue(self, issue_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM issues WHERE id = ?", (issue_id,)
            ).fetchone()
        return self._issue_row(row) if row is not None else None

    def set_issue_status(self, issue_id: str, status: str) -> dict[str, Any] | None:
        with self._lock:
            self._conn.execute(
                "UPDATE issues SET status = ? WHERE id = ?", (status, issue_id)
            )
            self._conn.commit()
        return self.get_issue(issue_id)

    def delete_issue(self, issue_id: str) -> bool:
        with self._lock:
            cursor = self._conn.execute("DELETE FROM issues WHERE id = ?", (issue_id,))
            self._conn.commit()
        return cursor.rowcount > 0

    def issue_summary(self) -> dict[str, Any]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT severity, status, COUNT(*) AS count FROM issues"
                " GROUP BY severity, status"
            ).fetchall()
        return {
            "total": sum(row["count"] for row in rows),
            "by_severity": {
                severity: sum(
                    row["count"] for row in rows if row["severity"] == severity
                )
                for severity in ("info", "low", "medium", "high", "critical")
            },
            "by_status": {
                status: sum(row["count"] for row in rows if row["status"] == status)
                for status in ("open", "resolved", "false_positive")
            },
        }

    def all_issues(self) -> List[dict[str, Any]]:
        return self.list_issues(limit=100_000)

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

    def page_endpoints(
        self, *, host: str | None = None, limit: int = 5000,
        offset: int = 0,
        scope_predicate: Callable[[str | None, str | None, int | None, str | None], bool] | None = None,
        scope_site_wide: bool = False,
    ) -> dict[str, Any]:
        """Read materialized groups; path-dependent scope uses a full scan."""
        from ..addons.endpoints import build_endpoints

        params: list[Any] = []
        where = ""
        if host:
            where = "WHERE host LIKE ? ESCAPE '\\'"
            params.append(f"%{_like_literal(host)}%")
        with self._read_lock:
            if scope_site_wide and scope_predicate is not None:
                self._read_conn.create_function(
                    "lanius_scope_site", 3,
                    lambda scheme, name, port: int(scope_predicate(
                        scheme, name, None if port == -1 else port, "/",
                    )),
                )
                where += (" AND " if where else "WHERE ") + (
                    "lanius_scope_site(scheme, host, port) = 1"
                )
            if scope_predicate is None or scope_site_wide:
                from ..addons.endpoints import Endpoint, templatize

                total = self._read_conn.execute(
                    f"SELECT COUNT(*) FROM flow_endpoint_stats {where}", params,
                ).fetchone()[0]
                groups = self._read_conn.execute(
                    "SELECT scheme, host, port, method, template, flows, last_seen"
                    f" FROM flow_endpoint_stats {where}"
                    " ORDER BY host, template, method LIMIT ? OFFSET ?",
                    (*params, limit, offset),
                ).fetchall()
                items: list[dict[str, Any]] = []
                for group in groups:
                    key = tuple(group[column] for column in (
                        "scheme", "host", "port", "method", "template",
                    ))
                    statuses = self._read_conn.execute(
                        "SELECT status_code FROM flow_endpoint_status_stats"
                        " WHERE scheme = ? AND host = ? AND port = ?"
                        " AND method = ? AND template = ? ORDER BY status_code", key,
                    ).fetchall()
                    names = self._read_conn.execute(
                        "SELECT name FROM flow_endpoint_query_stats"
                        " WHERE scheme = ? AND host = ? AND port = ?"
                        " AND method = ? AND template = ? ORDER BY name", key,
                    ).fetchall()
                    samples = self._read_conn.execute(
                        "SELECT path, query FROM flow_endpoint_keys"
                        " WHERE scheme = ? AND host = ? AND port = ?"
                        " AND method = ? AND template = ?"
                        " ORDER BY started_at DESC LIMIT 100", key,
                    ).fetchall()
                    examples: list[str] = []
                    path_params: set[str] = set()
                    for sample in samples:
                        path = sample["path"] or "/"
                        example = path + (f"?{sample['query']}" if sample["query"] else "")
                        if len(examples) < 5 and example not in examples:
                            examples.append(example)
                        if len(path_params) < 100:
                            path_params.update(
                                value if len(value) <= 32 else f"{value[:29]}…"
                                for value in templatize(path)[1]
                            )
                    endpoint = Endpoint(
                        method=group["method"], scheme=group["scheme"],
                        host=group["host"],
                        port=None if group["port"] == -1 else group["port"],
                        template=group["template"], count=group["flows"],
                        statuses=[row[0] for row in statuses],
                        query_params=[row[0] for row in names],
                        path_params=sorted(path_params)[:100],
                        examples=examples, last_seen=group["last_seen"],
                    )
                    items.append(endpoint.as_dict())
                return {"items": items, "count": int(total)}

            def in_scope(scheme: str, name: str, port: int, path: str | None) -> int:
                return int(scope_predicate(
                    scheme, name, None if port == -1 else port, path,
                ))

            self._read_conn.create_function("lanius_scope_contains", 4, in_scope)
            scope_where = (where + " AND " if where else "WHERE ") + (
                "lanius_scope_contains(scheme, host, port, path) = 1"
            )
            rows = self._read_conn.execute(
                "SELECT scheme, host, port, method, template,"
                " COUNT(*) AS flows, MAX(started_at) AS last_seen"
                " FROM flow_endpoint_keys"
                f" {scope_where}"
                " GROUP BY scheme, host, port, method, template"
                " ORDER BY host, template, method LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
            # Count groups across the whole scope, including later pages.
            total = self._read_conn.execute(
                "SELECT COUNT(*) FROM ("
                "SELECT 1 FROM flow_endpoint_keys"
                f" {scope_where}"
                " GROUP BY scheme, host, port, method, template)", params,
            ).fetchone()[0]
            scoped_items: list[dict[str, Any]] = []
            for group in rows:
                key = tuple(group[column] for column in (
                    "scheme", "host", "port", "method", "template",
                ))
                cursor = self._read_conn.execute(
                    "SELECT method, scheme, host, port, path, query, status_code,"
                    " started_at FROM flow_endpoint_keys"
                    " WHERE scheme = ? AND host = ? AND port = ?"
                    " AND method = ? AND template = ?"
                    " AND lanius_scope_contains(scheme, host, port, path) = 1"
                    " ORDER BY started_at DESC", key,
                )

                def candidates() -> Iterable[dict[str, Any]]:
                    for row in cursor:
                        item = dict(row)
                        item["port"] = None if item["port"] == -1 else item["port"]
                        yield item

                scoped_items.extend(item.as_dict() for item in build_endpoints(candidates()))
            return {"items": scoped_items, "count": int(total)}

    def page_endpoint_flows(
        self, scheme: str, host: str, port: int | None, method: str,
        template: str, *, limit: int = 200, offset: int = 0,
        scope_predicate: Callable[[str | None, str | None, int | None, str | None], bool] | None = None,
        scope_site_wide: bool = False,
    ) -> dict[str, Any]:
        """Page one template through its indexed flow keys."""
        clauses = [
            "scheme = ?", "host = ?", "method = ?", "port = ?",
            "template = ?",
        ]
        params: list[Any] = [scheme, host, method.upper(), -1 if port is None else port, template]
        items: list[dict[str, Any]] = []
        count = 0
        with self._read_lock:
            if scope_site_wide and scope_predicate is not None:
                if not scope_predicate(scheme, host, port, "/"):
                    return {"items": [], "count": 0}
                scope_predicate = None
            if scope_predicate is None:
                total = self._read_conn.execute(
                    "SELECT flows FROM flow_endpoint_stats"
                    f" WHERE {' AND '.join(clauses)}", params,
                ).fetchone()
                rows = self._read_conn.execute(
                    "SELECT id, method, path, query, status_code, response_size,"
                    " started_at FROM flow_endpoint_keys"
                    f" WHERE {' AND '.join(clauses)}"
                    " ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
                    (*params, limit, offset),
                ).fetchall()
                return {"items": [dict(row) for row in rows],
                        "count": int(total[0]) if total else 0}
            cursor = self._read_conn.execute(
                "SELECT id, method, path, query, status_code, response_size,"
                " started_at FROM flow_endpoint_keys"
                f" WHERE {' AND '.join(clauses)}"
                " ORDER BY started_at DESC, id DESC",
                params,
            )
            for row in cursor:
                path = row["path"] or "/"
                if scope_predicate is not None and not scope_predicate(scheme, host, port, path):
                    continue
                if offset <= count < offset + limit:
                    items.append({**dict(row), "method": row["method"] or "GET"})
                count += 1
        return {"items": items, "count": count}

    def endpoint_candidates(self, host: str | None = None) -> List[dict[str, Any]]:
        """All HTTP requests with only the fields needed for grouping."""
        params: list[Any] = []
        where = "WHERE type = 'http' AND host IS NOT NULL"
        if host:
            where += " AND host LIKE ?"
            params.append(f"%{host}%")
        with self._lock:
            rows = self._conn.execute(
                "SELECT method, scheme, host, port, path, query, status_code,"
                f" started_at FROM flows {where} ORDER BY started_at DESC, rowid DESC",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def paths_for_endpoint(
        self, scheme: str, host: str, port: int | None, method: str, template: str
    ) -> List[dict[str, Any]]:
        """Every captured request belonging to one endpoint template."""
        from ..addons.endpoints import templatize

        clauses = [
            "type = 'http'", "COALESCE(scheme, 'http') = ?", "host = ?",
            "upper(COALESCE(method, 'GET')) = ?",
        ]
        params: list[Any] = [scheme, host, method.upper()]
        if port is None:
            clauses.append("port IS NULL")
        else:
            clauses.append("port = ?")
            params.append(port)
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, method, path, query, status_code, response_size,"
                " started_at FROM flows"
                f" WHERE {' AND '.join(clauses)}"
                " ORDER BY started_at DESC, rowid DESC",
                params,
            ).fetchall()
        return [
            {**dict(row), "method": row["method"] or "GET"}
            for row in rows
            if templatize(row["path"] or "/")[0] == template
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

    def all_paths_start_with_slash(self) -> bool:
        """Whether a /* scope rule applies equally to every saved path."""
        with self._read_lock:
            row = self._read_conn.execute(
                "SELECT 1 FROM flow_path_stats"
                " WHERE path != '' AND substr(path, 1, 1) != '/' LIMIT 1"
            ).fetchone()
        return row is None

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
        scope_predicate: Callable[[str | None, str | None, int | None, str | None], bool] | None = None,
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
            if scope_predicate is not None:
                cursor = self._read_conn.execute(
                    "SELECT id, method, path, query, status_code, response_size,"
                    " started_at, port FROM flows"
                    f" WHERE {' AND '.join(clauses)}"
                    " ORDER BY path, method, id", params,
                )
                items: list[dict[str, Any]] = []
                matched = 0
                for row in cursor:
                    if not scope_predicate(scheme, host, row["port"], row["path"]):
                        continue
                    if offset <= matched < offset + limit:
                        item = dict(row)
                        item.pop("port")
                        items.append(item)
                    matched += 1
                return {"items": items, "count": matched}
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

    def page_folders_for_site(
        self, scheme: str | None, host: str, port: int | None, *,
        path_prefix: str | None = None, limit: int = 200, offset: int = 0,
        port_is_null: bool = False,
        scope_predicate: Callable[[str | None, str | None, int | None, str | None], bool] | None = None,
    ) -> dict[str, Any]:
        """List immediate child paths, even when their flows are on late pages."""
        base = path_prefix.rstrip("/") if path_prefix else ""
        low = f"{base}/"
        high = f"{base}0" if base else "0"
        clauses = ["scheme = ?", "host = ?", "path >= ?", "path < ?"]
        params: list[Any] = [scheme or "", host, low, high]
        if port is not None or port_is_null:
            clauses.append("port = ?")
            params.append(-1 if port is None else port)
        items: list[str] = []
        cursor_path = low
        found = 0
        seen: set[str] = set()
        with self._read_lock:
            if scope_predicate is not None:
                cursor = self._read_conn.execute(
                    "SELECT path, port FROM flow_path_stats"
                    f" WHERE {' AND '.join(clauses)} ORDER BY path", params,
                )
                for row in cursor:
                    path = row["path"]
                    if not scope_predicate(
                        scheme, host, None if row["port"] == -1 else row["port"], path
                    ):
                        continue
                    child = path[len(low):].split("/", 1)[0]
                    if not child:
                        continue
                    folder = low + child
                    if folder in seen:
                        continue
                    seen.add(folder)
                    found += 1
                    if found > offset:
                        if len(items) == limit:
                            return {"items": items, "has_more": True}
                        items.append(folder)
                return {"items": items, "has_more": False}
            while True:
                row = self._read_conn.execute(
                    "SELECT path FROM flow_path_stats"
                    f" WHERE {' AND '.join(clauses)} AND path >= ?"
                    " ORDER BY path LIMIT 1",
                    (*params, cursor_path),
                ).fetchone()
                if row is None:
                    break
                child = row["path"][len(low):].split("/", 1)[0]
                if not child:
                    cursor_path = row["path"] + "\x00"
                    continue
                folder = low + child
                if folder in seen:
                    cursor_path = f"{folder}0"
                    continue
                seen.add(folder)
                found += 1
                if found > offset:
                    if len(items) == limit:
                        return {"items": items, "has_more": True}
                    items.append(folder)
                # An exact path sorts before sibling names containing '-'
                # or '.', which in turn sort before '/'. Scan those siblings
                # before jumping over this folder's descendants.
                cursor_path = (row["path"] + "\x00"
                               if row["path"] == folder else f"{folder}0")
        return {"items": items, "has_more": False}

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


def _folder_bounds(prefix: str) -> tuple[str, str]:
    stem = prefix.rstrip("/")
    return f"{stem}/", f"{stem}0"


def _row_to_record(row: sqlite3.Row) -> FlowRecord:
    return FlowRecord(
        id=row["id"],
        type=row["type"],
        client_addr=row["client_addr"],
        server_addr=row["server_addr"],
        local_source_ip=row["local_source_ip"],
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
