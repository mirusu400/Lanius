"""Private CA trust must fix issuer errors without disabling TLS checks."""

from __future__ import annotations

import asyncio
import ssl
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import certifi
import httpx
import pytest
from OpenSSL import crypto
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi.testclient import TestClient

from app.api.server import create_app
from app import tls_trust
from app.tls_trust import (
    TRUSTED_CA_SETTING,
    linux_ca_bundle,
    linux_ca_dir,
    parse_ca_bundle,
    upstream_ca_file,
    windows_root_pem,
)
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
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(
                issuer[1].public_key() if issuer else key.public_key()
            ), critical=False)
            .sign(issuer[1] if issuer else key, hashes.SHA256()))
    return cert, key


def pem(cert) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def test_bundle_extends_public_roots_and_uses_a_new_path_when_replaced(tmp_path):
    first = pem(certificate()[0])
    with (
        mock.patch("app.tls_trust.windows_root_pem", return_value=b""),
        mock.patch("app.tls_trust.linux_ca_bundle", return_value=b""),
        mock.patch("app.tls_trust.linux_ca_dir", return_value=None),
    ):
        normalized, certs = parse_ca_bundle(first + first, check_dates=True)
        assert normalized == first
        assert len(certs) == 1 and certs[0]["valid"]
        path = upstream_ca_file(tmp_path, first)
        assert Path(path).read_bytes().startswith(Path(certifi.where()).read_bytes())
        assert Path(path).read_text().endswith(first)
        assert upstream_ca_file(tmp_path, pem(certificate()[0])) != path
        assert upstream_ca_file(tmp_path, "") is None


def test_windows_tls_roots_honor_server_auth_and_disallowed_store(tmp_path):
    trusted = certificate()[0]
    blocked = certificate()[0]
    wrong_purpose = certificate()[0]

    def encoded(cert):
        return cert.public_bytes(serialization.Encoding.DER)

    stores = {
        "ROOT": [
            (encoded(trusted), "x509_asn", True),
            (encoded(trusted), "x509_asn", True),
            (
                encoded(blocked), "x509_asn",
                {ExtendedKeyUsageOID.SERVER_AUTH.dotted_string},
            ),
            (
                encoded(wrong_purpose), "x509_asn",
                {ExtendedKeyUsageOID.CLIENT_AUTH.dotted_string},
            ),
        ],
        "Disallowed": [(encoded(blocked), "x509_asn", True)],
    }
    # Replacing sys.platform would mutate the process-wide sys module and make
    # unrelated POSIX socket code take Windows-only branches.
    with mock.patch(
        "app.tls_trust.sys", SimpleNamespace(platform="win32")
    ), mock.patch(
        "app.tls_trust.ssl.enum_certificates",
        create=True,
        side_effect=lambda store: stores[store],
    ):
        tls_trust._cached_windows_root_pem.cache_clear()
        try:
            roots = windows_root_pem()
            path = upstream_ca_file(tmp_path, "")
        finally:
            tls_trust._cached_windows_root_pem.cache_clear()

    assert roots.count(b"-----BEGIN CERTIFICATE-----") == 1
    assert trusted.public_bytes(serialization.Encoding.PEM) in roots
    assert blocked.public_bytes(serialization.Encoding.PEM) not in roots
    assert wrong_purpose.public_bytes(serialization.Encoding.PEM) not in roots
    assert path is not None
    bundle = Path(path).read_bytes()
    assert bundle.startswith(Path(certifi.where()).read_bytes())
    assert bundle.endswith(roots)


