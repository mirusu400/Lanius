"""MCP server tests: tools are called through the real MCP machinery."""

from __future__ import annotations

import json
import socket
import time

import pytest
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowRecord, FlowStore
from app.mcp import build_server, flow_detail, redact_headers


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def record(flow_id: str = "f1", **kwargs) -> FlowRecord:
    base = dict(
        id=flow_id,
        method="GET",
        scheme="https",
        host="api.test",
        port=443,
        path="/users/1",
        query="page=1",
        started_at=time.time(),
        status_code=200,
        request_headers=[
            ("Host", "api.test"),
            ("Authorization", "Bearer supersecret"),
            ("Cookie", "session=abc"),
            ("Accept", "*/*"),
        ],
        response_headers=[("Set-Cookie", "s=1"), ("Content-Type", "text/html")],
        request_body=b"",
        response_body=b"hello",
        response_size=5,
    )
    base.update(kwargs)
    return FlowRecord(**base)


@pytest.fixture()
def store(tmp_path):
    s = FlowStore(tmp_path / "mcp.sqlite")
    yield s
    s.close()


async def call(server, name: str, **arguments):
    """Invoke a tool through the real MCP machinery and unwrap the payload."""
    result = await server.call_tool(name, arguments)
    structured = getattr(result, "structured_content", None)
    if structured is not None:
        return structured
    content = getattr(result, "content", result)
    if isinstance(content, list) and content:
        text = getattr(content[0], "text", None)
        if text:
            return json.loads(text)
    return content


# --- redaction ------------------------------------------------------------


def test_redact_headers_hides_secrets_by_default() -> None:
    headers = [("Authorization", "Bearer x"), ("Accept", "*/*")]
    assert redact_headers(headers) == [
        ["Authorization", "<redacted>"],
        ["Accept", "*/*"],
    ]


def test_redact_headers_reveal_opt_in() -> None:
    headers = [("Cookie", "s=1")]
    assert redact_headers(headers, reveal=True) == [["Cookie", "s=1"]]


def test_redact_covers_api_key_headers() -> None:
    redacted = dict(
        (k, v) for k, v in redact_headers([("X-API-Key", "abc"), ("X-Auth-Token", "t")])
    )
    assert set(redacted.values()) == {"<redacted>"}


def test_redact_handles_empty_headers() -> None:
    assert redact_headers(None) == []


def test_flow_detail_marks_redaction_state() -> None:
    detail = flow_detail(record())
    assert detail["redacted"] is True
    assert flow_detail(record(), reveal=True)["redacted"] is False


def test_flow_detail_builds_a_url() -> None:
    assert flow_detail(record())["url"] == "https://api.test/users/1?page=1"


def test_flow_detail_truncates_huge_bodies() -> None:
    detail = flow_detail(record(response_body=b"x" * 50_000))
    assert "truncated" in detail["response_body"]
    assert len(detail["response_body"]) < 50_000


# --- read-only tools ------------------------------------------------------


@pytest.mark.asyncio
async def test_list_tools_exposes_the_expected_surface(store) -> None:
    server = build_server(store)
    names = {t.name for t in await server.list_tools()}
    assert {
        "list_flows",
        "get_flow",
        "list_sites",
        "list_endpoints",
        "get_scope",
        "add_scope_rule",
        "list_intercepted",
        "set_intercept",
        "forward_intercepted",
        "drop_intercepted",
        "send_request",
        "replay_flow",
        "decode_value",
    } <= names


@pytest.mark.asyncio
async def test_list_flows_tool(store) -> None:
    store.upsert(record("a", path="/one"))
    store.upsert(record("b", path="/two"))
    server = build_server(store)
    result = await call(server, "list_flows")
    assert result["count"] == 2
    assert {f["id"] for f in result["flows"]} == {"a", "b"}


@pytest.mark.asyncio
async def test_list_flows_filters(store) -> None:
    store.upsert(record("a", host="one.test"))
    store.upsert(record("b", host="two.test", method="POST"))
    server = build_server(store)
    assert (await call(server, "list_flows", host="two.test"))["count"] == 1
    assert (await call(server, "list_flows", method="POST"))["count"] == 1
    assert (await call(server, "list_flows", search="users"))["count"] == 2


@pytest.mark.asyncio
async def test_get_flow_redacts_by_default(store) -> None:
    store.upsert(record("a"))
    server = build_server(store)
    detail = await call(server, "get_flow", flow_id="a")
    headers = dict((k, v) for k, v in detail["request_headers"])
    assert headers["Authorization"] == "<redacted>"
    assert headers["Cookie"] == "<redacted>"
    assert headers["Accept"] == "*/*"


@pytest.mark.asyncio
async def test_get_flow_reveal_secrets(store) -> None:
    store.upsert(record("a"))
    server = build_server(store)
    detail = await call(server, "get_flow", flow_id="a", reveal_secrets=True)
    headers = dict((k, v) for k, v in detail["request_headers"])
    assert headers["Authorization"] == "Bearer supersecret"


@pytest.mark.asyncio
async def test_get_missing_flow_returns_error(store) -> None:
    server = build_server(store)
    assert "error" in await call(server, "get_flow", flow_id="nope")


