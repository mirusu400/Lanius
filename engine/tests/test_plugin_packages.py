"""Manifest package installation, trust, and UI asset tests."""

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

from app.addons.plugins import PluginManager
from app.api.server import create_app
from app.config import Settings
from app.plugin_packages import PluginPackageError, PluginPackageManager


BACKEND = b"""
def activate(context):
    context.actions.register('hello', 'Hello', lambda payload: {'hello': payload.get('name')})
"""
INDEX = b'<!doctype html><html><body><script src="app.js"></script></body></html>'
SCRIPT = b"document.body.dataset.ready = 'yes';"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def manifest_for(
    files: dict[str, bytes], *, signature: dict[str, str] | None = None
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "schema": 1,
        "id": "acme.demo",
        "name": "Demo package",
        "version": "1.2.3",
        "description": "A packaged plugin",
        "author": {"name": "Acme"},
        "compatibility": {"lanius": ">=0.1,<1", "sdk": ">=1,<2"},
        "backend": {"runtime": "trusted", "entrypoint": "backend/__init__.py"},
        "ui": {
            "views": [
                {"id": "main", "title": "Demo", "entrypoint": "ui/index.html"}
            ]
        },
        "permissions": ["actions.invoke", "settings.read"],
        "integrity": {
            "files": {
                name: hashlib.sha256(content).hexdigest()
                for name, content in files.items()
            }
        },
    }
    if signature is not None:
        manifest["signature"] = signature
    return manifest


def archive_bytes(
    *,
    private_key: Ed25519PrivateKey | None = None,
    key_id: str = "test-key",
    files: dict[str, bytes] | None = None,
) -> bytes:
    package_files = files or {
        "backend/__init__.py": BACKEND,
        "ui/index.html": INDEX,
        "ui/app.js": SCRIPT,
    }
    manifest = manifest_for(package_files)
    if private_key is not None:
        payload = json.dumps(
            manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode()
        manifest["signature"] = {
            "algorithm": "ed25519",
            "key_id": key_id,
            "value": base64.b64encode(private_key.sign(payload)).decode(),
        }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("plugin.json", json.dumps(manifest))
        for name, content in package_files.items():
            package.writestr(name, content)
    return output.getvalue()


def write_source_package(path: Path) -> None:
    files = {
        "backend/__init__.py": BACKEND,
        "ui/index.html": INDEX,
        "ui/app.js": SCRIPT,
    }
    for name, content in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (path / "plugin.json").write_text(json.dumps(manifest_for(files)))


def test_installs_discovers_and_loads_unsigned_package(tmp_path) -> None:
    plugin_dir = tmp_path / "plugins"
    packages = PluginPackageManager(plugin_dir)
    installed = packages.install(archive_bytes())

    assert installed == {
        "id": "acme.demo",
        "name": "Demo package",
        "version": "1.2.3",
        "trust": "unsigned",
        "development": False,
    }
    manager = PluginManager(plugin_dir, packages=packages)
    manager.discover()
    plugin = manager.enable("acme.demo")
    assert plugin.meta["package"]["trust"] == "unsigned"
    assert plugin.meta["ui"]["views"][0]["entrypoint"] == "ui/index.html"
    assert manager.registry.list()["actions"][0]["id"] == "acme.demo.hello"


def test_rejects_integrity_mismatch_and_path_traversal(tmp_path) -> None:
    bad_files = {
        "backend/__init__.py": BACKEND,
        "ui/index.html": INDEX,
        "ui/app.js": SCRIPT,
    }
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("plugin.json", json.dumps(manifest_for(bad_files)))
        package.writestr("backend/__init__.py", b"changed")
        package.writestr("ui/index.html", INDEX)
        package.writestr("ui/app.js", SCRIPT)
    with pytest.raises(PluginPackageError, match="SHA-256 mismatch"):
        PluginPackageManager(tmp_path / "plugins").install(archive.getvalue())

    traversal = io.BytesIO()
    with zipfile.ZipFile(traversal, "w") as package:
        package.writestr("../escape", b"bad")
    with pytest.raises(PluginPackageError, match="inside the package"):
        PluginPackageManager(tmp_path / "plugins").install(traversal.getvalue())
    assert not (tmp_path / "escape").exists()


def test_verifies_ed25519_signature_with_trusted_key(tmp_path) -> None:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    trusted = tmp_path / "trusted.json"
    trusted.write_text(json.dumps({"release": base64.b64encode(public_key).decode()}))
    manager = PluginPackageManager(tmp_path / "plugins", trusted_keys_path=trusted)

    result = manager.install(
        archive_bytes(private_key=private_key, key_id="release"),
        allow_unsigned=False,
    )

    assert result["trust"] == "trusted"


def test_rejects_unsigned_when_signature_is_required(tmp_path) -> None:
    manager = PluginPackageManager(tmp_path / "plugins")
    with pytest.raises(PluginPackageError, match="unsigned"):
        manager.install(archive_bytes(), allow_unsigned=False)


def test_development_install_is_explicit_and_uninstall_only_removes_link(tmp_path) -> None:
    source = tmp_path / "source"
    write_source_package(source)
    disabled = PluginPackageManager(tmp_path / "plugins")
    with pytest.raises(PluginPackageError, match="disabled"):
        disabled.install_development(source)

    manager = PluginPackageManager(tmp_path / "plugins", development_mode=True)
    result = manager.install_development(source)
    link = tmp_path / "plugins" / "acme.demo"
    assert result["development"] is True
    assert link.is_symlink()

    manager.uninstall("acme.demo")
    assert not link.exists()
    assert (source / "plugin.json").exists()


def test_package_api_serves_sandboxed_ui_and_uninstalls(tmp_path) -> None:
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=tmp_path / "plugins",
    )
    with TestClient(create_app(settings)) as client:
        installed = client.post(
            "/api/plugins/install?enable=true",
            content=archive_bytes(),
            headers={"Content-Type": "application/octet-stream"},
        )
        assert installed.status_code == 200, installed.text
        assert installed.json()["plugin"]["loaded"] is True

        page = client.get("/api/plugin-ui/acme.demo/index.html")
        assert page.status_code == 200
        assert "sandbox allow-scripts" in page.headers["content-security-policy"]
        assert page.headers["x-content-type-options"] == "nosniff"
        assert client.get("/api/plugin-ui/acme.demo/../plugin.json").status_code == 404

        removed = client.delete("/api/plugins/acme.demo/package")
        assert removed.json() == {"id": "acme.demo", "uninstalled": True}
        assert all(
            plugin["name"] != "acme.demo"
            for plugin in client.get("/api/plugins").json()["items"]
        )


