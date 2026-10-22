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
from dataclasses import dataclass

# charset=... in a Content-Type header, quoted or not.
_CHARSET = re.compile(rb'charset\s*=\s*"?([\w.:+-]+)"?', re.IGNORECASE)
# <meta charset> and the older http-equiv form, within an HTML prologue.
_META_CHARSET = re.compile(
    rb'<meta[^>]+charset\s*=\s*["\']?\s*([\w.:+-]+)', re.IGNORECASE
)
# Runs produced when UTF-8 bytes were first mistaken for Latin-1 and the
# resulting characters were encoded as UTF-8 again.  Keeping this repair
# separate from ``decode`` matters: request editors rely on ``decode`` being
# byte-reversible, while a captured response is read-only display text.
_LATIN1_NON_ASCII_RUN = re.compile(r"[\x80-\xff]+")

DEFAULT_CHARSET = "utf-8"
LEGACY_KOREAN_CHARSET = "cp949"
SELECTABLE_CHARSETS = (
    "utf-8",
    "cp949",
    "euc_kr",
    "shift_jis",
    "gb18030",
    "big5",
    "cp1252",
    "iso8859-1",
    "utf-16-le",
    "utf-16-be",
)

# What a byte-order mark tells us, checked before anything the headers say
# because it is in the data itself.
_BOMS: list[tuple[bytes, str]] = [
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
]


@dataclass(frozen=True)
class DisplayDecode:
    """A tolerant, read-only decode and the facts the UI should disclose."""

    text: str
    had_errors: bool = False
    mojibake_detected: bool = False
    mojibake_repaired: bool = False


def normalise(name: str | None) -> str:
    """A charset name Python will accept, or the default."""
    if not name:
        return DEFAULT_CHARSET
    cleaned = name.strip().strip('"\'').lower()
    try:
        return codecs.lookup(cleaned).name
    except LookupError:
        return DEFAULT_CHARSET


def selectable(name: str) -> str:
    """Return an allowed manual display charset, or reject it.

    Python's codec registry also contains transforms such as base64 whose
    decoders do not return text. Manual HTTP body decoding intentionally
    exposes only common character encodings.
    """
    try:
        resolved = codecs.lookup(name.strip().strip('"\'').lower()).name
    except LookupError as exc:
        raise ValueError("unsupported charset") from exc
    if resolved not in SELECTABLE_CHARSETS:
        raise ValueError("unsupported charset")
    return resolved


def charset_from_headers(content_type: str | bytes | None) -> str | None:
    """The charset a Content-Type declares, if it declares one."""
    if content_type is None:
        return None
    raw = content_type.encode("latin-1", "replace") if isinstance(content_type, str) else content_type
    match = _CHARSET.search(raw)
    return match.group(1).decode("ascii", "replace") if match else None


def _legacy_korean_charset(content_type: str | None, body: bytes) -> str | None:
    """Recognise Korean HTML/plain text that omitted its charset.

    CP949 is a superset of EUC-KR and round-trips both encodings. Keep this
    deliberately narrow: guessing arbitrary binary data as a legacy text
    encoding would make the detail view misleading.
    """
    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    if media_type not in {"text/html", "text/plain", "application/xhtml+xml"}:
        return None
    try:
        text = body.decode(LEGACY_KOREAN_CHARSET)
    except UnicodeDecodeError:
        return None
    hangul = sum(
        "\uac00" <= char <= "\ud7a3"
        or "\u1100" <= char <= "\u11ff"
        or "\u3130" <= char <= "\u318f"
        for char in text
    )
    return LEGACY_KOREAN_CHARSET if hangul >= 2 else None


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
        declared_charset = normalise(declared)
        # A surprising number of legacy pages claim UTF-8 while sending
        # CP949. Only override that default when UTF-8 demonstrably fails
        # and the decoded text contains Korean, so explicit legacy charsets
        # and arbitrary binary bodies remain untouched.
        if body and declared_charset == DEFAULT_CHARSET:
            try:
                body.decode(DEFAULT_CHARSET)
            except UnicodeDecodeError:
                guessed = _legacy_korean_charset(content_type, body)
                if guessed:
                    return guessed
        return declared_charset

    if body:
        match = _META_CHARSET.search(body[:2048])
        if match:
            return normalise(match.group(1).decode("ascii", "replace"))

        try:
            body.decode(DEFAULT_CHARSET)
        except UnicodeDecodeError:
            guessed = _legacy_korean_charset(content_type, body)
            if guessed:
                return guessed

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


