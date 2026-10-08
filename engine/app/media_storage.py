"""Limits for storing HTTP media bodies; never change forwarded traffic."""

from __future__ import annotations

from dataclasses import replace
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote

if TYPE_CHECKING:
    from .db.store import FlowRecord, RequestSnapshot

MEDIA_BODY_LIMIT_SETTING = "media_body_limit_mb"
DEFAULT_MEDIA_BODY_LIMIT_MB = 5
MAX_MEDIA_BODY_LIMIT_MB = 1024
MIB = 1024 * 1024
MEDIA_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg", ".tif", ".tiff",
    ".mp4", ".webm", ".mov", ".mkv", ".avi", ".mpeg", ".mpg", ".m4v", ".m4s", ".ts",
    ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".ogv", ".opus", ".flac",
})


def read_limit(value: str | None) -> int:
    try:
        limit = int(value) if value is not None else DEFAULT_MEDIA_BODY_LIMIT_MB
        return (
            limit if 0 <= limit <= MAX_MEDIA_BODY_LIMIT_MB
            else DEFAULT_MEDIA_BODY_LIMIT_MB
        )
    except ValueError:
        return DEFAULT_MEDIA_BODY_LIMIT_MB


def is_media(
    headers: list[tuple[str, str]] | None, path: str | None,
    fallback: str | None = None,
) -> bool:
    content_type = next(
        (value for name, value in headers or [] if name.lower() == "content-type"),
        fallback or "",
    )
    mime = content_type.partition(";")[0].strip().lower()
    if mime.startswith(("image/", "audio/", "video/")) or mime == "application/ogg":
        return True
    # A specific non-media MIME wins over a misleading file extension.
    return mime in {"", "application/octet-stream", "binary/octet-stream"} and (
        PurePosixPath(unquote((path or "").split("?", 1)[0]).lower()).suffix in MEDIA_EXTENSIONS
    )


def prepare_record(record: FlowRecord, limit_mb: int) -> FlowRecord:
    if not limit_mb or record.type != "http":
        return record
    limit = limit_mb * MIB
    changes: dict[str, Any] = {}
    if len(record.request_body) >= limit and is_media(record.request_headers, record.path):
        changes.update(
            request_body=b"", request_body_omitted=True,
            request_size=max(record.request_size, len(record.request_body)),
        )
    if (
        record.response_body is not None and len(record.response_body) >= limit
        and is_media(record.response_headers, record.path, record.response_mime)
    ):
        changes.update(
            response_body=b"", response_body_omitted=True,
            response_size=max(record.response_size, len(record.response_body)),
        )
    for key in ("request_original", "request_auto_modified"):
        snapshot: RequestSnapshot | None = getattr(record, key)
        if (
            snapshot is not None and len(snapshot.body) >= limit
            and is_media(snapshot.headers, snapshot.path)
        ):
            changes[key] = replace(snapshot, body=b"", body_omitted=True, body_size=len(snapshot.body))
    return replace(record, **changes) if changes else record
