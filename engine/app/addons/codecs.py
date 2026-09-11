"""Decoder / Comparer utilities (M6).

Pure, dependency-light transforms shared by the UI and (later) plugins.
"""

from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import html
import json
import urllib.parse
import zlib
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Callable, Literal


class CodecError(Exception):
    """Unknown codec or undecodable input (mapped to HTTP 4xx)."""


Direction = Literal["encode", "decode"]


def _b64_decode(value: str) -> str:
    padded = value + "=" * (-len(value) % 4)
    try:
        return base64.b64decode(padded, validate=False).decode(
            "utf-8", errors="replace"
        )
    except (binascii.Error, ValueError) as exc:
        raise CodecError(f"invalid base64: {exc}") from exc


def _b64url_decode(value: str) -> str:
    padded = value + "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace")
    except (binascii.Error, ValueError) as exc:
        raise CodecError(f"invalid base64url: {exc}") from exc


def _hex_decode(value: str) -> str:
    cleaned = "".join(value.split()).removeprefix("0x")
    try:
        return bytes.fromhex(cleaned).decode("utf-8", errors="replace")
    except ValueError as exc:
        raise CodecError(f"invalid hex: {exc}") from exc


def _gzip_encode(value: str) -> str:
    return base64.b64encode(gzip.compress(value.encode())).decode()


def _gzip_decode(value: str) -> str:
    # Strict validation: without it, junk like "!!!" silently decodes to b""
    # and gzip.decompress happily returns an empty string.
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CodecError(f"invalid base64 for gzip: {exc}") from exc
    if not raw:
        raise CodecError("no gzip data")
    try:
        return gzip.decompress(raw).decode("utf-8", errors="replace")
    except (OSError, zlib.error) as exc:
        raise CodecError(f"invalid gzip data: {exc}") from exc


def _jwt_decode(value: str) -> str:
    """Decode a JWT's header and payload (signature is not verified)."""
    parts = value.strip().split(".")
    if len(parts) < 2:
        raise CodecError("not a JWT (expected at least two dot-separated parts)")
    try:
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
    except json.JSONDecodeError as exc:
        raise CodecError(f"invalid JWT segment: {exc}") from exc
    return json.dumps(
        {
            "header": header,
            "payload": payload,
            "signature": parts[2] if len(parts) > 2 else None,
            "verified": False,
        },
        indent=2,
        ensure_ascii=False,
    )


CODECS: dict[str, dict[Direction, Callable[[str], str]]] = {
    "url": {
        "encode": lambda v: urllib.parse.quote(v, safe=""),
        "decode": urllib.parse.unquote,
    },
    "url_plus": {
        "encode": urllib.parse.quote_plus,
        "decode": urllib.parse.unquote_plus,
    },
    "base64": {
        "encode": lambda v: base64.b64encode(v.encode()).decode(),
        "decode": _b64_decode,
    },
    "base64url": {
        "encode": lambda v: base64.urlsafe_b64encode(v.encode())
        .decode()
        .rstrip("="),
        "decode": _b64url_decode,
    },
    "hex": {
        "encode": lambda v: v.encode().hex(),
        "decode": _hex_decode,
    },
    "html": {
        "encode": lambda v: html.escape(v, quote=True),
        "decode": html.unescape,
    },
    "gzip": {"encode": _gzip_encode, "decode": _gzip_decode},
    "jwt": {
        "encode": lambda v: (_ for _ in ()).throw(
            CodecError("jwt supports decode only")
        ),
        "decode": _jwt_decode,
    },
}

HASHES = ("md5", "sha1", "sha256", "sha512")


def transform(value: str, codec: str, direction: Direction) -> str:
    if codec in HASHES:
        if direction == "decode":
            raise CodecError(f"{codec} is a hash and cannot be decoded")
        return hashlib.new(codec, value.encode()).hexdigest()
    if codec not in CODECS:
        raise CodecError(f"unknown codec: {codec!r}")
    if direction not in ("encode", "decode"):
        raise CodecError(f"unknown direction: {direction!r}")
    return CODECS[codec][direction](value)


@dataclass(slots=True)
class ChainStep:
    codec: str
    direction: Direction


def run_chain(value: str, steps: list[ChainStep]) -> list[dict[str, Any]]:
    """Apply steps in order, returning the output after each one."""
    outputs: list[dict[str, Any]] = []
    current = value
    for step in steps:
        current = transform(current, step.codec, step.direction)
        outputs.append(
            {"codec": step.codec, "direction": step.direction, "value": current}
        )
    return outputs


def available_codecs() -> dict[str, list[str]]:
    return {
        "codecs": sorted(CODECS),
        "hashes": list(HASHES),
    }


# --- comparer -------------------------------------------------------------


def compare(left: str, right: str, mode: Literal["word", "byte"] = "word") -> dict[str, Any]:
    """Diff two texts at word or character granularity."""
    if mode == "word":
        left_tokens = left.split()
        right_tokens = right.split()
        joiner = " "
    elif mode == "byte":
        left_tokens = list(left)
        right_tokens = list(right)
        joiner = ""
    else:
        raise CodecError(f"unknown compare mode: {mode!r}")

    matcher = SequenceMatcher(None, left_tokens, right_tokens, autojunk=False)
    blocks: list[dict[str, Any]] = []
    added = removed = unchanged = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        left_part = joiner.join(left_tokens[i1:i2])
        right_part = joiner.join(right_tokens[j1:j2])
        if tag == "equal":
            unchanged += i2 - i1
        elif tag == "delete":
            removed += i2 - i1
        elif tag == "insert":
            added += j2 - j1
        else:  # replace
            removed += i2 - i1
            added += j2 - j1
        blocks.append(
            {"tag": tag, "left": left_part, "right": right_part}
        )

    return {
        "mode": mode,
        "blocks": blocks,
        "added": added,
        "removed": removed,
        "unchanged": unchanged,
        "similarity": round(matcher.ratio(), 4),
        "identical": left == right,
    }
