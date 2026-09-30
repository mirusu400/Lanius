"""The bundled Request Marker is installable and demonstrates the real SDK."""

from __future__ import annotations

import socket

import pytest
from fastapi.testclient import TestClient
from mitmproxy.test import tflow, tutils

from app.addons.plugins import PluginManager
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowStore
from app.plugin_packages import PluginPackageManager
from app.plugin_samples import bundled_sample_archive, bundled_samples


class FakeAddons:
    def __init__(self) -> None:
        self.items: list[object] = []

    def add(self, obj: object) -> None:
        self.items.append(obj)

    def remove(self, obj: object) -> None:
        self.items.remove(obj)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def settings_for(tmp_path) -> Settings:
    return Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=tmp_path / "plugins",
    )


@pytest.mark.asyncio
async def test_request_marker_package_modifies_flows_logs_and_reports_stats(tmp_path) -> None:
    sample = next(item for item in bundled_samples() if item["id"] == "lanius.request-marker")
    assert sample["name"] == "Request Marker"
    packages = PluginPackageManager(tmp_path / "plugins")
    packages.install(
        bundled_sample_archive("lanius.request-marker"),
        install_record={"source": "bundled"},
    )
    store = FlowStore(tmp_path / "sample.sqlite")
    manager = PluginManager(
        tmp_path / "plugins", store=store, addons=FakeAddons(), packages=packages
    )
    manager.discover()
    plugin = manager.enable("lanius.request-marker")
    assert plugin.enabled and plugin.loaded
    assert plugin.meta["package"]["source"] == "bundled"
    assert plugin.meta["ui"]["views"][0]["id"] == "dashboard"

    manager.registry.set_setting("lanius.request-marker", "header_value", "demo")
    manager.registry.set_setting("lanius.request-marker", "log_requests", True)
    flow = tflow.tflow(req=tutils.treq(), resp=False)
    manager.addons.items[0].request(flow)
    assert flow.request.headers["X-Lanius-Sample"] == "demo"
    assert any(
        item["source"] == "stdout" and item["message"].startswith("marked ")
        for item in manager.registry.logs("lanius.request-marker")["items"]
    )
    stats = await manager.registry.invoke_action(
        "lanius.request-marker.stats", {"location": "global"}
    )
    assert stats == {
        "count": 1,
        "header": "X-Lanius-Sample",
        "value": "demo",
    }
    store.close()


def test_sample_api_installs_disabled_and_serves_its_ui_when_enabled(tmp_path) -> None:
    with TestClient(create_app(settings_for(tmp_path))) as client:
        samples = client.get("/api/plugin-samples").json()["items"]
        sample = next(item for item in samples if item["id"] == "lanius.request-marker")
        assert sample["installed"] is False

        installed = client.post(
            "/api/plugin-samples/lanius.request-marker/install"
        )
        assert installed.status_code == 200, installed.text
        plugin = installed.json()["plugin"]
        assert plugin["enabled"] is False and plugin["loaded"] is False
        assert plugin["package"]["source"] == "bundled"

        assert client.post(
            "/api/plugins/lanius.request-marker/enable"
        ).status_code == 200
        page = client.get("/api/plugin-ui/lanius.request-marker/index.html")
        assert page.status_code == 200
        assert "Request Marker" in page.text


def test_sample_install_is_local_but_execution_remains_blocked_by_lockdown(tmp_path) -> None:
    with TestClient(create_app(settings_for(tmp_path))) as client:
        locked = client.put(
            "/api/lockdown/project", json={"enabled": True}
        ).json()
        assert locked["effective"] is True
        installed = client.post(
            "/api/plugin-samples/lanius.request-marker/install"
        )
        assert installed.status_code == 200, installed.text
        assert installed.json()["plugin"]["loaded"] is False
        assert client.post(
            "/api/plugins/lanius.request-marker/enable"
        ).status_code == 423
        state = client.get("/api/plugins").json()
        assert state["suspended"] is True
        assert "Lockdown" in state["suspended_reason"]
