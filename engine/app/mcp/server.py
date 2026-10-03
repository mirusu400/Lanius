"""MCP server exposing Lanius to coding agents (M8).

Tools are thin wrappers over the same store/addons the GUI uses. Secrets are
redacted by default and only revealed on an explicit opt-in (codex.md §10).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Sequence

from ..addons.intercept import InterceptError
from ..addons.replay import ReplayError, build_flow
from ..addons.scope import ScopeError
from ..db.store import ANNOTATION_COLORS, FlowRecord, FlowStore

from ..codegen import SECRET_HEADERS, is_secret_header

logger = logging.getLogger(__name__)

# One list of what counts as a secret, shared with the code generators,
# so a header added in one place is not still leaking in the other.
SENSITIVE_HEADERS = SECRET_HEADERS
REDACTED = "<redacted>"
MAX_BODY_CHARS = 20_000


def redact_headers(
    headers: Sequence[tuple[str, str]] | None, *, reveal: bool = False
) -> list[list[str]]:
    if not headers:
        return []
    if reveal:
        return [[k, v] for k, v in headers]
    return [
        [k, REDACTED if is_secret_header(k) else v] for k, v in headers
    ]


def truncate(text: str | None, limit: int = MAX_BODY_CHARS) -> str:
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n… [truncated, {len(text)} chars total]"


def flow_summary(record: FlowRecord | dict[str, Any]) -> dict[str, Any]:
    get = record.get if isinstance(record, dict) else lambda key: getattr(record, key, None)
    scheme, port = get("scheme"), get("port")
    port_suffix = "" if port is None or (scheme, port) in {("http", 80), ("https", 443)} else f":{port}"
    return {
        "id": get("id"),
        "type": get("type"),
        "method": get("method"),
        "url": f"{scheme}://{get('host')}{port_suffix}{get('path') or ''}"
        + (f"?{get('query')}" if get("query") else ""),
        "status": get("status_code"),
        "size": get("response_size"),
        "duration_ms": get("duration_ms"),
        "source": get("source"),
        "error": get("error"),
        "bookmarked": bool(get("bookmarked")),
        "annotation_color": get("annotation_color"),
    }


def flow_detail(
    record: FlowRecord, *, reveal: bool = False,
    annotation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        **flow_summary(record),
        **(annotation or {}),
        "host": record.host,
        "port": record.port,
        "scheme": record.scheme,
        "path": record.path,
        "query": record.query,
        "http_version": record.http_version,
        "request_headers": redact_headers(record.request_headers, reveal=reveal),
        "request_body": truncate(
            (record.request_body or b"").decode("utf-8", errors="replace")
        ),
        "response_headers": redact_headers(record.response_headers, reveal=reveal),
        "response_body": truncate(
            (record.response_body or b"").decode("utf-8", errors="replace")
        ),
        "redacted": not reveal,
    }


def build_server(store: FlowStore, engine: Any = None, name: str = "lanius") -> Any:
    """Create the MCP server. ``engine`` is optional for read-only use."""
    from mcp.server.mcpserver import MCPServer

    server = MCPServer(
        name=name,
        instructions=(
            "Lanius web security proxy. Inspect captured HTTP traffic, manage "
            "scope, hold and edit intercepted requests, and replay requests. "
            "Bookmark a captured PoC with bookmark_flow using the flow ID "
            "returned by send_request or replay_flow. "
            "Sensitive headers are redacted unless reveal_secrets=true."
        ),
    )

    @server.tool(description="List captured flows, newest first.")
    async def list_flows(
        limit: int = 50,
        offset: int = 0,
        anchor: int | None = None,
        cursor: str | None = None,
        host: str | None = None,
        method: str | None = None,
        status_code: int | None = None,
        search: str | None = None,
        bookmarked_only: bool = False,
        annotation_color: str | None = None,
    ) -> dict[str, Any]:
        try:
            page = await asyncio.to_thread(
                store.page_summaries,
                limit=max(1, min(limit, 500)),
                offset=max(0, offset),
                anchor=max(0, anchor) if anchor is not None else None,
                cursor=cursor,
                host=host,
                method=method,
                status_code=status_code,
                search=search,
                bookmarked_only=bookmarked_only,
                annotation_color=annotation_color,
            )
        except ValueError as exc:
            return {"error": str(exc)}
        return {"count": len(page["items"]), "has_more": page["has_more"],
                "anchor": page["anchor"],
                "next_cursor": page["next_cursor"],
                "flows": [flow_summary(item) for item in page["items"]]}

    @server.tool(
        description=(
            "Get one flow with headers and bodies. Sensitive headers are "
            "redacted unless reveal_secrets is true."
        )
    )
    async def get_flow(flow_id: str, reveal_secrets: bool = False) -> dict[str, Any]:
        record = await asyncio.to_thread(store.get, flow_id)
        if record is None:
            return {"error": f"flow {flow_id} not found"}
        annotation = await asyncio.to_thread(store.get_annotation, flow_id)
        return flow_detail(record, reveal=reveal_secrets, annotation=annotation)

    @server.tool(
        description=(
            "Bookmark or unbookmark a captured flow by ID. Use the ID returned "
            "by send_request/replay_flow, or find a proxied PoC with list_flows. "
            "Optionally set a red, orange, yellow, green, blue or purple highlight. "
            "Omit color to preserve the current highlight."
        )
    )
    async def bookmark_flow(
        flow_id: str, bookmarked: bool = True, color: str | None = None,
    ) -> dict[str, Any]:
        if color is not None and color not in ANNOTATION_COLORS:
            return {"error": "invalid annotation color"}
        changes: dict[str, Any] = {"bookmarked": bookmarked}
        if color is not None:
            changes["annotation_color"] = color
        annotation = await asyncio.to_thread(store.patch_annotation, flow_id, changes)
        if annotation is None:
            return {"error": f"flow {flow_id} not found"}
        if engine is not None:
            engine.broker.publish("flow.annotation", annotation)
        return annotation

    @server.tool(description="Summarise captured sites and their flow counts.")
    async def list_sites() -> dict[str, Any]:
        sites = await asyncio.to_thread(store.distinct_sites)
        return {"sites": sites}

    @server.tool(
        description="Group captured flows into endpoint templates with parameters."
    )
    async def list_endpoints(
        host: str | None = None, limit: int = 200, offset: int = 0,
    ) -> dict[str, Any]:
        page = await asyncio.to_thread(
            store.page_endpoints, host=host, limit=max(1, min(limit, 500)),
            offset=max(0, offset),
        )
        return {"endpoints": page["items"], "count": page["count"]}

    @server.tool(description="Show the current scope rules.")
    async def get_scope() -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        return engine.scope.scope.as_dict()

    @server.tool(description="Add an include or exclude scope rule from a URL.")
    async def add_scope_rule(url: str, kind: str = "include") -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        from ..addons.scope import rule_from_url

        try:
            template = rule_from_url(url, kind=kind)  # type: ignore[arg-type]
            fields = template.as_dict()
            fields.pop("id", None)
            rule = await asyncio.to_thread(lambda: engine.scope.add_rule(**fields))
        except ScopeError as exc:
            return {"error": str(exc)}
        return rule.as_dict()

    @server.tool(description="List requests currently held at a breakpoint.")
    async def list_intercepted() -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        paused = engine.intercept.list_paused()
        for item in paused:
            item["request_headers"] = redact_headers(
                [(k, v) for k, v in item.get("request_headers", [])]
            )
        return {"paused": paused, "rules": engine.intercept.rules.as_dict()}

    @server.tool(description="Turn request/response interception on or off.")
    async def set_intercept(
        enabled: bool,
        intercept_requests: bool | None = None,
        intercept_responses: bool | None = None,
        host_filter: str | None = None,
    ) -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        rules = engine.intercept.set_rules(
            enabled=enabled,
            intercept_requests=intercept_requests,
            intercept_responses=intercept_responses,
            host_filter=host_filter,
        )
        return rules.as_dict()

    @server.tool(
        description=(
            "Forward a paused flow, optionally editing method, path, headers "
            "or body first."
        )
    )
    async def forward_intercepted(
        flow_id: str,
        method: str | None = None,
        path: str | None = None,
        request_body: str | None = None,
        request_headers: list[list[str]] | None = None,
    ) -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        edits: dict[str, Any] = {}
        if method is not None:
            edits["method"] = method
        if path is not None:
            edits["path"] = path
        if request_body is not None:
            edits["request_body"] = request_body
        if request_headers is not None:
            edits["request_headers"] = request_headers
        try:
            engine.intercept.forward(flow_id, edits)
        except InterceptError as exc:
            return {"error": str(exc)}
        return {"ok": True, "forwarded": flow_id}

    @server.tool(description="Drop a paused flow so it never reaches the server.")
    async def drop_intercepted(flow_id: str) -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        try:
            engine.intercept.drop(flow_id)
        except InterceptError as exc:
            return {"error": str(exc)}
        return {"ok": True, "dropped": flow_id}

    @server.tool(
        description=(
            "Send a request through the proxy engine (Replay). Returns the "
            "response with redacted headers unless reveal_secrets is true."
        )
    )
    async def send_request(
        url: str,
        method: str = "GET",
        headers: list[list[str]] | None = None,
        body: str = "",
        reveal_secrets: bool = False,
    ) -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        try:
            flow = build_flow(
                url=url, method=method, headers=headers or [], body=body
            )
            record = await engine.replay.send(flow)
        except ReplayError as exc:
            return {"error": str(exc)}
        return flow_detail(record, reveal=reveal_secrets)

    @server.tool(
        description="Replay a previously captured flow by id, optionally editing it."
    )
    async def replay_flow(
        flow_id: str,
        method: str | None = None,
        body: str | None = None,
        reveal_secrets: bool = False,
    ) -> dict[str, Any]:
        if engine is None:
            return {"error": "engine not available"}
        record = await asyncio.to_thread(store.get, flow_id)
        if record is None:
            return {"error": f"flow {flow_id} not found"}
        url = (
            f"{record.scheme}://{record.host}"
            f"{'' if record.port in (80, 443, None) else f':{record.port}'}"
            f"{record.path or '/'}"
            + (f"?{record.query}" if record.query else "")
        )
        try:
            flow = build_flow(
                url=url,
                method=method or record.method or "GET",
                headers=[[k, v] for k, v in record.request_headers],
                body=body
                if body is not None
                else (record.request_body or b"").decode("utf-8", errors="replace"),
            )
            replayed = await engine.replay.send(flow)
        except ReplayError as exc:
            return {"error": str(exc)}
        return flow_detail(replayed, reveal=reveal_secrets)

    @server.tool(description="Decode or encode a value (base64, url, hex, jwt, ...).")
    async def decode_value(
        value: str, codec: str = "base64", direction: str = "decode"
    ) -> dict[str, Any]:
        from ..addons.codecs import CodecError, transform

        try:
            return {"output": transform(value, codec, direction)}  # type: ignore[arg-type]
        except CodecError as exc:
            return {"error": str(exc)}

    return server


# Tools that change something: traffic sent, scope edited, a held request
# released. Worth naming so the UI can say what an agent could do, rather
# than presenting thirteen names as if they were all harmless lookups.
WRITING_TOOLS = frozenset(
    {
        "add_scope_rule",
        "bookmark_flow",
        "drop_intercepted",
        "forward_intercepted",
        "replay_flow",
        "send_request",
        "set_intercept",
    }
)


def describe_tools(server: Any) -> list[dict[str, Any]]:
    """Name and description of every tool this server exposes.

    Read from the server rather than written out again, so the Settings
    list cannot drift from what an agent actually gets.
    """
    manager = getattr(server, "_tool_manager", None)
    tools: list[Any] = getattr(manager, "list_tools", lambda: [])() if manager else []
    described: list[dict[str, Any]] = [
        {
            "name": getattr(tool, "name", ""),
            "description": (getattr(tool, "description", "") or "").strip(),
            "writes": getattr(tool, "name", "") in WRITING_TOOLS,
        }
        for tool in tools
    ]
    return sorted(described, key=lambda entry: entry["name"])


def transport_security() -> Any:
    """DNS-rebinding protection that allows any localhost port.

    The engine's API port is configurable, so the default (which pins MCP's
    own port) would reject valid local requests. We stay loopback-only
    (codex.md §10).
    """
    from mcp.server.transport_security import TransportSecuritySettings

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*"],
        allowed_origins=[
            "http://127.0.0.1",
            "http://127.0.0.1:*",
            "http://localhost",
            "http://localhost:*",
        ],
    )
