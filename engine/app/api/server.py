"""FastAPI application: REST routes + WebSocket flow stream."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect

from .. import __version__
from ..config import Settings
from ..db.store import FlowStore
from ..events import EventBroker
from ..proxy import ProxyEngine

logger = logging.getLogger(__name__)

SENSITIVE_HEADERS = {"authorization", "cookie", "set-cookie", "proxy-authorization"}


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