@pytest.mark.asyncio
async def test_list_sites_tool(store) -> None:
    store.upsert(record("a", host="one.test"))
    store.upsert(record("b", host="two.test"))
    server = build_server(store)
    sites = (await call(server, "list_sites"))["sites"]
    assert {s["host"] for s in sites} == {"one.test", "two.test"}


@pytest.mark.asyncio
async def test_list_endpoints_groups_dynamic_paths(store) -> None:
    for i in range(3):
        store.upsert(record(f"f{i}", path=f"/users/{i}"))
    server = build_server(store)
    endpoints = (await call(server, "list_endpoints"))["endpoints"]
    assert any(e["template"] == "/users/{id}" and e["count"] == 3 for e in endpoints)


@pytest.mark.asyncio
async def test_decode_value_tool(store) -> None:
    server = build_server(store)
    assert (await call(server, "decode_value", value="aGk="))["output"] == "hi"
    assert "error" in await call(
        server, "decode_value", value="x", codec="nonsense"
    )


@pytest.mark.asyncio
async def test_engine_tools_report_absence_without_engine(store) -> None:
    server = build_server(store)
    assert "error" in await call(server, "get_scope")
    assert "error" in await call(server, "send_request", url="http://x")


# --- tools backed by a live engine ---------------------------------------


@pytest.fixture()
def live(tmp_path):
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "live.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=tmp_path / "plugins",
    )
    with TestClient(create_app(settings)) as client:
        engine = client.app.state.engine
        yield client, build_server(client.app.state.store, engine), engine


@pytest.mark.asyncio
async def test_scope_tools_against_a_live_engine(live) -> None:
    _client, server, engine = live
    added = await call(
        server, "add_scope_rule", url="https://target.test/app"
    )
    assert added["host"] == "target.test"
    scope = await call(server, "get_scope")
    assert scope["rules"][0]["host"] == "target.test"
    assert engine.scope.contains("https", "target.test", 443, "/app/x") is True


@pytest.mark.asyncio
async def test_intercept_tools_against_a_live_engine(live) -> None:
    from mitmproxy.test import tflow, tutils

    _client, server, engine = live
    rules = await call(server, "set_intercept", enabled=True)
    assert rules["enabled"] is True

    flow = tflow.tflow(req=tutils.treq(host="held.test"), resp=False)
    engine.intercept.request(flow)
    listed = await call(server, "list_intercepted")
    assert listed["paused"][0]["id"] == flow.id

    forwarded = await call(
        server, "forward_intercepted", flow_id=flow.id, path="/changed"
    )
    assert forwarded["ok"] is True
    assert flow.request.path == "/changed"
    assert not flow.intercepted


@pytest.mark.asyncio
async def test_drop_intercepted_tool(live) -> None:
    from mitmproxy.test import tflow, tutils

    _client, server, engine = live
    await call(server, "set_intercept", enabled=True)
    flow = tflow.tflow(req=tutils.treq(host="held.test"), resp=False)
    engine.intercept.request(flow)
    assert (await call(server, "drop_intercepted", flow_id=flow.id))["ok"] is True
    assert flow.error is not None


@pytest.mark.asyncio
async def test_forward_unknown_flow_returns_error(live) -> None:
    _client, server, _engine = live
    assert "error" in await call(server, "forward_intercepted", flow_id="ghost")


@pytest.mark.asyncio
async def test_intercepted_listing_is_redacted(live) -> None:
    from mitmproxy.test import tflow, tutils

    _client, server, engine = live
    await call(server, "set_intercept", enabled=True)
    req = tutils.treq(host="held.test")
    req.headers["Authorization"] = "Bearer topsecret"
    flow = tflow.tflow(req=req, resp=False)
    engine.intercept.request(flow)

    listed = await call(server, "list_intercepted")
    headers = dict((k, v) for k, v in listed["paused"][0]["request_headers"])
    assert headers["Authorization"] == "<redacted>"


@pytest.mark.asyncio
async def test_send_request_rejects_bad_urls(live) -> None:
    _client, server, _engine = live
    assert "error" in await call(server, "send_request", url="not-a-url")


@pytest.mark.asyncio
async def test_replay_unknown_flow(live) -> None:
    _client, server, _engine = live
    assert "error" in await call(server, "replay_flow", flow_id="ghost")


def test_mcp_is_mounted_on_the_engine(live) -> None:
    """The GUI engine exposes MCP on the same local-only port."""
    client, _server, _engine = live
    assert client.app.state.mcp is not None
    routes = [getattr(r, "path", "") for r in client.app.routes]
    assert "/mcp" in routes


def test_mcp_http_endpoint_initializes(live) -> None:
    """Regression: the mounted app's session manager must be started by the
    lifespan, otherwise every request fails with 'Task group is not
    initialized'."""
    client, _server, _engine = live
    # TestClient's default host is "testserver"; MCP's DNS-rebinding guard
    # only accepts localhost, so talk to it as 127.0.0.1.
    client.base_url = client.base_url.copy_with(host="127.0.0.1")
    res = client.post(
        "/mcp/mcp",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    assert res.status_code == 200
    assert "lanius" in res.text
