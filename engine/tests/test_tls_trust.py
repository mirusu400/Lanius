"""Private CA trust must fix issuer errors without disabling TLS checks."""

from __future__ import annotations

import asyncio
import ssl
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import certifi
import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.tls_trust import TRUSTED_CA_SETTING, parse_ca_bundle, upstream_ca_file
from .test_proxy import engine, free_port


def certificate(*, ca: bool = True, expired: bool = False, issuer=None):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Private test CA" if ca else "localhost")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name)
            .issuer_name(issuer[0].subject if issuer else name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=2))
            .not_valid_after(now + timedelta(days=-1 if expired else 30))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=not ca,
                data_encipherment=False, key_agreement=False, key_cert_sign=ca,
                crl_sign=ca, encipher_only=None, decipher_only=None,
            ), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
            .sign(issuer[1] if issuer else key, hashes.SHA256()))
    return cert, key


def pem(cert) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def test_bundle_extends_public_roots_and_uses_a_new_path_when_replaced(tmp_path):
    first = pem(certificate()[0])
    normalized, certs = parse_ca_bundle(first + first, check_dates=True)
    assert normalized == first
    assert len(certs) == 1 and certs[0]["valid"]
    path = upstream_ca_file(tmp_path, first)
    assert Path(path).read_bytes().startswith(Path(certifi.where()).read_bytes())
    assert Path(path).read_text().endswith(first)
    assert upstream_ca_file(tmp_path, pem(certificate()[0])) != path
    assert upstream_ca_file(tmp_path, "") is None


@pytest.mark.parametrize("bad", ["bad PEM", "-----BEGIN PRIVATE KEY-----\nsecret", "x" * (128 * 1024 + 1)])
def test_rejects_invalid_or_private_data(bad):
    with pytest.raises(ValueError):
        parse_ca_bundle(bad, check_dates=True)


def test_rejects_leaf_and_expired_ca():
    for value in (pem(certificate(ca=False)[0]), pem(certificate(expired=True)[0])):
        with pytest.raises(ValueError):
            parse_ca_bundle(value, check_dates=True)


def test_api_persists_and_applies_trust_and_rejects_bad_updates(tmp_path):
    eng = engine(tmp_path, free_port())
    eng.store.close()
    app = create_app(eng.settings)
    ca = pem(certificate()[0])
    with TestClient(app) as client:
        assert client.get("/api/tls/trust").json() == {
            "certificates": [], "system_trust": "macos" if sys.platform == "darwin" else "certifi",
        }
        before = app.state.engine.master
        response = client.put("/api/tls/trust", json={"ca_pem": ca})
        assert response.status_code == 200
        assert len(response.json()["certificates"]) == 1
        master = app.state.engine.master
        assert master is not before
        assert master.options.ssl_insecure is False
        assert master.options.ssl_verify_upstream_trusted_ca
        for bad in (None, 123, "not a certificate", ca + "-----BEGIN PRIVATE KEY-----"):
            assert client.put("/api/tls/trust", json={"ca_pem": bad}).status_code == 422
            assert app.state.engine.master is master
            assert app.state.store.get_setting(TRUSTED_CA_SETTING) == ca
        # A project import cannot silently add or replace a trust anchor.
        payload = client.get("/api/project/export?include_flows=false").json()
        payload["settings"][TRUSTED_CA_SETTING] = pem(certificate()[0])
        assert client.post("/api/project/import", json=payload).status_code == 200
        assert app.state.store.get_setting(TRUSTED_CA_SETTING) == ca
    with TestClient(create_app(eng.settings)) as client:
        assert len(client.get("/api/tls/trust").json()["certificates"]) == 1
        assert client.app.state.engine.master.options.ssl_verify_upstream_trusted_ca
        assert client.put("/api/tls/trust", json={"ca_pem": ""}).status_code == 200
        assert client.app.state.engine.master.options.ssl_verify_upstream_trusted_ca is None
        assert client.app.state.store.get_setting(TRUSTED_CA_SETTING) is None
        assert client.post("/api/project/import", json=payload).status_code == 200
        assert client.get("/api/tls/trust").json()["certificates"] == []


@pytest.mark.asyncio
async def test_restart_failure_restores_previous_trust(tmp_path):
    eng = engine(tmp_path, free_port())
    await eng.start()
    original_start = eng.start
    async def start_once_failed():
        if calls.pop(0):
            raise OSError("startup failed")
        await original_start()
    calls = [True, False]
    try:
        with mock.patch.object(eng, "start", side_effect=start_once_failed):
            with pytest.raises(OSError):
                await eng.set_tls_trust(pem(certificate()[0]))
        assert eng.running
        assert eng.store.get_setting(TRUSTED_CA_SETTING) is None
        assert eng.master.options.ssl_verify_upstream_trusted_ca is None
    finally:
        await eng.stop()
        eng.store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("platform", ["native", "certifi"])
async def test_https_accepts_only_trusted_ca_and_correct_hostname(tmp_path, platform, monkeypatch):
    if platform == "certifi":
        monkeypatch.setattr("app.proxy.sys.platform", "linux")
    ca = certificate()
    leaf, key = certificate(ca=False, issuer=ca)
    cert_path, key_path = tmp_path / "server.pem", tmp_path / "key.pem"
    cert_path.write_text(pem(leaf))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
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
    browser_trust = ssl.create_default_context(cafile=str(tmp_path / "mitm/mitmproxy-ca-cert.pem"))
    async def get(host="localhost"):
        async with httpx.AsyncClient(proxy=f"http://127.0.0.1:{eng.settings.proxy_port}", verify=browser_trust, timeout=5) as client:
            return await client.get(f"https://{host}:{port}/")
    try:
        assert (await get()).status_code == 502
        await eng.set_tls_trust(pem(ca[0]))
        assert (await get()).status_code == 200
        assert (await get("127.0.0.1")).status_code == 502
        await eng.set_tls_trust(pem(certificate()[0]))
        assert (await get()).status_code == 502
        await eng.set_tls_trust("")
        assert (await get()).status_code == 502
    finally:
        await eng.stop()
        eng.store.close()
        server.close()
        await server.wait_closed()
