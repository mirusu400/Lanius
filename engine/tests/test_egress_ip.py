from __future__ import annotations

import asyncio
import socket
import threading
import time
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from app import egress_ip
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowStore


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "egress.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as api:
        yield api


def wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not reached")


def test_observations_only_add_rows_when_ip_changes(tmp_path) -> None:
    store = FlowStore(tmp_path / "store.sqlite")
    try:
        first = store.record_egress_ip_observation(
            family=4, ip="8.8.8.8", observed_at=1, observer_url=egress_ip.DEFAULT_IPV4_URL
        )
        same = store.record_egress_ip_observation(
            family=4, ip="8.8.8.8", observed_at=2,
            observer_url="https://observer.example/v4",
        )
        changed = store.record_egress_ip_observation(
            family=4, ip="1.1.1.1", observed_at=3, observer_url=egress_ip.DEFAULT_IPV4_URL
        )
        assert first["id"] == same["id"]
        assert same["last_seen_at"] == 2
        assert same["check_count"] == 2
        assert same["observer_url"] == "https://observer.example/v4"
        assert changed["id"] != same["id"]
        assert len(store.list_egress_ip_observations()) == 2
        assert [item["ip"] for item in store.list_egress_ip_observations(family=4)] == [
            "1.1.1.1",
            "8.8.8.8",
        ]
        assert store.list_egress_ip_observations(family=6) == []
        with pytest.raises(ValueError, match="family must be 4 or 6"):
            store.list_egress_ip_observations(family=5)
    finally:
        store.close()


def test_current_addresses_are_not_limited_by_history_page(client) -> None:
    store = client.app.state.store
    store.record_egress_ip_observation(
        family=6, ip="2001:4860:4860::8888", observed_at=1,
        observer_url=egress_ip.DEFAULT_IPV6_URL,
    )
    for index in range(1, 4):
        store.record_egress_ip_observation(
            family=4, ip=f"8.8.8.{index}", observed_at=index + 1,
            observer_url=egress_ip.DEFAULT_IPV4_URL,
        )

    state = client.get("/api/egress-ip?history_limit=1").json()
    assert len(state["history"]) == 1
    assert state["current"]["ipv4"]["ip"] == "8.8.8.3"
    assert state["current"]["ipv6"]["ip"] == "2001:4860:4860::8888"


def test_defaults_are_disabled_and_custom_endpoints_are_saved(client) -> None:
    state = client.get("/api/egress-ip").json()
    assert state["enabled"] is False
    assert state["interval_seconds"] == 180
    assert state["ipv4_url"] == "https://api.ipify.org"
    assert state["ipv6_url"] == "https://api6.ipify.org"

    updated = client.put("/api/egress-ip", json={
        "enabled": False,
        "interval_seconds": 300,
        "ipv4_url": "https://observer.example/v4",
        "ipv6_url": "https://observer.example/v6",
    })
    assert updated.status_code == 200
    assert updated.json()["ipv4_url"] == "https://observer.example/v4"
    assert client.put("/api/egress-ip", json={
        "enabled": False,
        "interval_seconds": 120,
        "ipv4_url": "https://observer.example/v4",
        "ipv6_url": "https://observer.example/v6",
    }).status_code == 422
    assert client.put("/api/egress-ip", json={
        "enabled": False,
        "interval_seconds": 180,
        "ipv4_url": "http://observer.example/v4",
        "ipv6_url": "https://observer.example/v6",
    }).status_code == 422


def test_enabled_monitor_records_both_families_without_history_flows(client) -> None:
    calls: list[tuple[str, int, str | None]] = []

    async def observed(url: str, family: int, proxy: str | None) -> str:
        calls.append((url, family, proxy))
        return "8.8.8.8" if family == 4 else "2001:4860:4860::8888"

    with mock.patch.object(egress_ip, "_request_ip", observed):
        response = client.put("/api/egress-ip", json={
            "enabled": True,
            "interval_seconds": 60,
            "ipv4_url": egress_ip.DEFAULT_IPV4_URL,
            "ipv6_url": egress_ip.DEFAULT_IPV6_URL,
        })
        assert response.status_code == 200
        wait_until(lambda: len(client.get("/api/egress-ip").json()["history"]) == 2)

    state = client.get("/api/egress-ip").json()
    assert state["current"]["ipv4"]["ip"] == "8.8.8.8"
    assert state["current"]["ipv6"]["ip"] == "2001:4860:4860::8888"
    assert {(family, proxy) for _url, family, proxy in calls} == {(4, None), (6, None)}
    assert client.get("/api/flows").json()["count"] == 0


def test_lockdown_never_calls_or_saves_observer(client) -> None:
    assert client.put("/api/lockdown/project", json={"enabled": True}).status_code == 200
    calls = 0

    async def observed(_url: str, _family: int, _proxy: str | None) -> str:
        nonlocal calls
        calls += 1
        return "8.8.8.8"

    with mock.patch.object(egress_ip, "_request_ip", observed):
        response = client.put("/api/egress-ip", json={
            "enabled": True,
            "interval_seconds": 60,
            "ipv4_url": egress_ip.DEFAULT_IPV4_URL,
            "ipv6_url": egress_ip.DEFAULT_IPV6_URL,
        })
        assert response.status_code == 200
        time.sleep(0.1)

    state = client.get("/api/egress-ip").json()
    assert state["blocked_by_lockdown"] is True
    assert state["history"] == []
    assert calls == 0


def test_enabling_lockdown_cancels_probe_before_db_write(client) -> None:
    started = threading.Event()

    async def slow(_url: str, _family: int, _proxy: str | None) -> str:
        started.set()
        await asyncio.sleep(10)
        return "8.8.8.8"

    with mock.patch.object(egress_ip, "_request_ip", slow):
        client.put("/api/egress-ip", json={
            "enabled": True,
            "interval_seconds": 60,
            "ipv4_url": egress_ip.DEFAULT_IPV4_URL,
            "ipv6_url": egress_ip.DEFAULT_IPV6_URL,
        })
        assert started.wait(2)
        assert client.put("/api/lockdown/project", json={"enabled": True}).status_code == 200
        time.sleep(0.05)

    assert client.get("/api/egress-ip").json()["history"] == []


def test_export_and_import_keep_observations(client) -> None:
    client.app.state.store.record_egress_ip_observation(
        family=4, ip="8.8.4.4", observed_at=5, observer_url=egress_ip.DEFAULT_IPV4_URL
    )
    exported = client.get("/api/project/export?include_flows=false").json()
    assert exported["egress_ip_observations"][0]["ip"] == "8.8.4.4"
    client.app.state.store.record_egress_ip_observation(
        family=4, ip="1.1.1.1", observed_at=6, observer_url=egress_ip.DEFAULT_IPV4_URL
    )
    assert client.post("/api/project/import", json=exported).status_code == 200
    history = client.get("/api/egress-ip").json()["history"]
    assert [item["ip"] for item in history] == ["8.8.4.4"]
