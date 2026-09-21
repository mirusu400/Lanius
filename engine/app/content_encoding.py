"""HTTP Content-Encoding helpers used by every body viewer/editor.

``Accept-Encoding`` only advertises what a client can receive.  A body is
compressed on the wire only when its own message has ``Content-Encoding``.
Keeping that distinction here prevents binary request formats such as
protobuf from being mistaken for gzip data.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING

from mitmproxy.net import encoding

if TYPE_CHECKING:
    from .db.store import FlowStore

AUTO_DECOMPRESS_SETTING = "auto_decompress_bodies"


def auto_decompress_enabled(store: FlowStore) -> bool:
    """The display setting defaults to on for new and existing projects."""
    return store.get_setting(AUTO_DECOMPRESS_SETTING, "1") != "0"


def content_encoding(headers: Iterable[tuple[str, str]] | None) -> str | None:
    for name, value in headers or []:
        if name.lower() == "content-encoding":
            return value.strip() or None
    return None


def decode_content(body: bytes | None, value: str | None) -> bytes | None:
    """Decode all HTTP content codings, in the reverse order applied."""
    if body is None or not value:
        return body
    decoded = body
    codings = [part.strip().lower() for part in value.split(",") if part.strip()]
    for coding in reversed(codings):
        if coding in {"identity", "none"}:
            continue
        if coding == "x-gzip":
            coding = "gzip"
        elif coding == "x-deflate":
            coding = "deflate"
        result = encoding.decode(decoded, coding)
        if not isinstance(result, bytes):
            raise ValueError(f"content coding {coding!r} did not produce bytes")
        decoded = result
    return decoded


def encode_content(body: bytes, value: str | None) -> bytes:
    """Apply HTTP content codings in header order."""
    if not value:
        return body
    encoded = body
    for coding in [part.strip().lower() for part in value.split(",") if part.strip()]:
        if coding in {"identity", "none"}:
            continue
        if coding == "x-gzip":
            coding = "gzip"
        elif coding == "x-deflate":
            coding = "deflate"
        result = encoding.encode(encoded, coding)
        if not isinstance(result, bytes):
            raise ValueError(f"content coding {coding!r} did not produce bytes")
        encoded = result
    return encoded


def body_for_display(
    headers: Iterable[tuple[str, str]] | None,
    body: bytes | None,
    *,
    enabled: bool,
) -> tuple[bytes | None, str | None, bool, str | None]:
    """Return display bytes plus encoding/decode metadata.

    Invalid or unsupported encodings never make a captured flow disappear.
    The original bytes are shown and the error is surfaced to the UI.
    """
    value = content_encoding(headers)
    if body is None or not enabled or not value:
        return body, value, False, None
    try:
        return decode_content(body, value), value, True, None
    except (TypeError, ValueError) as exc:
        return body, value, False, str(exc)


__all__ = [
    "AUTO_DECOMPRESS_SETTING",
    "auto_decompress_enabled",
    "body_for_display",
    "content_encoding",
    "decode_content",
    "encode_content",
]
