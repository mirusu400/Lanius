from __future__ import annotations

import asyncio
import socket

import httpx
import pytest
from mitmproxy.connection import Server
from mitmproxy.proxy.server_hooks import ServerConnectionHookData
from mitmproxy.test import tflow, tutils

from app.addons.scope import ScopeManager
from app.addons.scope_egress import (
    BLOCKED_METADATA,
    RAW_BLOCKED_ERROR,
    ScopeEgressEarlyAddon,
    ScopeEgressGuardAddon,
)
from app.db.store import FlowStore
from app.events import EventBroker
from app.lockdown import LockdownPolicy
from app.config import Settings
from app.proxy import ProxyEngine
from app.addons.replay import build_flow


def guarded(tmp_path):
    store = FlowStore(tmp_path / "guard.sqlite")
    scope = ScopeManager(store)
    policy = LockdownPolicy(store)
    policy.set_scope_egress(True)
    policy.set_project(True)
    broker = EventBroker()
    guard = ScopeEgressGuardAddon(scope, policy, broker)
    return store, scope, policy, broker, guard, ScopeEgressEarlyAddon(guard)


def http_flow(host: str, path: str = "/"):
    return tflow.tflow(req=tutils.treq(host=host, path=path.encode()))


def test_http_requests_are_killed_outside_scope(tmp_path) -> None:
    store, scope, _policy, broker, addon, early = guarded(tmp_path)
    scope.add_rule(host="allowed.test")
    queue = broker.subscribe()
    flow = http_flow("blocked.test", "/private?token=1")

    early.requestheaders(flow)

    assert flow.error is not None
    assert flow.metadata[BLOCKED_METADATA] is True
    event = queue.get_nowait()
    assert event["type"] == "engine.scope_egress_blocked"
    assert event["data"]["host"] == "blocked.test"
    assert event["data"]["path"] == "/private"
    store.close()


def test_http_requests_in_scope_are_left_alive(tmp_path) -> None:
    store, scope, _policy, _broker, addon, early = guarded(tmp_path)
    scope.add_rule(host="allowed.test", path="/api/*")
    flow = http_flow("allowed.test", "/api/users")

    early.requestheaders(flow)

    assert flow.error is None
    assert flow.live is True
    store.close()


def test_connect_uses_origin_match_until_path_is_visible(tmp_path) -> None:
    store, scope, _policy, _broker, _addon, early = guarded(tmp_path)
    scope.add_rule(host="allowed.test", path="/api/*")
    allowed = http_flow("allowed.test")
    blocked = http_flow("blocked.test")

    early.http_connect(allowed)
    early.http_connect(blocked)

    assert allowed.error is None
    assert blocked.error is not None
    store.close()


def test_raw_tcp_and_udp_are_always_blocked(tmp_path) -> None:
    store, scope, _policy, _broker, _addon, early = guarded(tmp_path)
    scope.add_rule(host="*")
    tcp_flow = tflow.ttcpflow()
    udp_flow = tflow.tudpflow()

    early.tcp_start(tcp_flow)
    early.udp_start(udp_flow)

    assert tcp_flow.server_conn.error == RAW_BLOCKED_ERROR
    assert udp_flow.server_conn.error == RAW_BLOCKED_ERROR
    store.close()


def test_parsed_dns_is_blocked_before_the_builtin_resolver(tmp_path) -> None:
    store, _scope, _policy, _broker, _addon, early = guarded(tmp_path)
    flow = tflow.tdnsflow()

    early.dns_request(flow)

    assert flow.error is not None
    assert flow.metadata[BLOCKED_METADATA] is True
    store.close()


def test_unknown_server_connection_is_refused_before_socket_open(tmp_path) -> None:
    store, scope, _policy, _broker, _addon, early = guarded(tmp_path)
    scope.add_rule(host="allowed.test")
    allowed_flow = http_flow("allowed.test")
    early.requestheaders(allowed_flow)
    port = allowed_flow.request.port
    allowed = Server(address=("allowed.test", port))
    blocked = Server(address=("blocked.test", port))

    early.server_connect(ServerConnectionHookData(allowed, allowed_flow.client_conn))
    early.server_connect(ServerConnectionHookData(blocked, allowed_flow.client_conn))

    assert allowed.error is None
    assert blocked.error == RAW_BLOCKED_ERROR
    store.close()


