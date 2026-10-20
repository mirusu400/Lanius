"""Per-host exceptions to upstream certificate verification (issue #25)."""

from __future__ import annotations

import asyncio
import ssl
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from app import error_page
from app.api.server import create_app
from app.tls_exceptions import (
    TLS_EXCEPTIONS_SETTING,
    TLS_INSECURE_SETTING,
    _server_hosts,
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


def test_connection_matches_both_connect_address_and_sni() -> None:
    server = SimpleNamespace(sni="device.internal", address=("10.0.0.8", 443))
    assert _server_hosts(server) == {"device.internal", "10.0.0.8"}


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
        assert client.get("/api/tls/insecure").json() == {"enabled": False}
        for bad in ({}, {"enabled": 1}, {"enabled": "true"}):
            assert client.put("/api/tls/insecure", json=bad).status_code == 422
        for bad in ({"hosts": "x.test"}, {"hosts": ["*.x.test"]}, {}):
            assert client.put("/api/tls/exceptions", json=bad).status_code == 422
        response = client.put("/api/tls/exceptions", json={"hosts": ["Bad-Cert.Example.test"]})
        assert response.json() == {"hosts": ["bad-cert.example.test"]}
        assert client.put("/api/tls/insecure", json={"enabled": True}).json() == {"enabled": True}

        exported = client.get("/api/project/export?include_flows=false").json()
        exported["settings"][TLS_EXCEPTIONS_SETTING] = '["evil.test"]'
        exported["settings"][TLS_INSECURE_SETTING] = ""
        assert client.post("/api/project/import", json=exported).status_code == 200
        assert client.get("/api/tls/exceptions").json() == {"hosts": ["bad-cert.example.test"]}
        assert client.get("/api/tls/insecure").json() == {"enabled": True}

        assert client.put("/api/tls/exceptions", json={"hosts": []}).json() == {"hosts": []}
        assert client.put("/api/tls/insecure", json={"enabled": False}).json() == {"enabled": False}
        exported["settings"][TLS_EXCEPTIONS_SETTING] = '["evil.test"]'
        exported["settings"][TLS_INSECURE_SETTING] = "1"
        assert client.post("/api/project/import", json=exported).status_code == 200
        assert client.get("/api/tls/exceptions").json() == {"hosts": []}
        assert client.get("/api/tls/insecure").json() == {"enabled": False}


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

        # The project-wide escape hatch accepts every invalid upstream, not
        # just one issuer error or hostname mismatch.
        await eng.set_tls_insecure(True)
        assert eng.master.options.ssl_insecure is True
        assert (await get("localhost")).status_code == 200
        assert (await get("127.0.0.1")).status_code == 200

        await eng.set_tls_insecure(False)
        assert eng.master.options.ssl_insecure is False
        assert (await get("localhost")).status_code == 502
    finally:
        await eng.stop()
        eng.store.close()
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_insecure_mode_accepts_self_signed_https_through_upstream_proxy(tmp_path) -> None:
    """Reproduce a proxy-only internal HTTPS service on logical port 443."""
    leaf, key = certificate(ca=False, hostname="inside.invalid")
    cert_path, key_path = tmp_path / "internal.pem", tmp_path / "internal-key.pem"
    cert_path.write_text(pem(leaf))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    backend_hits = 0

    async def internal_https(reader, writer):
        nonlocal backend_hits
        try:
            await reader.readuntil(b"\r\n\r\n")
            backend_hits += 1
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n"
                b"Connection: close\r\n\r\ninternal-ok"
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            # Verification fails after the TLS handshake, before HTTP arrives.
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    internal = await asyncio.start_server(
        internal_https, "127.0.0.1", 0, ssl=context
    )
    internal_port = internal.sockets[0].getsockname()[1]
    connects: list[bytes] = []

    async def copy_stream(reader, writer):
        try:
            while data := await reader.read(64 * 1024):
                writer.write(data)
                await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass

    async def upstream_proxy(reader, writer):
        target_writer = None
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            connects.append(request)
            if not request.startswith(b"CONNECT inside.invalid:443 HTTP/"):
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                return
            target_reader, target_writer = await asyncio.open_connection(
                "127.0.0.1", internal_port
            )
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            tasks = {
                asyncio.create_task(copy_stream(reader, target_writer)),
                asyncio.create_task(copy_stream(target_reader, writer)),
            }
            _done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            if target_writer is not None:
                target_writer.close()
                await target_writer.wait_closed()
            writer.close()
            await writer.wait_closed()

    upstream = await asyncio.start_server(upstream_proxy, "127.0.0.1", 0)
    upstream_port = upstream.sockets[0].getsockname()[1]
    eng = engine(tmp_path, free_port())
    await eng.start()
    await eng.set_upstream(f"http://127.0.0.1:{upstream_port}")
    browser = ssl.create_default_context(cafile=str(tmp_path / "mitm/mitmproxy-ca-cert.pem"))

    async def get() -> httpx.Response:
        async with httpx.AsyncClient(
            proxy=f"http://127.0.0.1:{eng.settings.proxy_port}",
            verify=browser,
            timeout=5,
        ) as client:
            return await client.get("https://inside.invalid/")

    try:
        refused = await get()
        assert refused.status_code == 502
        assert "self-signed certificate" in refused.text
        assert connects and connects[-1].startswith(
            b"CONNECT inside.invalid:443 HTTP/"
        )

        before = len(connects)
        await eng.set_tls_insecure(True)
        accepted = await get()
        assert (accepted.status_code, accepted.text) == (200, "internal-ok")
        assert len(connects) > before
        assert backend_hits == 1
    finally:
        await eng.stop()
        eng.store.close()
        upstream.close()
        internal.close()
        await upstream.wait_closed()
        await internal.wait_closed()
