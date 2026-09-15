"""Turning bytes into text and back without losing anything.

A proxy sees bytes, but an editor needs text. Going through UTF-8 in both
directions works until the site is not UTF-8: a Korean page served as
EUC-KR became replacement characters, and what came back out was no
longer the bytes that went in. That is worse than useless in a tool whose
job is to show exactly what crossed the wire.

The approach here is: decode with the charset the message declares, and
encode back with the same one, so a round trip through the editor is
byte-identical when the text was not changed.
"""

from __future__ import annotations

import codecs
import re

# charset=... in a Content-Type header, quoted or not.
_CHARSET = re.compile(rb'charset\s*=\s*"?([\w.:+-]+)"?', re.IGNORECASE)
# <meta charset> and the older http-equiv form, within an HTML prologue.
_META_CHARSET = re.compile(
    rb'<meta[^>]+charset\s*=\s*["\']?\s*([\w.:+-]+)', re.IGNORECASE
)

DEFAULT_CHARSET = "utf-8"

# What a byte-order mark tells us, checked before anything the headers say
# because it is in the data itself.
_BOMS: list[tuple[bytes, str]] = [
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
]


def normalise(name: str | None) -> str:
    """A charset name Python will accept, or the default."""
    if not name:
        return DEFAULT_CHARSET
    cleaned = name.strip().strip('"\'').lower()
    try:
        return codecs.lookup(cleaned).name
    except LookupError:
        return DEFAULT_CHARSET


def charset_from_headers(content_type: str | bytes | None) -> str | None:
    """The charset a Content-Type declares, if it declares one."""
    if content_type is None:
        return None
    raw = content_type.encode("latin-1", "replace") if isinstance(content_type, str) else content_type
    match = _CHARSET.search(raw)
    return match.group(1).decode("ascii", "replace") if match else None


def charset_of(content_type: str | None, body: bytes | None) -> str:
    """Work out how to read this body.

    In order: a byte-order mark, then the Content-Type, then a meta tag in
    the markup, then UTF-8. The BOM comes first because a server that
    mislabels UTF-16 as UTF-8 is common, and the mark is unambiguous.
    """
    if body:
        for bom, name in _BOMS:
            if body.startswith(bom):
                return name

    declared = charset_from_headers(content_type)
    if declared:
        return normalise(declared)

    if body:
        match = _META_CHARSET.search(body[:2048])
        if match:
            return normalise(match.group(1).decode("ascii", "replace"))

    return DEFAULT_CHARSET


def decode(body: bytes | None, charset: str = DEFAULT_CHARSET) -> str:
    """Bytes to text, falling back rather than raising.

    Binary bodies and mislabelled ones still have to be shown, so this
    never fails; callers that need the original bytes keep them instead of
    relying on the text being reversible.
    """
    if not body:
        return ""
    try:
        return body.decode(charset)
    except (UnicodeDecodeError, LookupError):
        pass
    if charset != DEFAULT_CHARSET:
        try:
            return body.decode(DEFAULT_CHARSET)
        except UnicodeDecodeError:
            pass
    # Last resort: keep every byte recoverable rather than dropping it.
    return body.decode("latin-1")


def encode(text: str, charset: str = DEFAULT_CHARSET) -> bytes:
    """Text back to bytes in the charset this endpoint speaks.

    Characters the charset cannot express are escaped as XML character
    references rather than dropped, which is what a browser does when a
    form is submitted to a legacy page.
    """
    if not text:
        return b""
    try:
        return text.encode(charset)
    except (UnicodeEncodeError, LookupError):
        pass
    try:
        return text.encode(charset, errors="xmlcharrefreplace")
    except LookupError:
        return text.encode(DEFAULT_CHARSET)


def decode_body(content_type: str | None, body: bytes | None) -> str:
    """Decode using whatever the message says about itself."""
    return decode(body, charset_of(content_type, body))


__all__ = [
    "DEFAULT_CHARSET",
    "charset_from_headers",
    "charset_of",
    "decode",
    "decode_body",
    "encode",
    "normalise",
]
