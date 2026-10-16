"""Per-host exceptions to upstream certificate verification (issue #25)."""

from __future__ import annotations

import asyncio
import ssl

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from app import error_page
from app.api.server import create_app
from app.tls_exceptions import (
    TLS_EXCEPTIONS_SETTING,
    normalize_host,
    normalize_hosts,
    parse_setting,
)
from .test_proxy import engine, free_port
from .test_tls_trust import certificate, pem


@pytest.mark.parametrize(
    ("raw", "host"),
    [
        ("App.Example.TEST.", "app.example.test"),
        (" 10.0.0.1 ", "10.0.0.1"),
        ("[::1]", "::1"),
        ("bücher.example", "xn--bcher-kva.example"),
    ],
)
def test_hosts_are_normalized(raw, host) -> None:
    assert normalize_host(raw) == host


@pytest.mark.parametrize("bad", ["", "*.example.test", "exa mple.test", "-bad.test", "a" * 64 + ".test", 5])
def test_wildcards_and_invalid_hosts_are_refused(bad) -> None:
    with pytest.raises(ValueError):
        normalize_host(bad)


def test_duplicates_collapse_and_damaged_settings_mean_no_exceptions() -> None:
    assert normalize_hosts(["b.test", "B.test", "a.test"]) == ["a.test", "b.test"]
    assert parse_setting('["x.test"]') == ["x.test"]
    for damaged in ("{", '{"hosts": 1}', '["*.test"]', "[1]"):
        assert parse_setting(damaged) == []


def test_tls_failures_get_a_page_that_names_lanius() -> None:
    fallback = lambda status, message: b"generic"  # noqa: E731
    page = error_page.format_error(502, "Certificate verify failed: hostname mismatch", fallback).decode()
    assert "Lanius rejected the server certificate" in page
    assert "Certificate verify failed: hostname mismatch" in page
    assert "Upstream certificate exceptions" in page
    assert error_page.format_error(502, "Connection refused", fallback) == b"generic"
    escaped = error_page.format_error(502, "Certificate verify failed: <x>", fallback).decode()
    assert "<x>" not in escaped and "&lt;x&gt;" in escaped


def test_api_validates_persists_and_never_imports_exceptions(tmp_path) -> None:
    eng = engine(tmp_path, free_port())
    eng.store.close()
    with TestClient(create_app(eng.settings)) as client:
        assert client.get("/api/tls/exceptions").json() == {"hosts": []}
        for bad in ({"hosts": "x.test"}, {"hosts": ["*.x.test"]}, {}):
            assert client.put("/api/tls/exceptions", json=bad).status_code == 422
        response = client.put("/api/tls/exceptions", json={"hosts": ["Bad-Cert.Example.test"]})
        assert response.json() == {"hosts": ["bad-cert.example.test"]}

        exported = client.get("/api/project/export?include_flows=false").json()
        exported["settings"][TLS_EXCEPTIONS_SETTING] = '["evil.test"]'
        assert client.post("/api/project/import", json=exported).status_code == 200
        assert client.get("/api/tls/exceptions").json() == {"hosts": ["bad-cert.example.test"]}

        assert client.put("/api/tls/exceptions", json={"hosts": []}).json() == {"hosts": []}
        exported["settings"][TLS_EXCEPTIONS_SETTING] = '["evil.test"]'
        assert client.post("/api/project/import", json=exported).status_code == 200
        assert client.get("/api/tls/exceptions").json() == {"hosts": []}


@pytest.mark.asyncio
async def test_only_the_excepted_host_skips_verification(tmp_path) -> None:
    ca = certificate()
    leaf, key = certificate(ca=False, issuer=ca)  # valid for "localhost" only
    cert_path, key_path = tmp_path / "server.pem", tmp_path / "key.pem"
    cert_path.write_text(pem(leaf))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)

    async def respond(reader, writer):
        try:
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            await writer.drain()
        finally:
            writer.close()

    server = await asyncio.start_server(respond, "127.0.0.1", 0, ssl=context)
    port = server.sockets[0].getsockname()[1]
    eng = engine(tmp_path, free_port())
    await eng.start()
    await eng.set_tls_trust(pem(ca[0]))
    browser = ssl.create_default_context(cafile=str(tmp_path / "mitm/mitmproxy-ca-cert.pem"))

    async def get(host: str) -> httpx.Response:
        async with httpx.AsyncClient(
            proxy=f"http://127.0.0.1:{eng.settings.proxy_port}", verify=browser, timeout=5
        ) as client:
            return await client.get(f"https://{host}:{port}/")

    try:
        # 127.0.0.1 is not in the certificate: a hostname (IP) mismatch.
        refused = await get("127.0.0.1")
        assert refused.status_code == 502
        assert "Lanius rejected the server certificate" in refused.text
        assert "IP address mismatch" in refused.text

        await eng.set_tls_exceptions(["127.0.0.1"])
        accepted = await get("127.0.0.1")
        assert (accepted.status_code, accepted.text) == (200, "ok")

        # The exception covers that host only; untrusted chains elsewhere still fail.
        await eng.set_tls_trust("")
        assert (await get("localhost")).status_code == 502

        await eng.set_tls_exceptions([])
        assert (await get("127.0.0.1")).status_code == 502
    finally:
        await eng.stop()
        eng.store.close()
        server.close()
        await server.wait_closed()
