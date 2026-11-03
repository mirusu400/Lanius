from __future__ import annotations

import asyncio
import socket
import time
from unittest import mock

import httpx
import pytest
from fastapi.testclient import TestClient
from mitmproxy.connection import Server
from mitmproxy.proxy.server_hooks import ServerConnectionHookData
from mitmproxy.test import tflow, tutils

from app import egress_ip, egress_pin
from app.addons.egress_pin import BLOCKED_ERROR, EgressPinAddon
from app.addons.replay import build_flow
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowStore
from app.egress_pin import EgressPinPolicy
from app.events import EventBroker
from app.lockdown import LockdownPolicy
from app.proxy import ProxyEngine

NETWORK_A = frozenset({("en0", "192.168.0.10")})
NETWORK_B = frozenset({("en0", "192.168.0.10"), ("utun4", "10.8.0.2")})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_until(predicate, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not reached")


class Network:
    def __init__(self) -> None:
        self.current = NETWORK_A

    def __call__(self) -> frozenset[tuple[str, str]]:
        return self.current


def pinned_policy(tmp_path, ipv4="8.8.8.8", ipv6=None):
    store = FlowStore(tmp_path / "pin.sqlite")
    lockdown = LockdownPolicy(store)
    network = Network()
    pin = EgressPinPolicy(store, lockdown, interfaces=network)
    pin.configure(True, ipv4, ipv6)
    return store, lockdown, network, pin


def test_pin_is_inert_until_enabled(tmp_path) -> None:
    store = FlowStore(tmp_path / "off.sqlite")
    pin = EgressPinPolicy(store, LockdownPolicy(store), interfaces=Network())
    assert pin.allowed
    assert pin.reason() is None
    store.close()


def test_pin_allows_only_after_a_matching_observation(tmp_path) -> None:
    store, _lockdown, network, pin = pinned_policy(tmp_path)
    assert pin.reason() == "unverified"

    pin.observed(4, "8.8.8.8", network())
    assert pin.allowed

    pin.observed(4, "1.1.1.1", network())
    assert pin.reason() == "mismatch"
    assert pin.status()["mismatch"]["ipv4"] == "1.1.1.1"

    pin.observed(4, "8.8.8.8", network())
    assert pin.allowed
    store.close()


def test_an_unpinned_family_appearing_blocks_until_it_disappears(tmp_path) -> None:
    store, _lockdown, network, pin = pinned_policy(tmp_path)
    pin.observed(4, "8.8.8.8", network())
    pin.observed(6, "2001:4860:4860::8888", network())
    assert pin.reason() == "mismatch"
    pin.observation_failed(6)
    assert pin.allowed
    store.close()


def test_observation_failure_and_expiry_block(tmp_path) -> None:
    store, _lockdown, network, pin = pinned_policy(tmp_path)
    pin.observed(4, "8.8.8.8", network())
    pin.observation_failed(4)
    assert pin.reason() == "unverified"

    pin.observed(4, "8.8.8.8", network())
    later = time.monotonic() + egress_pin.VALID_SECONDS + 1
    with mock.patch.object(egress_pin.time, "monotonic", return_value=later):
        assert pin.reason() == "unverified"
    # A wall clock moving backwards cannot extend a confirmation either.
    earlier = time.time() - 60
    with mock.patch.object(egress_pin.time, "time", return_value=earlier):
        assert pin.reason() == "unverified"
    store.close()


def test_network_change_during_observation_is_not_trusted(tmp_path) -> None:
    store, _lockdown, network, pin = pinned_policy(tmp_path)
    rechecks = []
    pin.on_unverified = lambda: rechecks.append(True)
    before = network()
    network.current = NETWORK_B
    pin.observed(4, "8.8.8.8", before)
    assert pin.reason() == "unverified"
    assert rechecks == [True]
    store.close()


async def test_watcher_revokes_when_interfaces_change(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(egress_pin, "WATCH_SECONDS", 0.01)
    store, _lockdown, network, pin = pinned_policy(tmp_path)
    revoked = []
    pin.on_revoked = lambda: revoked.append(True)
    pin.observed(4, "8.8.8.8", network())
    assert pin.evaluate()
    pin.start()
    try:
        network.current = NETWORK_B
        for _ in range(200):
            if revoked:
                break
            await asyncio.sleep(0.01)
    finally:
        await pin.stop()
    assert revoked == [True]
    assert pin.reason() == "unverified"
    store.close()


def test_lockdown_blocks_a_pinned_project(tmp_path) -> None:
    store, lockdown, network, pin = pinned_policy(tmp_path)
    pin.observed(4, "8.8.8.8", network())
    lockdown.set_project(True)
    assert pin.reason() == "lockdown"
    store.close()


def test_pin_survives_reload_from_the_project_database(tmp_path) -> None:
    store, lockdown, _network, _pin = pinned_policy(tmp_path, ipv6="2001:db8::1")
    again = EgressPinPolicy(store, lockdown, interfaces=Network())
    assert again.enabled
    assert again.pinned == {4: "8.8.8.8", 6: "2001:db8::1"}
    assert again.reason() == "unverified"
    store.close()


def test_guard_refuses_every_hook_while_unconfirmed(tmp_path) -> None:
    store, _lockdown, network, pin = pinned_policy(tmp_path)
    broker = EventBroker()
    guard = EgressPinAddon(pin, broker)
    flow = tflow.tflow(req=tutils.treq(host="example.com"))
    tcp_flow = tflow.ttcpflow()
    server = Server(address=("example.com", 443))

    guard.requestheaders(flow)
    guard.tcp_start(tcp_flow)
    guard.server_connect(ServerConnectionHookData(server, flow.client_conn))

    assert flow.error is not None
    assert tcp_flow.server_conn.error == BLOCKED_ERROR
    assert server.error == BLOCKED_ERROR

    pin.observed(4, "8.8.8.8", network())
    allowed = tflow.tflow(req=tutils.treq(host="example.com"))
    allowed_server = Server(address=("example.com", 443))
    guard.requestheaders(allowed)
    guard.server_connect(ServerConnectionHookData(allowed_server, allowed.client_conn))
    assert allowed.error is None
    assert allowed_server.error is None
    store.close()


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "pin-api.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as api:
        yield api


def observe(client, ipv4: str = "8.8.8.8"):
    async def observed(_url: str, family: int, _proxy: str | None) -> str:
        if family == 6:
            raise ValueError("no IPv6")
        return ipv4

    patcher = mock.patch.object(egress_ip, "_request_ip", observed)
    patcher.start()
    response = client.put("/api/egress-ip", json={
        "enabled": True,
        "interval_seconds": 60,
        "ipv4_url": egress_ip.DEFAULT_IPV4_URL,
        "ipv6_url": egress_ip.DEFAULT_IPV6_URL,
    })
    assert response.status_code == 200
    wait_until(lambda: client.get("/api/egress-ip").json()["pin"]["candidates"]["ipv4"] == ipv4)
    return patcher


def test_pin_requires_observation(client) -> None:
    response = client.put("/api/egress-ip/pin", json={"enabled": True, "ipv4": "8.8.8.8"})
    assert response.status_code == 409


def test_pin_and_unpin_through_the_api(client) -> None:
    patcher = observe(client)
    try:
        stale = client.put("/api/egress-ip/pin", json={"enabled": True, "ipv4": "1.1.1.1"})
        assert stale.status_code == 409

        response = client.put("/api/egress-ip/pin", json={"enabled": True, "ipv4": "8.8.8.8"})
        assert response.status_code == 200
        assert response.json()["pin"]["enabled"] is True
        assert response.json()["poll_seconds"] == egress_pin.POLL_SECONDS
        wait_until(lambda: client.get("/api/egress-ip").json()["pin"]["allowed"] is True)

        store = client.app.state.store
        assert store.get_setting(egress_pin.ENABLED_SETTING) == "1"
        assert store.get_setting(egress_pin.IPV4_SETTING) == "8.8.8.8"

        disable = client.put("/api/egress-ip", json={
            "enabled": False,
            "interval_seconds": 60,
            "ipv4_url": egress_ip.DEFAULT_IPV4_URL,
            "ipv6_url": egress_ip.DEFAULT_IPV6_URL,
        })
        assert disable.status_code == 409

        # Lockdown blocks a pinned project; removing the pin is still allowed.
        assert client.put("/api/lockdown/project", json={"enabled": True}).status_code == 200
        assert client.get("/api/egress-ip").json()["pin"]["reason"] == "lockdown"
        response = client.put("/api/egress-ip/pin", json={"enabled": False})
        assert response.status_code == 200
        assert response.json()["pin"]["enabled"] is False
    finally:
        patcher.stop()


def test_pin_is_refused_while_lockdown_is_active(client) -> None:
    patcher = observe(client)
    try:
        assert client.put("/api/lockdown/project", json={"enabled": True}).status_code == 200
        response = client.put("/api/egress-ip/pin", json={"enabled": True, "ipv4": "8.8.8.8"})
        assert response.status_code == 423
        assert response.json()["detail"] == "LOCKDOWN_MODE_BLOCKED"
    finally:
        patcher.stop()


def test_ip_change_is_blocked_through_the_api(client) -> None:
    patcher = observe(client)
    try:
        assert client.put(
            "/api/egress-ip/pin", json={"enabled": True, "ipv4": "8.8.8.8"},
        ).status_code == 200
        wait_until(lambda: client.get("/api/egress-ip").json()["pin"]["allowed"] is True)
    finally:
        patcher.stop()
    patcher = observe(client, "1.1.1.1")
    try:
        client.app.state.egress_ip.route_changed()
        wait_until(lambda: client.get("/api/egress-ip").json()["pin"]["reason"] == "mismatch")
    finally:
        patcher.stop()


@pytest.mark.parametrize("transport", ["proxy", "replay"])
async def test_unconfirmed_pin_refuses_sockets_and_confirmed_pin_allows(
    tmp_path, transport,
) -> None:
    accepted: list[bool] = []

    async def target(reader, writer):
        accepted.append(True)
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(target, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    store = FlowStore(tmp_path / "live.sqlite")
    engine = ProxyEngine(Settings(
        proxy_port=free_port(), api_port=free_port(), data_dir=tmp_path,
        db_path=tmp_path / "live.sqlite", confdir=tmp_path / "mitm",
    ), store, EventBroker())
    network = Network()
    engine.egress_pin._interfaces = network
    engine.egress_pin.configure(True, "8.8.8.8", None)
    await engine.start()
    url = f"http://127.0.0.1:{port}/"

    async def send() -> bool:
        if transport == "replay":
            record = await engine.replay.send(build_flow(url=url))
            return not record.error
        async with httpx.AsyncClient(
            proxy=f"http://127.0.0.1:{engine.settings.proxy_port}", trust_env=False,
        ) as client:
            try:
                return (await client.get(url)).status_code == 200
            except httpx.HTTPError:
                return False

    try:
        assert await send() is False
        assert accepted == []
        engine.egress_pin.observed(4, "8.8.8.8", network())
        assert await send() is True
        assert accepted == [True]
    finally:
        await engine.stop()
        server.close()
        await server.wait_closed()
        store.close()
