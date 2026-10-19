"""HTTP Content-Encoding helpers used by every body viewer/editor.

``Accept-Encoding`` only advertises what a client can receive.  A body is
compressed on the wire only when its own message has ``Content-Encoding``.
Keeping that distinction here prevents binary request formats such as
protobuf from being mistaken for gzip data.
"""

from __future__ import annotations

import io
import zlib
from collections.abc import Iterable
from typing import TYPE_CHECKING

import brotli
import zstandard
from mitmproxy.net import encoding

if TYPE_CHECKING:
    from .db.store import FlowStore

AUTO_DECOMPRESS_SETTING = "auto_decompress_bodies"


class BodyDisplayTooLarge(ValueError):
    """A decoded body crossed the caller's display-memory budget."""


def auto_decompress_enabled(store: FlowStore) -> bool:
    """The display setting defaults to on for new and existing projects."""
    return store.get_setting(AUTO_DECOMPRESS_SETTING, "1") != "0"


def content_encoding(headers: Iterable[tuple[str, str]] | None) -> str | None:
    for name, value in headers or []:
        if name.lower() == "content-encoding":
            return value.strip() or None
    return None


def _bounded_zlib(data: bytes, bits: int, limit: int) -> bytes:
    decoder = zlib.decompressobj(bits)
    result = decoder.decompress(data, limit + 1)
    if len(result) > limit or decoder.unconsumed_tail:
        raise BodyDisplayTooLarge("decoded body exceeds the display limit")
    result += decoder.flush(limit + 1 - len(result))
    if len(result) > limit:
        raise BodyDisplayTooLarge("decoded body exceeds the display limit")
    if not decoder.eof:
        raise ValueError("incomplete compressed body")
    return result


def _decode_one_bounded(data: bytes, coding: str, limit: int) -> bytes:
    if coding == "gzip":
        return _bounded_zlib(data, zlib.MAX_WBITS | 16, limit)
    if coding == "deflate":
        try:
            return _bounded_zlib(data, zlib.MAX_WBITS, limit)
        except zlib.error:
            return _bounded_zlib(data, -zlib.MAX_WBITS, limit)
    if coding == "br":
        decoder = brotli.Decompressor()
        pieces: list[bytes] = []
        size = 0
        for offset in range(0, len(data), 1024):
            part = decoder.process(data[offset:offset + 1024])
            size += len(part)
            if size > limit:
                raise BodyDisplayTooLarge("decoded body exceeds the display limit")
            pieces.append(part)
        if not decoder.is_finished():
            raise ValueError("incomplete compressed body")
        return b"".join(pieces)
    if coding == "zstd":
        with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data)) as stream:
            result = stream.read(limit + 1)
        if len(result) > limit:
            raise BodyDisplayTooLarge("decoded body exceeds the display limit")
        return result
    fallback_result = encoding.decode(data, coding)
    if not isinstance(fallback_result, bytes):
        raise ValueError(f"content coding {coding!r} did not produce bytes")
    if len(fallback_result) > limit:
        raise BodyDisplayTooLarge("decoded body exceeds the display limit")
    return fallback_result


def decode_content(
    body: bytes | None,
    value: str | None,
    *,
    max_output_bytes: int | None = None,
) -> bytes | None:
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
        if max_output_bytes is None:
            result = encoding.decode(decoded, coding)
            if not isinstance(result, bytes):
                raise ValueError(f"content coding {coding!r} did not produce bytes")
            decoded = result
        else:
            decoded = _decode_one_bounded(decoded, coding, max_output_bytes)
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
    max_output_bytes: int | None = None,
) -> tuple[bytes | None, str | None, bool, str | None]:
    """Return display bytes plus encoding/decode metadata.

    Invalid or unsupported encodings never make a captured flow disappear.
    The original bytes are shown and the error is surfaced to the UI.
    """
    value = content_encoding(headers)
    if body is None or not enabled or not value:
        return body, value, False, None
    try:
        return decode_content(
            body, value, max_output_bytes=max_output_bytes
        ), value, True, None
    except (TypeError, ValueError) as exc:
        return body, value, False, str(exc)


__all__ = [
    "AUTO_DECOMPRESS_SETTING",
    "BodyDisplayTooLarge",
    "auto_decompress_enabled",
    "body_for_display",
    "content_encoding",
    "decode_content",
    "encode_content",
]
