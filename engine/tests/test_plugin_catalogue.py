"""Signed catalogue, immutable release, update, rollback, and revoke tests."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import socket
import zipfile
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
    ensure_immutable,
)
from app.plugin_packages import PluginPackageError, PluginPackageManager, load_manifest


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