def test_bytecode_written_after_import_does_not_break_integrity(tmp_path) -> None:
    packages = PluginPackageManager(tmp_path / "plugins")
    packages.install(archive_bytes())
    cache = tmp_path / "plugins" / "acme.demo" / "backend" / "__pycache__"
    cache.mkdir()
    (cache / "__init__.cpython-313.pyc").write_bytes(b"compiled")

    manifest, trust = packages.inspect(tmp_path / "plugins" / "acme.demo")
    assert (manifest.id, trust) == ("acme.demo", "unsigned")


def test_packages_cannot_ship_bytecode(tmp_path) -> None:
    files = {
        "backend/__init__.py": BACKEND,
        "backend/__pycache__/__init__.cpython-313.pyc": b"compiled",
        "ui/index.html": INDEX,
        "ui/app.js": SCRIPT,
    }
    with pytest.raises(PluginPackageError, match="compiled bytecode"):
        PluginPackageManager(tmp_path / "plugins").install(archive_bytes(files=files))


def test_install_refuses_cross_site_requests(tmp_path) -> None:
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=tmp_path / "plugins",
    )
    with TestClient(create_app(settings)) as client:
        refused = client.post(
            "/api/plugins/install?enable=true",
            content=archive_bytes(),
            headers={"Origin": "https://attacker.test", "Content-Type": "text/plain"},
        )
        assert refused.status_code == 403
        assert not (tmp_path / "plugins" / "acme.demo").exists()

        allowed = client.post(
            "/api/plugins/install",
            content=archive_bytes(),
            headers={
                "Origin": "http://localhost:5173",
                "Content-Type": "application/octet-stream",
            },
        )
        assert allowed.status_code == 200, allowed.text


def test_replacing_a_loaded_package_reloads_it(tmp_path) -> None:
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=tmp_path / "plugins",
    )
    updated = BACKEND.replace(b"'hello': payload", b"'updated': payload")
    with TestClient(create_app(settings)) as client:
        headers = {"Content-Type": "application/octet-stream"}
        first = client.post(
            "/api/plugins/install?enable=true", content=archive_bytes(), headers=headers
        )
        assert first.status_code == 200, first.text
        replaced = client.post(
            "/api/plugins/install?replace=true",
            content=archive_bytes(
                files={
                    "backend/__init__.py": updated,
                    "ui/index.html": INDEX,
                    "ui/app.js": SCRIPT,
                }
            ),
            headers=headers,
        )
        assert replaced.status_code == 200, replaced.text
        assert replaced.json()["plugin"]["loaded"] is True
        result = client.post(
            "/api/plugin-actions/acme.demo.hello/invoke",
            json={"context": {"name": "x"}},
        )
        assert result.status_code == 200, result.text
        assert result.json()["result"] == {"updated": "x"}
