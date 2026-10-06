"""Signed catalogue, immutable release, update, rollback, and revoke tests."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import socket
import ssl
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.config import Settings
from app.plugin_catalogue import (
    PluginCatalogueError,
    PluginCatalogueManager,
    _default_fetch,
    ensure_immutable,
)
from app.plugin_packages import PluginPackageError, PluginPackageManager, load_manifest
from app.plugin_trust import OFFICIAL_CATALOGUE_SOURCE
from .test_tls_trust import certificate, pem


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def public_key(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode()


def test_official_source_is_default_until_sources_are_saved(tmp_path) -> None:
    packages = PluginPackageManager(tmp_path / "plugins")
    catalogue = PluginCatalogueManager(
        tmp_path / "catalogues.json",
        tmp_path / "cache",
        tmp_path / "revocations.json",
        packages,
    )

    assert [source.as_dict() for source in catalogue.sources()] == [
        OFFICIAL_CATALOGUE_SOURCE
    ]
    assert catalogue.save_sources([]) == []
    assert catalogue.sources() == []


def test_download_uses_bundled_ca_and_still_checks_hostnames(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    monkeypatch.setenv("no_proxy", "localhost,127.0.0.1")
    ca = certificate()
    leaf, key = certificate(ca=False, issuer=ca)
    ca_path = tmp_path / "ca.pem"
    cert_path = tmp_path / "server.pem"
    key_path = tmp_path / "server-key.pem"
    ca_path.write_text(pem(ca[0]))
    cert_path.write_text(pem(leaf))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args) -> None:
            pass

    server = HTTPServer(("localhost", 0), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert_path, key_path)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        url = f"https://localhost:{server.server_port}/index.json"
        with pytest.raises(PluginCatalogueError, match="certificate verify failed"):
            _default_fetch(url, 10)
        monkeypatch.setattr("app.plugin_catalogue.certifi.where", lambda: str(ca_path))
        assert _default_fetch(url, 10) == b"ok"
        with pytest.raises(PluginCatalogueError, match="certificate verify failed"):
            _default_fetch(f"https://127.0.0.1:{server.server_port}/index.json", 10)
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()


def signed_package(version: str, private_key: Ed25519PrivateKey) -> bytes:
    backend = f"VERSION = {version!r}\ndef activate(context):\n    pass\n".encode()
    manifest: dict[str, Any] = {
        "schema": 1,
        "id": "acme.catalogue-demo",
        "name": "Catalogue demo",
        "version": version,
        "compatibility": {"lanius": ">=0.1,<1", "sdk": ">=1,<2"},
        "backend": {"runtime": "trusted", "entrypoint": "backend/__init__.py"},
        "permissions": [],
        "integrity": {
            "files": {"backend/__init__.py": hashlib.sha256(backend).hexdigest()}
        },
    }
    payload = json.dumps(
        manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    manifest["signature"] = {
        "algorithm": "ed25519",
        "key_id": "package-key",
        "value": base64.b64encode(private_key.sign(payload)).decode(),
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("plugin.json", json.dumps(manifest))
        archive.writestr("backend/__init__.py", backend)
    return output.getvalue()


def signed_catalogue(
    private_key: Ed25519PrivateKey,
    packages: dict[str, bytes],
    *,
    revoked: list[dict[str, str]] | None = None,
    v1_url: str = "https://catalogue.test/demo-1.0.0.lanius-plugin",
    plugin_metadata: dict[str, Any] | None = None,
) -> bytes:
    value: dict[str, Any] = {
        "schema": 1,
        "generated_at": "2026-09-29T00:00:00Z",
        "plugins": [
            {
                "id": "acme.catalogue-demo",
                "name": "Catalogue demo",
                "description": "Installed from a signed catalogue.",
                "author": "Acme",
                "categories": ["scanner"],
                **(plugin_metadata or {}),
                "releases": [
                    {
                        "version": "1.0.0",
                        "url": v1_url,
                        "sha256": hashlib.sha256(packages["1.0.0"]).hexdigest(),
                        "package_key_id": "package-key",
                        "compatibility": {"lanius": ">=0.1,<1", "sdk": ">=1,<2"},
                        "published_at": "2026-09-01T00:00:00Z",
                    },
                    {
                        "version": "2.0.0",
                        "url": "https://catalogue.test/demo-2.0.0.lanius-plugin",
                        "sha256": hashlib.sha256(packages["2.0.0"]).hexdigest(),
                        "package_key_id": "package-key",
                        "compatibility": {"lanius": ">=0.1,<1", "sdk": ">=1,<2"},
                        "published_at": "2026-09-29T00:00:00Z",
                    },
                ],
            }
        ],
        "revoked": revoked or [],
    }
    payload = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    value["signature"] = {
        "algorithm": "ed25519",
        "key_id": "catalogue-key",
        "value": base64.b64encode(private_key.sign(payload)).decode(),
    }
    return json.dumps(value).encode()


def setup_manager(tmp_path: Path):
    package_key = Ed25519PrivateKey.generate()
    catalogue_key = Ed25519PrivateKey.generate()
    archives = {
        version: signed_package(version, package_key)
        for version in ("1.0.0", "2.0.0")
    }
    trusted = tmp_path / "trusted.json"
    trusted.write_text(json.dumps({"package-key": public_key(package_key)}))
    sources = tmp_path / "catalogues.json"
    sources.write_text(
        json.dumps(
            {
                "schema": 1,
                "sources": [
                    {
                        "id": "official",
                        "title": "Official",
                        "url": "https://catalogue.test/index.json",
                        "public_key": public_key(catalogue_key),
                        "key_id": "catalogue-key",
                        "enabled": True,
                    }
                ],
            }
        )
    )
    revocations = tmp_path / "revocations.json"
    packages = PluginPackageManager(
        tmp_path / "plugins",
        trusted_keys_path=trusted,
        revocations_path=revocations,
    )
    responses = {
        "https://catalogue.test/index.json": signed_catalogue(
            catalogue_key, archives
        ),
        "https://catalogue.test/demo-1.0.0.lanius-plugin": archives["1.0.0"],
        "https://catalogue.test/demo-2.0.0.lanius-plugin": archives["2.0.0"],
    }

    def fetch(url: str, limit: int) -> bytes:
        assert len(responses[url]) <= limit
        return responses[url]

    catalogue = PluginCatalogueManager(
        sources,
        tmp_path / "cache",
        revocations,
        packages,
        fetch=fetch,
    )
    return catalogue, packages, responses, archives, catalogue_key


def test_catalogue_installs_updates_and_rolls_back(tmp_path) -> None:
    catalogue, packages, _responses, _archives, _key = setup_manager(tmp_path)

    listing = catalogue.catalogue(refresh=True)
    assert listing["errors"] == {}
    assert listing["items"][0]["latest_version"] == "2.0.0"

    catalogue.install("official", "acme.catalogue-demo", "1.0.0")
    assert load_manifest(packages.directory / "acme.catalogue-demo").version == "1.0.0"
    catalogue.install("official", "acme.catalogue-demo", "2.0.0")
    assert packages.rollback_versions("acme.catalogue-demo") == ["1.0.0"]

    result = packages.rollback("acme.catalogue-demo")
    assert result["version"] == "1.0.0"
    assert result["rollback_versions"] == ["2.0.0"]


def test_catalogue_preserves_signed_card_metadata(tmp_path) -> None:
    catalogue, _packages, responses, archives, key = setup_manager(tmp_path)
    icon = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nexample").decode()
    responses["https://catalogue.test/index.json"] = signed_catalogue(
        key, archives, plugin_metadata={
            "details": "A longer explanation of the plugin.",
            "icon": icon,
            "homepage": "https://catalogue.test/demo",
        },
    )

    item = catalogue.catalogue(refresh=True)["items"][0]
    assert item["details"] == "A longer explanation of the plugin."
    assert item["icon"] == icon
    assert item["homepage"] == "https://catalogue.test/demo"


@pytest.mark.parametrize("icon", [
    "https://catalogue.test/icon.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,Zm9v",
])
def test_catalogue_rejects_unsafe_or_invalid_icons(tmp_path, icon) -> None:
    catalogue, _packages, responses, archives, key = setup_manager(tmp_path)
    responses["https://catalogue.test/index.json"] = signed_catalogue(
        key, archives, plugin_metadata={"icon": icon},
    )

    assert "icon" in catalogue.refresh()["official"]


def test_catalogue_rejects_unsafe_homepage(tmp_path) -> None:
    catalogue, _packages, responses, archives, key = setup_manager(tmp_path)
    responses["https://catalogue.test/index.json"] = signed_catalogue(
        key, archives, plugin_metadata={"homepage": "javascript:alert(1)"},
    )

    assert "homepage" in catalogue.refresh()["official"]


def test_catalogue_rejects_changed_published_release(tmp_path) -> None:
    catalogue, _packages, responses, archives, key = setup_manager(tmp_path)
    assert catalogue.refresh() == {}
    responses["https://catalogue.test/index.json"] = signed_catalogue(
        key,
        archives,
        v1_url="https://catalogue.test/changed-1.0.0.lanius-plugin",
    )

    errors = catalogue.refresh()

    assert "published release metadata changed" in errors["official"]
    assert catalogue.catalogue()["items"][0]["releases"][1]["url"].endswith(
        "demo-1.0.0.lanius-plugin"
    )


def test_catalogue_rejects_removed_published_release() -> None:
    previous = {
        "plugins": [{
            "id": "acme.demo",
            "releases": [{"version": "1.0.0", "sha256": "a"}],
        }]
    }
    current = {"plugins": [{"id": "acme.demo", "releases": []}]}

    with pytest.raises(PluginCatalogueError, match="published release was removed"):
        ensure_immutable(previous, current)


def test_revoked_catalogue_release_cannot_execute(tmp_path) -> None:
    catalogue, packages, responses, archives, key = setup_manager(tmp_path)
    catalogue.refresh()
    catalogue.install("official", "acme.catalogue-demo", "1.0.0")
    responses["https://catalogue.test/index.json"] = signed_catalogue(
        key,
        archives,
        revoked=[
            {
                "plugin": "acme.catalogue-demo",
                "version": "1.0.0",
                "reason": "security issue",
            }
        ],
    )

    assert catalogue.refresh() == {}
    with pytest.raises(PluginPackageError, match="security issue"):
        packages.inspect(packages.directory / "acme.catalogue-demo")


def test_catalogue_api_refreshes_and_installs(tmp_path) -> None:
    package_key = Ed25519PrivateKey.generate()
    catalogue_key = Ed25519PrivateKey.generate()
    archives = {
        version: signed_package(version, package_key)
        for version in ("1.0.0", "2.0.0")
    }
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=tmp_path / "plugins",
    )
    settings.plugin_trusted_keys.write_text(
        json.dumps({"package-key": public_key(package_key)})
    )
    responses = {
        "https://catalogue.test/index.json": signed_catalogue(
            catalogue_key, archives
        ),
        "https://catalogue.test/demo-2.0.0.lanius-plugin": archives["2.0.0"],
    }

    with TestClient(create_app(settings)) as client:
        client.app.state.engine.plugin_catalogue.fetch = (
            lambda url, _limit: responses[url]
        )
        sources = client.put(
            "/api/plugin-catalogue/sources",
            json={
                "sources": [
                    {
                        "id": "official",
                        "title": "Official",
                        "url": "https://catalogue.test/index.json",
                        "public_key": public_key(catalogue_key),
                        "key_id": "catalogue-key",
                        "enabled": True,
                    }
                ]
            },
        )
        assert sources.status_code == 200, sources.text
        listing = client.get("/api/plugin-catalogue?refresh=true")
        assert listing.status_code == 200, listing.text
        assert listing.json()["items"][0]["latest_version"] == "2.0.0"

        installed = client.post(
            "/api/plugin-catalogue/install",
            json={
                "source": "official",
                "plugin": "acme.catalogue-demo",
                "version": "2.0.0",
                "enable": True,
            },
        )
        assert installed.status_code == 200, installed.text
        assert installed.json()["plugin"]["loaded"] is True


def test_rollback_skips_a_backup_of_the_installed_version(tmp_path) -> None:
    catalogue, packages, _responses, _archives, _key = setup_manager(tmp_path)
    catalogue.refresh()
    catalogue.install("official", "acme.catalogue-demo", "1.0.0")
    catalogue.install("official", "acme.catalogue-demo", "2.0.0")
    packages.rollback("acme.catalogue-demo")
    catalogue.install("official", "acme.catalogue-demo", "2.0.0")

    assert packages.rollback_versions("acme.catalogue-demo") == ["1.0.0"]
    result = packages.rollback("acme.catalogue-demo")
    assert result["version"] == "1.0.0"
    assert result["rollback_versions"] == ["2.0.0"]


def test_refresh_recovers_after_the_source_key_is_rotated(tmp_path) -> None:
    catalogue, _packages, responses, archives, _key = setup_manager(tmp_path)
    assert catalogue.refresh() == {}

    rotated = Ed25519PrivateKey.generate()
    sources = json.loads(catalogue.sources_path.read_text())
    sources["sources"][0]["public_key"] = public_key(rotated)
    catalogue.sources_path.write_text(json.dumps(sources))
    responses["https://catalogue.test/index.json"] = signed_catalogue(rotated, archives)

    assert catalogue.refresh() == {}
    assert catalogue.catalogue()["errors"] == {}
