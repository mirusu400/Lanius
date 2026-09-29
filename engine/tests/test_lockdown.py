"""Lockdown Mode: Lanius-owned outbound traffic is refused, not just hidden.

Each test drives the real API, so a guard that only exists in the UI or
only on one of several paths fails here.
"""

from __future__ import annotations

import asyncio
import socket
import textwrap
from unittest import mock

import httpx
import pytest
from fastapi.testclient import TestClient

from app import updates, wordlists
from app.api.server import create_app
from app.config import Settings
from app.lockdown import LockdownBlocked

PLUGIN = textwrap.dedent(
    '''
    class Plugin:
        def request(self, flow):
            pass

    addons = [Plugin()]
    '''
)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def make_app(tmp_path):
    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir(exist_ok=True)
    (plugin_dir / "stamp.py").write_text(PLUGIN)
    return create_app(
        Settings(
            proxy_port=free_port(),
            api_port=free_port(),
            data_dir=tmp_path,
            db_path=tmp_path / "api.sqlite",
            confdir=tmp_path / "mitm",
            plugins_dir=plugin_dir,
        )
    )


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("LANIUS_LOCKDOWN", raising=False)
    monkeypatch.delenv("LANIUS_LOCKDOWN_GLOBAL", raising=False)
    with TestClient(make_app(tmp_path)) as c:
        yield c


def lock(client) -> None:
    assert client.put("/api/lockdown/project", json={"enabled": True}).json()["effective"]


def test_off_by_default(client) -> None:
    assert client.get("/api/lockdown").json() == {
        "global_enabled": False,
        "project_enabled": False,
        "effective": False,
    }


def test_global_env_forces_it_on(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LANIUS_LOCKDOWN_GLOBAL", "1")
    with TestClient(make_app(tmp_path)) as c:
        status = c.get("/api/lockdown").json()
        assert status["global_enabled"] and status["effective"]
        # The project switch cannot loosen the global one.
        assert c.put("/api/lockdown/project", json={"enabled": False}).json()["effective"]


def test_update_check_is_refused_before_any_request(client) -> None:
    lock(client)
    with mock.patch.object(updates, "_fetch_releases") as fetch:
        res = client.get("/api/updates", params={"refresh": "true"})
    assert res.status_code == 423
    assert res.json() == {"detail": "LOCKDOWN_MODE_BLOCKED"}
    fetch.assert_not_called()


def test_wordlist_download_is_refused(client) -> None:
    lock(client)
    with mock.patch.object(wordlists, "_fetch") as fetch:
        res = client.post("/api/wordlists/import", json={"list_id": "web-common"})
    assert res.status_code == 423
    fetch.assert_not_called()


def test_enabling_lockdown_cancels_an_update_check_in_flight(tmp_path) -> None:
    app = make_app(tmp_path)
    started = asyncio.Event()

    async def slow(policy=None):
        started.set()
        await asyncio.sleep(10)
        return []

    async def run() -> tuple[httpx.Response, httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            with mock.patch.object(updates, "_fetch_releases", slow):
                pending = asyncio.create_task(
                    c.get("/api/updates", params={"refresh": "true"})
                )
                await started.wait()
                await c.put("/api/lockdown/project", json={"enabled": True})
                blocked = await asyncio.wait_for(pending, 3)
            # The cancelled request must not leave the app wedged.
            after = await c.get("/api/lockdown")
            return blocked, after

    blocked, after = asyncio.run(run())
    assert blocked.status_code == 423
    assert after.status_code == 200


def test_plugins_are_suspended_and_restored(client) -> None:
    assert client.post("/api/plugins/stamp/enable").json()["loaded"] is True
    lock(client)
    plugin = next(p for p in client.get("/api/plugins").json()["items"] if p["name"] == "stamp")
    assert plugin["enabled"] is True and plugin["loaded"] is False

    assert client.post("/api/plugins/stamp/enable").status_code == 423
    assert client.post("/api/plugins/stamp/reload").status_code == 423

    client.put("/api/lockdown/project", json={"enabled": False})
    plugin = next(p for p in client.get("/api/plugins").json()["items"] if p["name"] == "stamp")
    assert plugin["loaded"] is True


def test_enabled_plugins_do_not_load_on_a_locked_start(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("LANIUS_LOCKDOWN", raising=False)
    monkeypatch.delenv("LANIUS_LOCKDOWN_GLOBAL", raising=False)
    with TestClient(make_app(tmp_path)) as c:
        c.post("/api/plugins/stamp/enable")
        lock(c)
    with TestClient(make_app(tmp_path)) as c:
        plugin = next(p for p in c.get("/api/plugins").json()["items"] if p["name"] == "stamp")
        assert plugin["enabled"] is True and plugin["loaded"] is False


def test_import_applies_a_locked_project(client) -> None:
    lock(client)
    exported = client.get("/api/project/export").json()
    client.put("/api/lockdown/project", json={"enabled": False})
    assert client.post("/api/project/import", json=exported).status_code == 200
    assert client.get("/api/lockdown").json()["effective"] is True


def test_import_cannot_turn_lockdown_off(client) -> None:
    lock(client)
    exported = client.get("/api/project/export").json()
    exported["settings"]["lockdown.project"] = "0"
    assert client.post("/api/project/import", json=exported).status_code == 200
    assert client.get("/api/lockdown").json()["project_enabled"] is True


def test_catalogue_refresh_is_refused(client) -> None:
    """A plugin catalogue is a download, so it follows the same rule."""
    lock(client)
    res = client.get("/api/plugin-catalogue", params={"refresh": "true"})
    assert res.status_code == 423
    assert res.json() == {"detail": "LOCKDOWN_MODE_BLOCKED"}
    # The cached catalogue is local, so reading it stays allowed.
    assert client.get("/api/plugin-catalogue").status_code == 200


def test_catalogue_install_is_refused_before_anything_is_unloaded(client) -> None:
    assert client.post("/api/plugins/stamp/enable").json()["loaded"] is True
    client.put("/api/lockdown/project", json={"enabled": False})
    lock(client)
    res = client.post(
        "/api/plugin-catalogue/install",
        json={"source": "example", "plugin": "stamp", "version": "1.0.0"},
    )
    assert res.status_code == 423
    plugin = next(p for p in client.get("/api/plugins").json()["items"] if p["name"] == "stamp")
    assert plugin["enabled"] is True


def test_catalogue_fetch_is_guarded_at_the_source(tmp_path, monkeypatch) -> None:
    """Even a caller that forgets to check cannot reach the network."""
    monkeypatch.delenv("LANIUS_LOCKDOWN", raising=False)
    monkeypatch.delenv("LANIUS_LOCKDOWN_GLOBAL", raising=False)
    app = make_app(tmp_path)
    catalogue = app.state.engine.plugin_catalogue
    with TestClient(app) as c:
        lock(c)
        with pytest.raises(LockdownBlocked):
            catalogue.fetch("https://example.invalid/catalogue.json", 1024)
