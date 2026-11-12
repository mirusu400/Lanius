"""Trigram index for literal search across captured HTTP text."""

from __future__ import annotations

import base64
import json
import sqlite3

from .. import charset
from ..content_encoding import body_for_display

# Full bodies remain in flows. The trigram index is only for search, and
# indexing a very large response can monopolize SQLite for minutes.
MAX_INDEX_BODY_BYTES = 8 * 1024 * 1024


def _headers(raw: str | None) -> list[tuple[str, str]]:
    try:
        return [(str(k), str(v)) for k, v in json.loads(raw or "[]")]
    except (TypeError, ValueError):
        return []


def _body_text(raw: bytes | None, headers: list[tuple[str, str]]) -> str:
    if not raw or len(raw) > MAX_INDEX_BODY_BYTES:
        return ""
    try:
        shown, _, _, _ = body_for_display(headers, raw, enabled=True)
    except Exception:
        # A malformed content coding must never make capture persistence fail.
        shown = raw
    if not shown or len(shown) > MAX_INDEX_BODY_BYTES:
        return ""
    content_type = next((value for name, value in headers if name.lower() == "content-type"), None)
    return charset.decode_body(content_type, shown)


def _snapshot_text(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        item = json.loads(raw)
        headers = [(str(k), str(v)) for k, v in item.get("headers", [])]
        body = base64.b64decode(item.get("body") or "", validate=True)
        return "\n".join([
            *(str(item.get(key) or "") for key in ("method", "host", "path")),
            *(f"{key}: {value}" for key, value in headers),
            _body_text(body, headers),
        ])
    except (TypeError, ValueError, KeyError):
        return raw


def _request_urls(scheme: object, host: object, port: object,
                  path: object, query: object) -> list[str]:
    if not host:
        return []
    host_path = f"{host}{path or ''}"
    suffix = f"?{query}" if query else ""
    urls = [host_path + suffix]
    if scheme:
        default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
        port_text = f":{port}" if port is not None and not default_port else ""
        urls.append(f"{scheme}://{host}{port_text}{path or ''}{suffix}")
    return urls


def search_text(*values: object) -> str:
    (method, host, path, query, request_headers, request_body,
     response_headers, response_body, comment, reason, error,
     request_original, request_auto_modified, scheme, port, http_version,
     status_code, response_mime, source, client_addr, server_addr) = values
    req_headers = _headers(request_headers if isinstance(request_headers, str) else None)
    resp_headers = _headers(response_headers if isinstance(response_headers, str) else None)
    return "\n".join([
        *_request_urls(scheme, host, port, path, query),
        *(str(value) if value is not None else "" for value in (
            method, host, path, query, comment, reason, error, scheme, port,
            http_version, status_code, response_mime, source, client_addr,
            server_addr,
        )),
        *(f"{key}: {value}" for key, value in req_headers),
        *(f"{key}: {value}" for key, value in resp_headers),
        _body_text(request_body if isinstance(request_body, bytes) else None, req_headers),
        _body_text(response_body if isinstance(response_body, bytes) else None, resp_headers),
        _snapshot_text(request_original if isinstance(request_original, str) else None),
        _snapshot_text(request_auto_modified if isinstance(request_auto_modified, str) else None),
    ]).replace("\x00", "\n").casefold()


def register_functions(conn: sqlite3.Connection) -> None:
    conn.create_function("lanius_flow_search_text", 21, search_text, deterministic=True)


_FIELDS = (
    "method, host, path, query, request_headers, request_body, "
    "response_headers, response_body, comment, reason, error, "
    "request_original, request_auto_modified, scheme, port, http_version, "
    "status_code, response_mime, source, client_addr, server_addr"
)
_NEW = ", ".join(f"NEW.{field.strip()}" for field in _FIELDS.split(","))

REINDEX_MIGRATION = (
    "DELETE FROM flow_search",
    f"INSERT INTO flow_search(rowid, text) SELECT rowid, lanius_flow_search_text({_FIELDS}) FROM flows",
)

MIGRATION: tuple[str, ...] = (
    "CREATE VIRTUAL TABLE flow_search USING fts5(text, tokenize='trigram')",
    f"INSERT INTO flow_search(rowid, text) SELECT rowid, lanius_flow_search_text({_FIELDS}) FROM flows",
    f"""CREATE TRIGGER flow_search_insert AFTER INSERT ON flows BEGIN
        INSERT INTO flow_search(rowid, text) VALUES (NEW.rowid, lanius_flow_search_text({_NEW}));
    END""",
    """CREATE TRIGGER flow_search_delete AFTER DELETE ON flows BEGIN
        DELETE FROM flow_search WHERE rowid = OLD.rowid;
    END""",
    f"""CREATE TRIGGER flow_search_update AFTER UPDATE ON flows BEGIN
        DELETE FROM flow_search WHERE rowid = OLD.rowid;
        INSERT INTO flow_search(rowid, text) VALUES (NEW.rowid, lanius_flow_search_text({_NEW}));
    END""",
)