def test_guard_is_inert_without_effective_lockdown(tmp_path) -> None:
    store = FlowStore(tmp_path / "off.sqlite")
    scope = ScopeManager(store)
    scope.add_rule(host="allowed.test")
    policy = LockdownPolicy(store)
    policy.set_scope_egress(True)
    addon = ScopeEgressGuardAddon(scope, policy)
    early = ScopeEgressEarlyAddon(addon)
    flow = http_flow("blocked.test")
    tcp_flow = tflow.ttcpflow()

    early.requestheaders(flow)
    early.tcp_start(tcp_flow)

    assert flow.error is None
    assert tcp_flow.server_conn.error is None
    store.close()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.mark.asyncio
async def test_path_is_checked_before_any_upstream_connection(tmp_path) -> None:
    seen: list[bytes] = []
    accepted: list[bool] = []

    async def target(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        accepted.append(True)
        request = await reader.readuntil(b"\r\n\r\n")
        seen.append(request)
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
            b"Connection: close\r\n\r\nok"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(target, "127.0.0.1", 0)
    target_port = int(server.sockets[0].getsockname()[1])
    store = FlowStore(tmp_path / "live.sqlite")
    scope = ScopeManager(store)
    scope.add_rule(host="127.0.0.1", port=target_port, path="/allowed")
    policy = LockdownPolicy(store)
    policy.set_scope_egress(True)
    policy.set_project(True)
    proxy_port = free_port()
    engine = ProxyEngine(
        Settings(
            proxy_port=proxy_port,
            api_port=free_port(),
            data_dir=tmp_path,
            db_path=tmp_path / "live.sqlite",
            confdir=tmp_path / "mitm",
        ),
        store,
        EventBroker(),
        policy,
    )

    async def request(path: str) -> bytes:
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
        writer.write(
            f"GET http://127.0.0.1:{target_port}{path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{target_port}\r\nConnection: close\r\n\r\n".encode()
        )
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), timeout=3)
        writer.close()
        await writer.wait_closed()
        return response

    await engine.start()
    try:
        assert engine.master is not None
        assert engine.master.options.connection_strategy == "lazy"
        assert engine.master.addons.chain[0] is engine.scope_egress_early

        await request("/blocked")
        await asyncio.sleep(0)
        assert seen == []
        assert accepted == []

        async with httpx.AsyncClient(
            proxy=f"http://127.0.0.1:{proxy_port}",
            verify=False,
            timeout=3,
            trust_env=False,
        ) as client:
            with pytest.raises(httpx.HTTPError):
                await client.get(f"https://127.0.0.1:{target_port}/blocked")
        assert accepted == []

        replayed = await engine.replay.send(
            build_flow(url=f"http://127.0.0.1:{target_port}/blocked")
        )
        assert replayed.error
        assert seen == []

        response = await request("/allowed")
        assert b"200 OK" in response
        assert len(seen) == 1
        assert len(accepted) == 1
        assert seen[0].startswith(b"GET /allowed ")
    finally:
        await engine.stop()
        store.close()
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_upstream_proxy_is_used_only_after_scope_approval(tmp_path) -> None:
    seen: list[bytes] = []

    async def upstream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        seen.append(await reader.readuntil(b"\r\n\r\n"))
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
            b"Connection: close\r\n\r\nok"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(upstream, "127.0.0.1", 0)
    upstream_port = int(server.sockets[0].getsockname()[1])
    store = FlowStore(tmp_path / "upstream.sqlite")
    scope = ScopeManager(store)
    scope.add_rule(host="example.invalid", path="/allowed")
    policy = LockdownPolicy(store)
    policy.set_scope_egress(True)
    policy.set_project(True)
    proxy_port = free_port()
    engine = ProxyEngine(
        Settings(
            proxy_port=proxy_port,
            api_port=free_port(),
            data_dir=tmp_path,
            db_path=tmp_path / "upstream.sqlite",
            confdir=tmp_path / "mitm-upstream",
        ),
        store,
        EventBroker(),
        policy,
    )
    engine.upstream_hops = [f"http://127.0.0.1:{upstream_port}"]

    async def request(path: str) -> bytes:
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
        writer.write((
            f"GET http://example.invalid{path} HTTP/1.1\r\n"
            "Host: example.invalid\r\nConnection: close\r\n\r\n"
        ).encode())
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), timeout=3)
        writer.close()
        await writer.wait_closed()
        return response

    await engine.start()
    try:
        await request("/blocked")
        assert seen == []
        assert b"200 OK" in await request("/allowed")
        assert len(seen) == 1
    finally:
        await engine.stop()
        store.close()
        server.close()
        await server.wait_closed()
