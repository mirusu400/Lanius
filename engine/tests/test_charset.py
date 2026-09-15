"""Sites that are not UTF-8.

A proxy that assumes UTF-8 quietly destroys Korean, Japanese and anything
else on a legacy page: decoding EUC-KR as UTF-8 yields replacement
characters, and those cannot be turned back into the original bytes. The
tests here go through the real engine against real servers, because the
failure is about what arrives on the wire, not about a function's return
value.
"""

from __future__ import annotations

import asyncio
import socket
import urllib.request
from pathlib import Path

import pytest

from app import charset
from app.addons.repeater import build_flow
from app.config import Settings
from app.db.store import FlowStore
from app.events import EventBroker
from app.proxy import ProxyEngine

from .charset_server import serve


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def site():
    port = free_port()
    server = serve(port)
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


def _engine(tmp_path: Path) -> ProxyEngine:
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "c.sqlite",
        confdir=tmp_path / "mitm",
    )
    return ProxyEngine(settings, FlowStore(settings.db_path), EventBroker())


CASES = [
    ("euckr", "euc-kr", "한글 전송 테스트"),
    ("utf8", "utf-8", "한글 ✓ 日本語 🎯"),
    ("utf16", "utf-16", "한글 ✓ 日本語"),
    ("sjis", "shift_jis", "日本語テスト"),
]


def test_charset_is_taken_from_the_headers() -> None:
    assert charset.charset_of("text/html; charset=euc-kr", None) == "euc_kr"
    assert charset.charset_of('text/html; charset="EUC-KR"', None) == "euc_kr"
    # A byte-order mark beats the header, because servers mislabel UTF-16.
    assert charset.charset_of("text/html; charset=utf-8", "가".encode("utf-16")) in {
        "utf-16",
        "utf-16-le",
    }
    # Then a meta tag, then the default.
    assert charset.charset_of(None, b'<meta charset="euc-kr">') == "euc_kr"
    assert charset.charset_of(None, b"plain") == "utf-8"
    # An unknown name must not crash the proxy.
    assert charset.charset_of("text/html; charset=nonsense-9", None) == "utf-8"


def test_round_trip_keeps_the_original_bytes() -> None:
    """Decoding then encoding has to give back what came in, or an edit in
    the UI silently rewrites a body the user never touched."""
    for _, name, text in CASES:
        raw = text.encode(name)
        assert charset.encode(charset.decode(raw, name), name) == raw


def test_undecodable_bytes_are_not_destroyed() -> None:
    """errors='replace' loses the original for good. Binary bodies still
    have to survive being shown."""
    raw = bytes(range(256))
    assert charset.encode(charset.decode(raw, "utf-8"), "latin-1") == raw


def test_characters_a_charset_cannot_express_are_escaped() -> None:
    """An emoji cannot be EUC-KR. Dropping it silently would change the
    request; a browser escapes it instead."""
    encoded = charset.encode("가 🎯", "euc-kr")
    assert encoded.decode("euc-kr") == "가 &#127919;"


def test_repeater_sends_the_body_in_the_declared_charset(tmp_path, site) -> None:
    """The point of the whole exercise: Korean typed into Repeater has to
    reach an EUC-KR endpoint as EUC-KR."""

    async def run() -> None:
        engine = _engine(tmp_path)
        await engine.start()
        try:
            for path, name, text in CASES:
                flow = build_flow(
                    url=f"{site}/{path}",
                    method="POST",
                    headers=[
                        ["Host", site.removeprefix("http://")],
                        ["Content-Type", f"text/plain; charset={name}"],
                    ],
                    body=text,
                    http_version="HTTP/1.1",
                )
                # The bytes on the wire are the charset the site speaks.
                assert flow.request.raw_content == text.encode(name), path
                # And the length is declared, or the server reads nothing.
                assert flow.request.headers["content-length"] == str(
                    len(text.encode(name))
                ), path

                record = await engine.repeater.send(flow, timeout=15)
                body = (record.response_body or b"").decode(name, "replace")
                assert "verdict=ok" in body, f"{path}: {body[:120]}"
                assert text.encode(name).hex() in body, (
                    f"{path}: the server did not receive the same bytes"
                )
        finally:
            await engine.stop()

    asyncio.run(run())


def test_a_captured_page_is_shown_in_its_own_charset(tmp_path, site) -> None:
    """A EUC-KR page used to arrive as replacement characters."""

    async def run() -> None:
        engine = _engine(tmp_path)
        await engine.start()
        try:
            # Spoken directly rather than through a client library: every
            # one of them bypasses a proxy for localhost, which is where
            # the test server is, and the request would never be seen.
            host = engine.settings.proxy_host
            port = engine.settings.proxy_port
            for path, _name, _text in CASES:
                reader, writer = await asyncio.open_connection(host, port)
                writer.write(
                    f"GET {site}/{path} HTTP/1.1\r\n"
                    f"Host: {site.removeprefix('http://')}\r\n"
                    "Connection: close\r\n\r\n".encode()
                )
                await writer.drain()
                await reader.read()
                writer.close()
                await writer.wait_closed()
            # Saving is queued off the hook, so wait for it rather than
            # guessing at a sleep.
            await engine.capture.done()

            for path, name, _ in CASES:
                rows = engine.store.list(limit=200)
                match = next(
                    (r for r in rows if r.path == f"/{path}"), None
                )
                assert match is not None, path
                detail = engine.store.get(match.id).detail()
                assert detail["response_charset"] == charset.normalise(name), path
                # Hangul survives, rather than becoming U+FFFD.
                assert "\ufffd" not in (detail["response_body"] or ""), path
                if path != "sjis":
                    assert "한글" in detail["response_body"], path
        finally:
            await engine.stop()

    asyncio.run(run())


def test_intercept_edits_are_encoded_for_the_endpoint() -> None:
    """Text typed into the Intercept editor must go out as the charset the
    request declares, not as UTF-8."""
    from mitmproxy.test import tflow, tutils

    from app.addons.intercept import apply_edits, paused_payload

    flow = tflow.tflow(
        req=tutils.treq(
            content="원본".encode("euc-kr"),
            headers=(
                (b"content-type", b"text/plain; charset=euc-kr"),
                (b"content-length", b"6"),
            ),
        )
    )
    # Shown as text, read with the declared charset.
    payload = paused_payload(flow, "request")
    assert payload["request_body"] == "원본"
    assert payload["request_charset"] == "euc_kr"

    apply_edits(flow, "request", {"request_body": "수정한글자"})
    assert flow.request.raw_content == "수정한글자".encode("euc-kr")
    assert flow.request.headers["content-length"] == str(
        len("수정한글자".encode("euc-kr"))
    )