def decode_for_display(
    body: bytes | None,
    charset: str = DEFAULT_CHARSET,
    *,
    repair_mojibake: bool = False,
) -> DisplayDecode:
    """Decode read-only text like a browser, optionally repairing mojibake.

    A single invalid byte must not make the whole UTF-8 response fall back to
    Latin-1. Browsers keep the valid text and replace only the malformed
    sequence, so this path does the same. The byte-reversible ``decode`` above
    remains the right choice for request editors.

    A response can separately contain ``C3 AD C2 95 C2 9C`` where the intended
    UTF-8 bytes were ``ED 95 9C`` (``한``). That is genuine double encoding,
    not a charset choice. We detect it but only change the display when the
    user explicitly asks, because silently normalising captured bytes would
    hide evidence from a proxy user.
    """
    if not body:
        return DisplayDecode("")
    try:
        resolved = codecs.lookup(charset).name
    except LookupError:
        resolved = DEFAULT_CHARSET
    try:
        text = body.decode(resolved)
        had_errors = False
    except UnicodeDecodeError:
        text = body.decode(resolved, errors="replace")
        had_errors = True
    if resolved not in {"utf-8", "utf-8-sig"}:
        return DisplayDecode(text, had_errors=had_errors)

    detected = False

    def restore(match: re.Match[str]) -> str:
        nonlocal detected
        value = match.group(0)
        try:
            candidate = value.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return value
        # A Latin-1 run that happens to be ASCII after decoding is not useful
        # evidence.  Characters outside Latin-1 are strong evidence of the
        # UTF-8 -> Latin-1 -> UTF-8 corruption seen in Korean/CJK pages.
        if candidate == value or not any(ord(char) > 0xFF for char in candidate):
            return value
        detected = True
        return candidate if repair_mojibake else value

    displayed = _LATIN1_NON_ASCII_RUN.sub(restore, text)
    return DisplayDecode(
        displayed,
        had_errors=had_errors,
        mojibake_detected=detected,
        mojibake_repaired=detected and repair_mojibake,
    )


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



def complete_characters(body: bytes, charset: str = DEFAULT_CHARSET) -> bytes:
    """Drop a multi-byte character cut in half at the end of a byte window.

    A preview or chunk boundary lands mid-character in most non-ASCII text.
    Left in place, the split character makes the whole window fail to decode
    and fall back to Latin-1, and the next window starts with a fragment.
    Bodies that are invalid in ``charset`` anyway are returned unchanged.
    """
    if not body:
        return body
    try:
        decoder = codecs.getincrementaldecoder(charset)()
        decoder.decode(body, final=False)
        pending = len(decoder.getstate()[0])
    except (LookupError, UnicodeDecodeError, ValueError):
        return body
    return body[:-pending] if 0 < pending < len(body) else body


def charset_of_prefix(content_type: str | None, body: bytes | None) -> str:
    """:func:`charset_of` for the first bytes of a longer body."""
    return charset_of(content_type, complete_characters(body or b""))

__all__ = [
    "DEFAULT_CHARSET",
    "DisplayDecode",
    "SELECTABLE_CHARSETS",
    "charset_from_headers",
    "charset_of",
    "charset_of_prefix",
    "complete_characters",
    "decode",
    "decode_for_display",
    "decode_body",
    "encode",
    "normalise",
    "selectable",
]