def test_linux_tls_roots_use_openssl_bundle_and_hashed_directory(tmp_path):
    system_pem = pem(certificate()[0]).encode("ascii")
    ca_file = tmp_path / "system-ca.pem"
    ca_file.write_bytes(system_pem)
    ca_path = tmp_path / "system-ca-directory"
    ca_path.mkdir()

    defaults = SimpleNamespace(cafile=str(ca_file), capath=str(ca_path))
    with (
        mock.patch("app.tls_trust.sys", SimpleNamespace(platform="linux")),
        mock.patch(
            "app.tls_trust.ssl.get_default_verify_paths", return_value=defaults
        ),
    ):
        tls_trust._cached_linux_ca_paths.cache_clear()
        try:
            roots = linux_ca_bundle()
            root_dir = linux_ca_dir()
            path = upstream_ca_file(tmp_path, "")
        finally:
            tls_trust._cached_linux_ca_paths.cache_clear()

    assert roots == system_pem
    assert root_dir == str(ca_path.resolve())
    assert path is not None
    bundle = Path(path).read_bytes()
    assert bundle.startswith(Path(certifi.where()).read_bytes())
    assert bundle.endswith(system_pem)


@pytest.mark.parametrize("bad", [
    pytest.param("bad PEM", id="invalid-pem"),
    pytest.param("-----BEGIN PRIVATE KEY-----\nsecret", id="private-key"),
    # pytest exports the full test ID in PYTEST_CURRENT_TEST. Windows limits
    # each environment variable to 32767 characters, so keep the ID short.
    pytest.param("x" * (128 * 1024 + 1), id="oversized"),
])
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
        system_trust = (
            "macos" if sys.platform == "darwin"
            else "windows" if sys.platform == "win32"
            else "linux" if sys.platform.startswith("linux")
            else "certifi"
        )
        assert client.get("/api/tls/trust").json() == {
            "certificates": [], "system_trust": system_trust,
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
        master = client.app.state.engine.master
        assert master.options.ssl_verify_upstream_trusted_ca == upstream_ca_file(
            eng.settings.data_dir, ""
        )
        assert master.options.ssl_verify_upstream_trusted_confdir == linux_ca_dir()
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
        assert eng.master.options.ssl_verify_upstream_trusted_ca == upstream_ca_file(
            eng.settings.data_dir, ""
        )
        assert eng.master.options.ssl_verify_upstream_trusted_confdir == linux_ca_dir()
    finally:
        await eng.stop()
        eng.store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "trust_source", ["native", "certifi", "windows-store", "linux-store"]
)
async def test_https_accepts_only_trusted_ca_and_correct_hostname(
    tmp_path, trust_source, monkeypatch
):
    ca = certificate()
    if trust_source == "certifi":
        monkeypatch.setattr("app.tls_trust.windows_root_pem", lambda: b"")
        monkeypatch.setattr("app.tls_trust.linux_ca_bundle", lambda: b"")
        monkeypatch.setattr("app.tls_trust.linux_ca_dir", lambda: None)
        monkeypatch.setattr("app.proxy.linux_ca_dir", lambda: None)
    elif trust_source == "windows-store":
        monkeypatch.setattr(
            "app.tls_trust.windows_root_pem",
            lambda: ca[0].public_bytes(serialization.Encoding.PEM),
        )
        monkeypatch.setattr("app.tls_trust.linux_ca_bundle", lambda: b"")
        monkeypatch.setattr("app.tls_trust.linux_ca_dir", lambda: None)
        monkeypatch.setattr("app.proxy.linux_ca_dir", lambda: None)
    elif trust_source == "linux-store":
        monkeypatch.setattr("app.tls_trust.windows_root_pem", lambda: b"")
        monkeypatch.setattr("app.tls_trust.linux_ca_bundle", lambda: b"")
        ca_dir = tmp_path / "system-ca-directory"
        ca_dir.mkdir()
        subject_hash = crypto.X509.from_cryptography(ca[0]).subject_name_hash()
        (ca_dir / f"{subject_hash:08x}.0").write_text(pem(ca[0]))
        monkeypatch.setattr("app.tls_trust.linux_ca_dir", lambda: str(ca_dir))
        monkeypatch.setattr("app.proxy.linux_ca_dir", lambda: str(ca_dir))
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
        if trust_source in {"windows-store", "linux-store"}:
            if trust_source == "linux-store":
                assert (
                    eng.master.options.ssl_verify_upstream_trusted_confdir
                    == str(ca_dir)
                )
            assert (await get()).status_code == 200
            assert (await get("127.0.0.1")).status_code == 502
            return
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
