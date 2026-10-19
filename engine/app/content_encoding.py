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


def _zlib_prefix(
    data: bytes, bits: int, limit: int, *, input_complete: bool
) -> tuple[bytes, bool]:
    decoder = zlib.decompressobj(bits)
    result = decoder.decompress(data, limit + 1)
    if len(result) <= limit and not decoder.unconsumed_tail:
        result += decoder.flush(limit + 1 - len(result))
    if len(result) > limit or decoder.unconsumed_tail:
        return result[:limit], True
    if not decoder.eof:
        if input_complete:
            raise ValueError("incomplete compressed body")
        return result, True
    return result, False


def _decode_one_prefix(
    data: bytes, coding: str, limit: int, *, input_complete: bool
) -> tuple[bytes, bool]:
    """At most ``limit`` decoded bytes, and whether more output exists.

    ``input_complete=False`` means ``data`` is itself a prefix of the coded
    stream, so running out of input is expected rather than corruption.
    Decoder-specific errors become ``ValueError`` so a damaged capture is
    reported in the body view instead of failing the whole request.
    """
    try:
        if coding == "gzip":
            return _zlib_prefix(
                data, zlib.MAX_WBITS | 16, limit, input_complete=input_complete
            )
        if coding == "deflate":
            try:
                return _zlib_prefix(
                    data, zlib.MAX_WBITS, limit, input_complete=input_complete
                )
            except zlib.error:
                return _zlib_prefix(
                    data, -zlib.MAX_WBITS, limit, input_complete=input_complete
                )
        if coding == "br":
            decoder = brotli.Decompressor()
            pieces: list[bytes] = []
            size = 0
            for offset in range(0, len(data), 1024):
                part = decoder.process(data[offset:offset + 1024])
                pieces.append(part)
                size += len(part)
                if size > limit:
                    return b"".join(pieces)[:limit], True
            if not decoder.is_finished():
                if input_complete:
                    raise ValueError("incomplete compressed body")
                return b"".join(pieces), True
            return b"".join(pieces), False
        if coding == "zstd":
            # stream_reader.read() may return less than requested before the
            # end of the stream, so read until EOF or past the budget.
            pieces = []
            size = 0
            with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data)) as stream:
                while size <= limit:
                    part = stream.read(limit + 1 - size)
                    if not part:
                        break
                    pieces.append(part)
                    size += len(part)
            result = b"".join(pieces)
            if len(result) > limit:
                return result[:limit], True
            return result, not input_complete
    except (zlib.error, brotli.error, zstandard.ZstdError) as exc:
        raise ValueError(f"cannot decode {coding} body: {exc}") from exc
    fallback_result = encoding.decode(data, coding)
    if not isinstance(fallback_result, bytes):
        raise ValueError(f"content coding {coding!r} did not produce bytes")
    if len(fallback_result) > limit:
        return fallback_result[:limit], True
    return fallback_result, not input_complete


def _decode_one_bounded(data: bytes, coding: str, limit: int) -> bytes:
    result, cut = _decode_one_prefix(data, coding, limit, input_complete=True)
    if cut:
        raise BodyDisplayTooLarge("decoded body exceeds the display limit")
    return result


def _codings(value: str) -> list[str]:
    """Content codings in the reverse of the order they were applied."""
    codings = []
    for part in reversed(value.split(",")):
        coding = part.strip().lower()
        if not coding or coding in {"identity", "none"}:
            continue
        codings.append({"x-gzip": "gzip", "x-deflate": "deflate"}.get(coding, coding))
    return codings


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
    for coding in _codings(value):
        if max_output_bytes is None:
            result = encoding.decode(decoded, coding)
            if not isinstance(result, bytes):
                raise ValueError(f"content coding {coding!r} did not produce bytes")
            decoded = result
        else:
            decoded = _decode_one_bounded(decoded, coding, max_output_bytes)
    return decoded


def decode_content_prefix(
    body: bytes, value: str, limit: int, *, input_complete: bool
) -> tuple[bytes, bool]:
    """The first ``limit`` decoded bytes of a possibly truncated coded body.

    Returns the bytes and whether the decoded body continues beyond them.
    Only a prefix can be decoded this way: a window from the middle of a
    compressed stream has no decoder state to start from.
    """
    decoded = body
    cut = not input_complete
    for coding in _codings(value):
        decoded, stage_cut = _decode_one_prefix(
            decoded, coding, limit, input_complete=not cut
        )
        cut = cut or stage_cut
    return decoded[:limit], cut or len(decoded) > limit


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



def body_prefix_for_display(
    headers: Iterable[tuple[str, str]] | None,
    body: bytes | None,
    *,
    enabled: bool,
    limit: int,
    input_complete: bool = True,
) -> tuple[bytes | None, str | None, bool, str | None, bool]:
    """Like :func:`body_for_display`, but for a bounded preview window.

    ``body`` may be a prefix of the stored bytes (``input_complete=False``).
    The fifth value says whether the shown bytes stop before the end of the
    (decoded) body.  A compressed body that expands past ``limit`` shows its
    first ``limit`` decoded bytes instead of an error.
    """
    value = content_encoding(headers)
    if body is None:
        return None, value, False, None, False
    raw_cut = len(body) > limit or not input_complete
    if not enabled or not value:
        return body[:limit], value, False, None, raw_cut
    try:
        shown, cut = decode_content_prefix(
            body, value, limit, input_complete=input_complete
        )
    except (TypeError, ValueError) as exc:
        return body[:limit], value, False, str(exc), raw_cut
    return shown, value, True, None, cut

__all__ = [
    "AUTO_DECOMPRESS_SETTING",
    "BodyDisplayTooLarge",
    "auto_decompress_enabled",
    "body_for_display",
    "body_prefix_for_display",
    "content_encoding",
    "decode_content",
    "decode_content_prefix",
    "encode_content",
]
