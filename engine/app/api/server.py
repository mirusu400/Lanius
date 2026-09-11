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

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await engine.start()
        try:
            yield
        finally:
            await engine.stop()
            store.close()

    app = FastAPI(title="Lanius Engine", version=__version__, lifespan=lifespan)
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
