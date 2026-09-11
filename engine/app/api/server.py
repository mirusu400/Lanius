"""FastAPI application: REST routes + WebSocket flow stream."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .. import __version__
from ..addons.intercept import InterceptError
from ..addons.repeater import RepeaterError, build_flow, render_raw
from ..addons.endpoints import build_endpoints
from ..addons.codecs import (
    ChainStep,
    CodecError,
    available_codecs,
    compare,
    run_chain,
)
from ..addons.intruder import IntruderError, find_positions, strip_markers
from ..addons.plugins import PluginError
from ..addons.scope import ScopeError, rule_from_url
from ..config import Settings
from ..db.store import FlowStore
from ..events import EventBroker
from ..proxy import ProxyEngine

logger = logging.getLogger(__name__)

SENSITIVE_HEADERS = {"authorization", "cookie", "set-cookie", "proxy-authorization"}


class InterceptRulesPatch(BaseModel):
    enabled: bool | None = None
    intercept_requests: bool | None = None
    intercept_responses: bool | None = None
    host_filter: str | None = None


class ForwardBody(BaseModel):
    method: str | None = None
    path: str | None = None
    host: str | None = None
    port: int | None = None
    request_headers: list[list[str]] | None = None
    request_body: str | None = None
    status_code: int | None = None
    reason: str | None = None
    response_headers: list[list[str]] | None = None
    response_body: str | None = None


class RepeaterRequest(BaseModel):
    url: str
    method: str = "GET"
    headers: list[list[str]] = []
    body: str = ""
    http_version: str = "HTTP/1.1"
    timeout: float = 30.0


class ScopeRuleBody(BaseModel):
    kind: str = "include"
    host: str = "*"
    path: str = "*"
    protocol: str = "any"
    port: int | None = None
    match_type: str = "glob"
    enabled: bool = True


class ScopeRulePatch(BaseModel):
    kind: str | None = None
    host: str | None = None
    path: str | None = None
    protocol: str | None = None
    port: int | None = None
    match_type: str | None = None
    enabled: bool | None = None


class ScopeFromUrl(BaseModel):
    url: str
    kind: str = "include"
    prefix: bool = True


class CaptureRestriction(BaseModel):
    restrict_capture: bool


class AttackBody(BaseModel):
    url: str
    template: str
    attack_type: str = "sniper"
    payload_sets: list[list[str]] = []


class PositionsBody(BaseModel):
    template: str


class ChainStepBody(BaseModel):
    codec: str
    direction: str = "decode"


class DecodeBody(BaseModel):
    value: str
    steps: list[ChainStepBody] = []


class CompareBody(BaseModel):
    left: str
    right: str
    mode: str = "word"


def redact_headers(
    headers: list[tuple[str, str]] | None, *, reveal: bool = False
) -> list[tuple[str, str]] | None:
    """Redact sensitive header values unless explicitly opted in (codex.md §10)."""
    if headers is None:
        return None
    if reveal:
        return headers
    return [
        (k, "<redacted>" if k.lower() in SENSITIVE_HEADERS else v) for k, v in headers
    ]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.ensure_dirs()
    store = FlowStore(settings.db_path)
    broker = EventBroker()
    engine = ProxyEngine(settings, store, broker)

    # Built below, then started by the lifespan (its session manager needs a
    # running task group before it can serve requests).
    mcp_app: Any | None = None

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await engine.start()
        async with contextlib.AsyncExitStack() as stack:
            if mcp_app is not None and hasattr(mcp_app, "router"):
                await stack.enter_async_context(mcp_app.router.lifespan_context(mcp_app))
            try:
                yield
            finally:
                await engine.stop()
                store.close()

    app = FastAPI(title="Lanius Engine", version=__version__, lifespan=lifespan)

    # MCP over streamable HTTP, on the same local-only port (codex.md §10).
    try:
        from ..mcp import build_server as build_mcp
        from ..mcp import transport_security

        mcp_server = build_mcp(store, engine)
        mcp_app = mcp_server.streamable_http_app(
            transport_security=transport_security()
        )
        app.mount("/mcp", mcp_app)
        app.state.mcp = mcp_server
    except Exception:  # pragma: no cover - MCP is optional
        logger.warning("MCP server unavailable", exc_info=True)
        app.state.mcp = None
    # Local dev UI (vite) runs on a different port; stay localhost-only.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(127\.0\.0\.1|localhost)(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.store = store
    app.state.broker = broker
    app.state.engine = engine

    @app.get("/api/status")
    async def status() -> dict[str, Any]:
        return {
            "version": __version__,
            "proxy": {
                "running": engine.running,
                "host": settings.proxy_host,
                "port": settings.proxy_port,
            },
            "flows": await asyncio.to_thread(store.count),
            "subscribers": broker.subscriber_count,
            "db_path": str(settings.db_path),
            "intercept": engine.intercept.rules.as_dict(),
            "paused": len(engine.intercept.paused),
        }

    @app.get("/api/flows")
    async def list_flows(
        limit: int = Query(100, ge=1, le=1000),
        offset: int = Query(0, ge=0),
        host: str | None = None,
        method: str | None = None,
        status_code: int | None = None,
        search: str | None = None,
    ) -> dict[str, Any]:
        records = await asyncio.to_thread(
            store.list,
            limit=limit,
            offset=offset,
            host=host,
            method=method,
            status_code=status_code,
            search=search,
        )
        return {"items": [r.summary() for r in records], "count": len(records)}

    @app.get("/api/flows/{flow_id}")
    async def get_flow(flow_id: str, reveal: bool = False) -> dict[str, Any]:
        record = await asyncio.to_thread(store.get, flow_id)
        if record is None:
            raise HTTPException(status_code=404, detail="flow not found")
        data = record.detail()
        data["request_headers"] = redact_headers(
            record.request_headers, reveal=reveal
        )
        data["response_headers"] = redact_headers(
            record.response_headers, reveal=reveal
        )
        return data

    @app.delete("/api/flows")
    async def clear_flows() -> dict[str, Any]:
        await asyncio.to_thread(store.clear)
        broker.publish("flows.cleared", {})
        return {"ok": True}

    # --- intercept (M2) ---------------------------------------------------
    @app.get("/api/intercept")
    async def intercept_state() -> dict[str, Any]:
        return {
            "rules": engine.intercept.rules.as_dict(),
            "paused": engine.intercept.list_paused(),
        }

    @app.patch("/api/intercept")
    async def update_intercept(patch: InterceptRulesPatch) -> dict[str, Any]:
        rules = engine.intercept.set_rules(**patch.model_dump(exclude_unset=True))
        return rules.as_dict()

    @app.post("/api/intercept/{flow_id}/forward")
    async def forward_flow(flow_id: str, edits: ForwardBody | None = None) -> dict[str, Any]:
        payload = edits.model_dump(exclude_unset=True) if edits else {}
        try:
            engine.intercept.forward(flow_id, payload)
        except InterceptError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @app.post("/api/intercept/{flow_id}/drop")
    async def drop_flow(flow_id: str) -> dict[str, Any]:
        try:
            engine.intercept.drop(flow_id)
        except InterceptError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @app.post("/api/intercept/forward-all")
    async def forward_all() -> dict[str, Any]:
        return {"forwarded": engine.intercept.resume_all()}

    # --- repeater (M3) ----------------------------------------------------
    @app.post("/api/repeater/send")
    async def repeater_send(req: RepeaterRequest) -> dict[str, Any]:
        try:
            flow = build_flow(
                url=req.url,
                method=req.method,
                headers=[list(h) for h in req.headers],
                body=req.body,
                http_version=req.http_version,
            )
            record = await engine.repeater.send(flow, timeout=req.timeout)
        except RepeaterError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return render_raw(record)

    # --- scope / target (M4) ----------------------------------------------
    @app.get("/api/scope")
    async def get_scope() -> dict[str, Any]:
        return engine.scope.scope.as_dict()

    @app.post("/api/scope/rules")
    async def add_scope_rule(body: ScopeRuleBody) -> dict[str, Any]:
        try:
            rule = await asyncio.to_thread(
                lambda: engine.scope.add_rule(**body.model_dump())
            )
        except ScopeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return rule.as_dict()

    @app.post("/api/scope/from-url")
    async def add_scope_from_url(body: ScopeFromUrl) -> dict[str, Any]:
        try:
            template = rule_from_url(body.url, kind=body.kind, prefix=body.prefix)  # type: ignore[arg-type]
            fields = template.as_dict()
            fields.pop("id", None)
            rule = await asyncio.to_thread(lambda: engine.scope.add_rule(**fields))
        except ScopeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return rule.as_dict()

    @app.patch("/api/scope/rules/{rule_id}")
    async def patch_scope_rule(rule_id: int, patch: ScopeRulePatch) -> dict[str, Any]:
        changes = patch.model_dump(exclude_unset=True)
        try:
            scope = await asyncio.to_thread(
                lambda: engine.scope.update_rule(rule_id, **changes)
            )
        except ScopeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return scope.as_dict()

    @app.delete("/api/scope/rules/{rule_id}")
    async def delete_scope_rule(rule_id: int) -> dict[str, Any]:
        try:
            await asyncio.to_thread(lambda: engine.scope.delete_rule(rule_id))
        except ScopeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"ok": True}

    @app.patch("/api/scope")
    async def set_scope_capture(body: CaptureRestriction) -> dict[str, Any]:
        scope = await asyncio.to_thread(
            lambda: engine.scope.set_restrict_capture(body.restrict_capture)
        )
        return scope.as_dict()

    @app.get("/api/scope/check")
    async def check_scope(url: str) -> dict[str, Any]:
        try:
            return {"url": url, "in_scope": engine.scope.scope.contains_url(url)}
        except ScopeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/sitemap")
    async def sitemap(in_scope_only: bool = False) -> dict[str, Any]:
        sites = await asyncio.to_thread(store.distinct_sites)
        items = []
        for site in sites:
            # A site counts as in scope when any of its recorded paths is, so a
            # rule like /users/* still marks the host as a target.
            paths = await asyncio.to_thread(
                store.distinct_paths_for_site,
                site["scheme"],
                site["host"],
                site["port"],
            )
            inside = any(
                engine.scope.contains(site["scheme"], site["host"], site["port"], p)
                for p in (paths or ["/"])
            )
            if in_scope_only and not inside:
                continue
            items.append({**site, "in_scope": inside})
        return {"sites": items}

    @app.get("/api/sitemap/paths")
    async def sitemap_paths(
        host: str, scheme: str = "https", port: int | None = None
    ) -> dict[str, Any]:
        rows = await asyncio.to_thread(store.paths_for_site, scheme, host, port)
        return {"items": rows, "count": len(rows)}

    @app.get("/api/endpoints")
    async def endpoints(
        host: str | None = None,
        in_scope_only: bool = False,
        limit: int = Query(5000, ge=1, le=20000),
    ) -> dict[str, Any]:
        records = await asyncio.to_thread(store.list, limit=limit, host=host)
        if in_scope_only:
            records = [
                r
                for r in records
                if engine.scope.contains(r.scheme, r.host, r.port, r.path)
            ]
        grouped = build_endpoints(records)
        return {
            "items": [e.as_dict() for e in grouped],
            "count": len(grouped),
        }

    # --- intruder (M5) ----------------------------------------------------
    @app.post("/api/intruder/positions")
    async def intruder_positions(body: PositionsBody) -> dict[str, Any]:
        try:
            positions = find_positions(body.template)
            return {
                "positions": [
                    {"start": p.start, "end": p.end, "value": p.value}
                    for p in positions
                ],
                "count": len(positions),
                "preview": strip_markers(body.template),
            }
        except IntruderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/intruder/plan")
    async def intruder_plan(body: AttackBody) -> dict[str, Any]:
        try:
            total = engine.intruder.plan(
                attack_type=body.attack_type,  # type: ignore[arg-type]
                template=body.template,
                payload_sets=body.payload_sets,
            )
        except IntruderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"total": total}

    @app.post("/api/intruder/attacks")
    async def intruder_start(body: AttackBody) -> dict[str, Any]:
        try:
            attack = await engine.intruder.start(
                url=body.url,
                template=body.template,
                attack_type=body.attack_type,  # type: ignore[arg-type]
                payload_sets=body.payload_sets,
            )
        except IntruderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return attack.summary()

    @app.get("/api/intruder/attacks")
    async def intruder_list() -> dict[str, Any]:
        return {
            "items": [a.summary() for a in engine.intruder.attacks.values()],
        }

    @app.get("/api/intruder/attacks/{attack_id}")
    async def intruder_get(attack_id: str) -> dict[str, Any]:
        try:
            return engine.intruder.get(attack_id).as_dict()
        except IntruderError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/intruder/attacks/{attack_id}/stop")
    async def intruder_stop(attack_id: str) -> dict[str, Any]:
        try:
            return engine.intruder.stop(attack_id).summary()
        except IntruderError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # --- decoder / comparer (M6) ------------------------------------------
    @app.get("/api/codecs")
    async def list_codecs() -> dict[str, Any]:
        return available_codecs()

    @app.post("/api/decode")
    async def decode(body: DecodeBody) -> dict[str, Any]:
        steps = [
            ChainStep(codec=s.codec, direction=s.direction)  # type: ignore[arg-type]
            for s in body.steps
        ]
        try:
            outputs = run_chain(body.value, steps)
        except CodecError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "input": body.value,
            "steps": outputs,
            "output": outputs[-1]["value"] if outputs else body.value,
        }

    @app.post("/api/compare")
    async def compare_texts(body: CompareBody) -> dict[str, Any]:
        try:
            return compare(body.left, body.right, body.mode)  # type: ignore[arg-type]
        except CodecError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # --- plugins (M7) -----------------------------------------------------
    @app.get("/api/plugins")
    async def list_plugins() -> dict[str, Any]:
        await asyncio.to_thread(engine.plugins.discover)
        return {
            "items": engine.plugins.list(),
            "directory": str(settings.plugins_dir),
        }

    @app.post("/api/plugins/{name}/enable")
    async def enable_plugin(name: str) -> dict[str, Any]:
        try:
            return engine.plugins.enable(name).as_dict()
        except PluginError as exc:
            status = 404 if "not found" in str(exc) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.post("/api/plugins/{name}/disable")
    async def disable_plugin(name: str) -> dict[str, Any]:
        try:
            return engine.plugins.disable(name).as_dict()
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/plugins/{name}/reload")
    async def reload_plugin(name: str) -> dict[str, Any]:
        try:
            return engine.plugins.reload(name).as_dict()
        except PluginError as exc:
            status = 404 if "not found" in str(exc) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.websocket("/ws")
    async def ws_stream(websocket: WebSocket) -> None:
        await websocket.accept()
        async with broker.stream() as queue:
            await websocket.send_json({"type": "hello", "data": {"version": __version__}})
            try:
                while True:
                    event = await queue.get()
                    await websocket.send_json(event)
            except WebSocketDisconnect:
                pass
            except Exception:  # pragma: no cover - defensive
                logger.exception("websocket stream error")

    return app
