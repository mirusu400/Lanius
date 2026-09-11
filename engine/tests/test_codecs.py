from __future__ import annotations

import base64
import json

import pytest

from app.addons.codecs import (
    ChainStep,
    CodecError,
    available_codecs,
    compare,
    run_chain,
    transform,
)


# --- individual codecs ----------------------------------------------------


@pytest.mark.parametrize(
    "codec,plain,encoded",
    [
        ("url", "a b&c=d", "a%20b%26c%3Dd"),
        ("url_plus", "a b", "a+b"),
        ("base64", "hello", "aGVsbG8="),
        ("hex", "hi", "6869"),
        ("html", "<script>", "&lt;script&gt;"),
    ],
)
def test_roundtrip(codec: str, plain: str, encoded: str) -> None:
    assert transform(plain, codec, "encode") == encoded
    assert transform(encoded, codec, "decode") == plain


def test_base64url_strips_padding() -> None:
    encoded = transform("hello!", "base64url", "encode")
    assert "=" not in encoded
    assert transform(encoded, "base64url", "decode") == "hello!"


def test_base64_decode_tolerates_missing_padding() -> None:
    assert transform("aGVsbG8", "base64", "decode") == "hello"


def test_hex_decode_ignores_whitespace_and_prefix() -> None:
    assert transform("68 69", "hex", "decode") == "hi"
    assert transform("0x6869", "hex", "decode") == "hi"


def test_gzip_roundtrip() -> None:
    encoded = transform("compress me" * 10, "gzip", "encode")
    assert transform(encoded, "gzip", "decode") == "compress me" * 10


def test_gzip_decode_rejects_non_gzip() -> None:
    with pytest.raises(CodecError):
        transform(base64.b64encode(b"plain").decode(), "gzip", "decode")


def test_jwt_decode_exposes_header_and_payload() -> None:
    header = base64.urlsafe_b64encode(b'{"alg":"HS256"}').decode().rstrip("=")
    payload = (
        base64.urlsafe_b64encode(b'{"sub":"admin","role":"user"}')
        .decode()
        .rstrip("=")
    )
    decoded = json.loads(transform(f"{header}.{payload}.sig", "jwt", "decode"))
    assert decoded["header"]["alg"] == "HS256"
    assert decoded["payload"]["sub"] == "admin"
    assert decoded["signature"] == "sig"
    assert decoded["verified"] is False


def test_jwt_rejects_non_jwt() -> None:
    with pytest.raises(CodecError):
        transform("notajwt", "jwt", "decode")


def test_jwt_encode_is_unsupported() -> None:
    with pytest.raises(CodecError):
        transform("x", "jwt", "encode")


def test_hashes() -> None:
    assert transform("abc", "md5", "encode") == "900150983cd24fb0d6963f7d28e17f72"
    assert transform("abc", "sha256", "encode").startswith("ba7816bf")
    with pytest.raises(CodecError):
        transform("abc", "sha256", "decode")


def test_unknown_codec_and_direction() -> None:
    with pytest.raises(CodecError):
        transform("x", "rot13", "encode")
    with pytest.raises(CodecError):
        transform("x", "url", "sideways")  # type: ignore[arg-type]


def test_invalid_hex_raises() -> None:
    with pytest.raises(CodecError):
        transform("zz", "hex", "decode")


def test_available_codecs_lists_everything() -> None:
    listed = available_codecs()
    assert "base64" in listed["codecs"]
    assert "sha256" in listed["hashes"]


# --- chains ---------------------------------------------------------------


def test_chain_applies_steps_in_order() -> None:
    # url-encoded base64 is a classic layered payload
    value = transform(transform("secret", "base64", "encode"), "url", "encode")
    outputs = run_chain(
        value,
        [ChainStep("url", "decode"), ChainStep("base64", "decode")],
    )
    assert outputs[-1]["value"] == "secret"
    assert len(outputs) == 2


def test_empty_chain_returns_nothing() -> None:
    assert run_chain("x", []) == []


def test_chain_failure_propagates() -> None:
    with pytest.raises(CodecError):
        run_chain("!!!", [ChainStep("gzip", "decode")])


# --- comparer -------------------------------------------------------------


def test_compare_identical_texts() -> None:
    result = compare("same text here", "same text here")
    assert result["identical"] is True
    assert result["added"] == 0
    assert result["removed"] == 0
    assert result["similarity"] == 1.0


def test_compare_detects_word_changes() -> None:
    result = compare("the quick brown fox", "the slow brown fox")
    assert result["identical"] is False
    assert result["added"] == 1
    assert result["removed"] == 1
    tags = [b["tag"] for b in result["blocks"]]
    assert "replace" in tags


def test_compare_detects_insertions() -> None:
    result = compare("a b", "a b c")
    assert result["added"] == 1
    assert result["removed"] == 0


def test_compare_detects_deletions() -> None:
    result = compare("a b c", "a b")
    assert result["removed"] == 1
    assert result["added"] == 0


def test_compare_byte_mode_is_character_granular() -> None:
    result = compare("abc", "abd", mode="byte")
    assert result["added"] == 1
    assert result["removed"] == 1
    assert result["unchanged"] == 2


def test_compare_rejects_unknown_mode() -> None:
    with pytest.raises(CodecError):
        compare("a", "b", mode="quantum")  # type: ignore[arg-type]


def test_compare_empty_inputs() -> None:
    assert compare("", "")["identical"] is True
    assert compare("", "new")["added"] == 1


def test_gzip_decode_rejects_invalid_base64() -> None:
    """Regression: lax base64 decoding turned junk into an empty success."""
    for junk in ["!!!", "@@@@", "not base64 at all!"]:
        with pytest.raises(CodecError):
            transform(junk, "gzip", "decode")


def test_gzip_decode_rejects_empty_input() -> None:
    with pytest.raises(CodecError):
        transform("", "gzip", "decode")
