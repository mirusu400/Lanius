"""Plugin MCP tools exercised through the protocol SDK and live HTTP mount."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.subscriptions import ToolsListChanged

from app.addons.plugins import PluginError, PluginManager
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowStore
from app.mcp import build_server, describe_tools
from app.plugin_output import install_output_routers
from lanius_sdk import PluginApiError


PLUGIN = '''
from __future__ import annotations

def activate(context):
    def inspect_host(host: str, limit: int = 2) -> dict[str, str | int]:
        print("inspecting " + host)
        return {"host": host, "limit": limit, "version": 1}

    async def reset() -> dict[str, bool]:
        return {"reset": True}

    context.mcp.register_tool("inspect_host", inspect_host, read_only=True,
                              description="Inspect one host")
    context.mcp.register_tool("reset", reset)
'''


@pytest.fixture()
def runtime(tmp_path):
    directory = tmp_path / "plugins"
    directory.mkdir()
    (directory / "acme.demo.py").write_text(PLUGIN)
    store = FlowStore(tmp_path / "project.sqlite")
    manager = PluginManager(directory, store=store)
    manager.discover()
    engine = SimpleNamespace(plugins=manager, broker=None)
    server = build_server(store, engine)
    yield manager, server
    for name, plugin in manager.plugins.items():
        if plugin.loaded:
            manager.disable(name)
    store.close()


def payload(result):
    if result.structured_content is not None:
        return result.structured_content
    return json.loads(result.content[0].text)


@pytest.mark.asyncio
async def test_typed_sync_async_tools_schema_ownership_and_diagnostics(runtime):
    manager, server = runtime
    install_output_routers()  # pytest swaps streams between fixture setup and call.
    manager.enable("acme.demo")
    tools = {tool.name: tool for tool in await server.list_tools()}
    tool = tools["acme.demo.inspect_host"]
    assert tool.input_schema["properties"]["host"]["type"] == "string"
    assert tool.input_schema["properties"]["limit"]["default"] == 2
    assert tool.input_schema["required"] == ["host"]
    assert tool.annotations.read_only_hint is True
    assert tool.output_schema is not None
    assert payload(await server.call_tool(tool.name, {"host": "example.test"})) == {
        "host": "example.test", "limit": 2, "version": 1,
    }
    assert payload(await server.call_tool("acme.demo.reset", {})) == {"reset": True}
    assert manager.registry.counts("acme.demo")["mcp_tools"] == 2
    described = {item["name"]: item for item in describe_tools(server)}
    assert described[tool.name]["plugin"] == "acme.demo"
    assert described[tool.name]["writes"] is False
    assert described["acme.demo.reset"]["writes"] is True
    diagnostics = manager.registry.diagnostics("acme.demo")
    assert all(item["calls"] == 1 for item in diagnostics["contributions"])
    assert any(item["source"] == "stdout" and "example.test" in item["message"]
               for item in diagnostics["logs"])
    for arguments in ({}, {"host": "x", "limit": "invalid"}, {"host": "x", "extra": 1}):
        with pytest.raises(ToolError):
            await server.call_tool(tool.name, arguments)
    assert "list_flows" in tools
    await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_reload_replaces_schema_refuses_stale_wrappers_and_notifies(runtime):
    manager, server = runtime
    events = []
    unsubscribe = server._plugin_bus.subscribe(events.append)
    manager.enable("acme.demo")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert any(isinstance(event, ToolsListChanged) for event in events)
    stale = manager.registry._get("mcp_tools", "acme.demo.inspect_host").handler.tool
    source = manager.directory / "acme.demo.py"
    source.write_text(PLUGIN.replace('limit: int = 2', 'limit: int = 3').replace('"version": 1', '"version": 2'))
    manager.reload("acme.demo")
    assert payload(await server.call_tool(stale.name, {"host": "x"}))["version"] == 2
    with pytest.raises(ToolError, match="reloaded"):
        await stale.run({"host": "x"}, Context(mcp_server=server))
    manager.disable("acme.demo")
    assert stale.name not in {tool.name for tool in await server.list_tools()}
    with pytest.raises(ToolError):
        await server.call_tool(stale.name, {"host": "x"})
    unsubscribe()
    await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_registration_dispose_failure_rollback_and_name_validation(runtime):
    manager, server = runtime
    context = manager.registry.context("other")

    def echo(value: str) -> dict:
        return {"value": value}

    handle = context.mcp.register_tool("echo", echo)
    with pytest.raises(PluginApiError, match="duplicate"):
        context.mcp.register_tool("echo", echo)
    with pytest.raises(PluginApiError):
        context.mcp.register_tool("some.tool", echo)
    with pytest.raises(PluginApiError, match="signature"):
        context.mcp.register_tool("untyped", lambda value: value)
    handle.dispose()
    handle.dispose()
    assert "other.echo" not in {tool.name for tool in await server.list_tools()}
    source = manager.directory / "acme.demo.py"
    source.write_text(PLUGIN + '\n    raise RuntimeError("activation failed")\n')
    with pytest.raises(PluginError):
        manager.enable("acme.demo")
    assert manager.registry.counts("acme.demo")["mcp_tools"] == 0
    assert not any(tool.name.startswith("acme.demo.") for tool in await server.list_tools())
    manager.registry.dispose_owner("other")
    await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_suspension_and_mcp_off_block_cached_and_direct_calls(runtime):
    manager, server = runtime
    manager.enable("acme.demo")
    stale = manager.registry._get("mcp_tools", "acme.demo.reset").handler.tool
    for suspend in (lambda: setattr(manager, "safe_mode", True),
                    lambda: setattr(manager, "lockdown_enabled", lambda: True)):
        suspend()
        assert not any(tool.name.startswith("acme.demo.") for tool in await server.list_tools())
        assert not any(item.get("plugin") for item in describe_tools(server))
        with pytest.raises(ToolError, match="suspended"):
            await server.call_tool(stale.name, {})
        with pytest.raises(ToolError, match="suspended"):
            await stale.run({}, Context(mcp_server=server))
        manager.safe_mode = False
        manager.lockdown_enabled = lambda: False
    manager.store.set_setting("mcp_enabled", "0")
    with pytest.raises(ToolError, match="turned off"):
        await server.call_tool(stale.name, {})
    await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_in_flight_calls_cancel_on_dispose_and_lockdown(runtime):
    manager, server = runtime
    manager.enable("acme.demo")
    context = manager.registry.context("acme.demo")
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def wait() -> dict:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    handle = context.mcp.register_tool("wait", wait)
    call = asyncio.create_task(server.call_tool("acme.demo.wait", {}))
    await started.wait()
    handle.dispose()
    with pytest.raises(ToolError, match="cancelled"):
        await call
    assert cancelled.is_set()
    context.mcp.register_tool("wait", wait)
    started.clear()
    call = asyncio.create_task(server.call_tool("acme.demo.wait", {}))
    await started.wait()
    manager.lockdown_enabled = lambda: True
    await manager.suspend_for_lockdown()
    with pytest.raises(ToolError):
        await call
    await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_timeout_json_limits_errors_and_sync_worker(runtime, monkeypatch):
    manager, server = runtime
    context = manager.registry.context("other")
    loop_thread = threading.get_ident()

    def thread() -> dict:
        return {"worker": threading.get_ident() != loop_thread}

    async def slow() -> dict:
        await asyncio.Event().wait()

    def crash() -> dict:
        raise RuntimeError("secret-handler-error")

    context.mcp.register_tool("thread", thread)
    assert payload(await server.call_tool("other.thread", {})) == {"worker": True}
    context.mcp.register_tool("slow", slow)
    monkeypatch.setattr("app.plugin_registry._CONTRIBUTION_TIMEOUT_SECONDS", 0.01)
    with pytest.raises(ToolError, match="timed out"):
        await server.call_tool("other.slow", {})
    monkeypatch.setattr("app.plugin_registry._CONTRIBUTION_TIMEOUT_SECONDS", 30)
    for name, value in (("large", "x" * (1024 * 1024)), ("invalid", object()), ("nan", float("nan"))):
        def result() -> dict:
            return {"value": value}
        context.mcp.register_tool(name, result)
        with pytest.raises(ToolError):
            await server.call_tool(f"other.{name}", {})
    context.mcp.register_tool("crash", crash)
    with pytest.raises(ToolError) as caught:
        await server.call_tool("other.crash", {})
    assert "secret-handler-error" not in str(caught.value)
    assert any("secret-handler-error" in entry["message"]
               for entry in manager.registry.logs("other")["items"])
    manager.registry.dispose_owner("other")
    await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_request_cancellation_cleans_up_managed_call(runtime):
    manager, server = runtime
    context = manager.registry.context("other")
    started = asyncio.Event()

    async def wait() -> dict:
        started.set()
        await asyncio.Event().wait()

    context.mcp.register_tool("wait", wait)
    call = asyncio.create_task(server.call_tool("other.wait", {}))
    await started.wait()
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    await asyncio.sleep(0)  # The managed task's done callback releases ownership.
    assert not manager.registry._mcp_calls
    assert not manager.registry._tasks["other"]
    manager.registry.dispose_owner("other")
    await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_timeout_does_not_wait_for_handler_cancellation_cleanup(runtime, monkeypatch):
    manager, server = runtime
    context = manager.registry.context("other")
    release = asyncio.Event()
    cleanup_started = asyncio.Event()

    async def delayed_cleanup() -> dict:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleanup_started.set()
            await release.wait()
        return {"finished": True}

    context.mcp.register_tool("cleanup", delayed_cleanup)
    monkeypatch.setattr("app.plugin_registry._CONTRIBUTION_TIMEOUT_SECONDS", 0.01)
    call = asyncio.create_task(server.call_tool("other.cleanup", {}))
    try:
        await asyncio.wait_for(cleanup_started.wait(), 1)
        done, _ = await asyncio.wait({call}, timeout=0.1)
        assert call in done, "the host timeout must not wait for plugin cleanup"
        with pytest.raises(ToolError, match="timed out"):
            await call
        assert manager.registry._tasks["other"], "unfinished cleanup must remain managed"
    finally:
        release.set()
        await asyncio.gather(call, *manager.registry._tasks.get("other", ()), return_exceptions=True)
        manager.registry.dispose_owner("other")
        await server.close_plugin_tools()


@pytest.mark.asyncio
async def test_output_schema_errors_are_recorded_in_plugin_diagnostics(runtime):
    manager, server = runtime
    context = manager.registry.context("other")

    def invalid_output() -> dict[str, int]:
        return {"count": "private-invalid-value"}

    context.mcp.register_tool("invalid_output", invalid_output)
    with pytest.raises(ToolError) as caught:
        await server.call_tool("other.invalid_output", {})
    assert "private-invalid-value" not in str(caught.value)
    diagnostic = manager.registry.diagnostics("other")["contributions"][0]
    assert diagnostic["calls"] == 1
    assert diagnostic["errors"] == 1
    assert any("private-invalid-value" in item["message"]
               for item in manager.registry.logs("other")["items"])
    manager.registry.dispose_owner("other")
    await server.close_plugin_tools()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_http_mcp_plugin_lifecycle_and_lockdown(tmp_path):
    directory = tmp_path / "plugins"
    directory.mkdir()
    (directory / "demo.py").write_text(PLUGIN)
    settings = Settings(data_dir=tmp_path, db_path=tmp_path / "project.sqlite",
                        confdir=tmp_path / "mitm", plugins_dir=directory,
                        api_port=free_port(), proxy_port=free_port())
    with TestClient(create_app(settings), base_url="http://127.0.0.1") as client:
        assert client.post("/api/plugins/demo/enable").status_code == 200
        status = client.get("/api/mcp").json()
        assert next(tool for tool in status["tools"] if tool["name"] == "demo.inspect_host")["plugin"] == "demo"
        headers = {"Accept": "application/json, text/event-stream"}
        init = client.post("/mcp/mcp", headers=headers, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "test", "version": "1"}},
        })
        assert init.status_code == 200
        headers["Mcp-Session-Id"] = init.headers["mcp-session-id"]
        client.post("/mcp/mcp", headers=headers,
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"})

        def rpc(method, params=None):
            response = client.post("/mcp/mcp", headers=headers, json={
                "jsonrpc": "2.0", "id": 2, "method": method, "params": params or {},
            })
            assert response.status_code == 200, response.text
            return json.loads(next(line[6:] for line in response.text.splitlines()
                                   if line.startswith("data: ")))["result"]

        assert "demo.inspect_host" in {tool["name"] for tool in rpc("tools/list")["tools"]}
        result = rpc("tools/call", {"name": "demo.inspect_host", "arguments": {"host": "x"}})
        assert not result.get("isError", False)
        assert rpc("tools/call", {"name": "demo.inspect_host", "arguments": {}})["isError"] is True
        assert client.put("/api/lockdown/project", json={"enabled": True}).status_code == 200
        assert not any(tool["name"].startswith("demo.") for tool in rpc("tools/list")["tools"])
        assert rpc("tools/call", {"name": "demo.reset", "arguments": {}})["isError"] is True
        assert client.put("/api/lockdown/project", json={"enabled": False}).status_code == 200
        assert "demo.reset" in {tool["name"] for tool in rpc("tools/list")["tools"]}
        assert client.post("/api/mcp", json={"enabled": False}).status_code == 200
        assert client.post("/mcp/mcp", headers=headers, json={
            "jsonrpc": "2.0", "id": 3, "method": "tools/list",
        }).status_code == 403
        assert client.post("/api/mcp", json={"enabled": True}).status_code == 200
        assert client.post("/api/plugins/demo/disable").status_code == 200
        assert not any(tool["name"].startswith("demo.") for tool in rpc("tools/list")["tools"])
