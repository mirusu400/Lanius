"""FastAPI application: REST routes + WebSocket flow stream."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
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
from ..addons.intruder import (
    DEFAULT_CONCURRENCY,
    AttackSpeed,
    IntruderError,
    find_positions,
    strip_markers,
)
from ..db.payloads import PayloadSetError, parse_payloads
from .. import wordlists
from ..addons.plugins import PluginError
from .. import codegen
from ..build_info import build_info
from ..addons.scope import ScopeError, rule_from_url
from .. import browser
from ..config import Settings
from ..db.store import FlowStore
from ..events import EventBroker
from ..processes import list_processes
from ..proxy import ProxyEngine, ProxyStartError, local_capture_state

logger = logging.getLogger(__name__)

# One definition of what counts as a secret, shared with the MCP server
# and the code generators. There were three lists, and the shortest of
# them left a real x-goog-api-key on screen.
SENSITIVE_HEADERS = codegen.SECRET_HEADERS


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


class CodegenBody(BaseModel):
    """A request to render as code.

    Either a stored flow (flow_id) or one being edited in Repeater or
    Intruder, which has no id yet.
    """

    kind: str
    flow_id: str | None = None
    url: str = ""
    method: str = "GET"
    headers: list[list[str]] = []
    body: str = ""


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
    #: Ids of saved sets, used for any position a literal list does not
    #: cover. Saves posting a 30,000 line wordlist with every attack.
    payload_set_ids: list[str] = []
    concurrency: int | None = None
    delay: float | None = None


class PayloadSetBody(BaseModel):
    name: str
    #: One payload per line, which is the shape a wordlist already has.
    payloads: str
    source: str | None = None


class PayloadSetRename(BaseModel):
    name: str


class WordlistImportBody(BaseModel):
    list_id: str
    #: Defaults to the wordlist's own name when not given.
    name: str | None = None


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
        (k, "<redacted>" if codegen.is_secret_header(k) else v) for k, v in headers
    ]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.ensure_dirs()
    store = FlowStore(settings.db_path)

    # Notable (non per-flow) events are persisted for the Logger tab.
    LOGGED_EVENTS = (
        "engine.",
        "intercept.rules",
        "scope.changed",
        "plugins.changed",
        "intruder.started",
        "intruder.finished",
        "flows.cleared",
    )

    def _log_event(event_type: str, data: Any) -> None:
        if not event_type.startswith(LOGGED_EVENTS):
            return
        try:
            store.log_event(time.time(), "info", f"{event_type} {data}"[:2000])
        except Exception:  # pragma: no cover - logging must never break
            logger.exception("failed to log event %s", event_type)

    broker = EventBroker(on_publish=_log_event)
    engine = ProxyEngine(settings, store, broker)

    # Built below, then started by the lifespan (its session manager needs a
    # running task group before it can serve requests).
    mcp_app: Any | None = None

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # A proxy that cannot bind must not take the API down with it.
        # Otherwise a port already held by another tool leaves the user with
        # a dead window and no way to change the port from inside the app.
        try:
            await engine.start()
        except ProxyStartError as exc:
            engine.start_error = str(exc)
            logger.error("proxy did not start: %s", exc)
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

        @app.middleware("http")
        async def refuse_mcp_when_disabled(request: Any, call_next: Any) -> Any:
            """Honour the off switch without rebuilding the app.

            Turning MCP off has to actually stop agents reaching it, not
            just grey out a checkbox, so the request is refused here.
            """
            if request.url.path.startswith("/mcp") and (
                store.get_setting("mcp_enabled") == "0"
            ):
                return JSONResponse(
                    {"detail": "MCP is turned off in Settings"}, status_code=403
                )
            return await call_next(request)
    except Exception:  # pragma: no cover - MCP is optional
        logger.warning("MCP server unavailable", exc_info=True)
        app.state.mcp = None
    # Two callers, both local. The dev UI (vite) is served over http on a
    # localhost port. The desktop window is not: its documents come from the
    # bundle, so the webview sends "tauri://localhost" on macOS and Linux and
    # "http://tauri.localhost" on Windows. Keep the https form too for custom
    # protocol configurations. Without those the shipped app
    # gets a 200 the webview then refuses to hand over, which surfaces as
    # "Load failed" with nothing wrong on the server.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=(
            r"(http://(127\.0\.0\.1|localhost)(:\d+)?"
            r"|tauri://localhost"
            r"|https?://tauri\.localhost)"
        ),
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
                # Why it is not running, when that is known.
                "error": engine.start_error,
            },
            "flows": await asyncio.to_thread(store.count),
            "subscribers": broker.subscriber_count,
            "db_path": str(settings.db_path),
            "intercept": engine.intercept.rules.as_dict(),
            "paused": len(engine.intercept.paused),
            # Per-mode state: a mode can fail while the engine stays up.
            "modes": engine.mode_status(),
            "local_capture": {
                **local_capture_state(),
                "spec": engine.local_capture_spec(),
            },
        }

    @app.get("/api/dashboard")
    async def dashboard(
        top: int = Query(8, ge=1, le=50),
        window: float = Query(300.0, gt=0),
    ) -> dict[str, Any]:
        """Everything the Dashboard tab needs, in one round trip."""
        data = await asyncio.to_thread(store.dashboard, top, window)
        return {
            **data,
            "proxy": {
                "running": engine.running,
                "host": settings.proxy_host,
                "port": settings.proxy_port,
            },
            "intercept_enabled": engine.intercept.rules.enabled,
            "paused": len(engine.intercept.paused),
            "version": __version__,
            # A mode can be down, or local capture can be waiting for
            # approval, while the engine itself looks healthy. The
            # dashboard is where a user would notice.
            "modes": engine.mode_status(),
            "local_capture": {
                **local_capture_state(),
                "spec": engine.local_capture_spec(),
            },
        }

    # --- workspace: what you were working on ------------------------------

    @app.get("/api/workspace/{key}")
    async def get_workspace(key: str) -> dict[str, Any]:
        """Saved state for one part of the UI, e.g. the Repeater tabs."""
        return {"key": key, "value": await asyncio.to_thread(store.get_workspace, key)}

    @app.put("/api/workspace/{key}")
    async def put_workspace(key: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Autosave. The UI writes here as you work, so closing Lanius does
        not throw away the requests you had open."""
        if "value" not in payload:
            raise HTTPException(status_code=422, detail="payload needs a value")
        await asyncio.to_thread(store.set_workspace, key, payload["value"])
        return {"ok": True, "key": key}

    # --- project export and import ----------------------------------------

    @app.get("/api/project/export")
    async def export_project(include_flows: bool = True) -> dict[str, Any]:
        """The whole project as one document.

        Flows are optional because a long capture dwarfs everything else,
        and sharing a scope and a set of Repeater requests is the common
        case.
        """
        data: dict[str, Any] = {
            "format": "lanius-project",
            "version": 1,
            "exported_at": time.time(),
            "engine_version": __version__,
            "scope": await asyncio.to_thread(store.list_scope_rules),
            "workspace": await asyncio.to_thread(store.all_workspace),
            "settings": await asyncio.to_thread(store.all_settings),
        }
        if include_flows:
            flows = await asyncio.to_thread(lambda: store.list(limit=100000))
            data["flows"] = [flow.detail() for flow in flows]
        return data

    @app.post("/api/project/import")
    async def import_project(payload: dict[str, Any]) -> dict[str, Any]:
        """Load a project document, replacing what is currently open."""
        if payload.get("format") != "lanius-project":
            raise HTTPException(status_code=422, detail="not a Lanius project")
        version = payload.get("version")
        if version != 1:
            raise HTTPException(
                status_code=422, detail=f"unsupported project version: {version!r}"
            )
        counts = await asyncio.to_thread(store.import_project, payload)
        # The scope lives in memory once loaded, so without this the
        # imported rules sit in the database and affect nothing.
        scope = await asyncio.to_thread(engine.scope.reload)
        broker.publish("scope.changed", scope.as_dict())
        broker.publish("project.imported", counts)
        return {"ok": True, **counts}

    @app.get("/api/processes")
    async def processes(visible_only: bool = True) -> dict[str, Any]:
        """Running executables, so capture rules can be picked not typed."""
        items = await asyncio.to_thread(list_processes, visible_only)
        return {"items": items, "count": len(items)}

    @app.post("/api/capture/local")
    async def set_local_capture(payload: dict[str, Any]) -> dict[str, Any]:
        """Turn OS-level capture on or off.

        ``spec`` is a mitmproxy intercept spec: omit it or send an empty
        string to switch capture off, "curl" to target one process,
        "!Slack" to exclude one.
        """
        spec = payload.get("spec")
        # Absent or null switches capture off; "" captures every process.
        if spec is not None and not isinstance(spec, str):
            raise HTTPException(status_code=422, detail="spec must be a string")
        try:
            return await engine.set_local_capture(spec)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/tls")
    async def tls_state() -> dict[str, Any]:
        return engine.tls_state()

    @app.post("/api/tls")
    async def set_tls(payload: dict[str, Any]) -> dict[str, Any]:
        """Change the TLS profile used towards the server.

        ``profile`` selects a preset; ``ciphers`` optionally overrides its
        cipher list with an OpenSSL cipher string.
        """
        profile = payload.get("profile")
        if not isinstance(profile, str):
            raise HTTPException(status_code=422, detail="profile must be a string")
        ciphers = payload.get("ciphers")
        if ciphers is not None and not isinstance(ciphers, str):
            raise HTTPException(status_code=422, detail="ciphers must be a string")
        try:
            return await engine.set_tls_profile(profile, ciphers)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/browser")
    async def browser_state() -> dict[str, Any]:
        return browser.state(settings.data_dir, settings.confdir)

    @app.post("/api/browser")
    async def open_browser(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Open a browser already pointed at this proxy.

        Saves configuring a browser and installing the CA by hand, and
        leaves the user's own browser alone.
        """
        url = (payload or {}).get("url")
        if url is not None and not isinstance(url, str):
            raise HTTPException(status_code=422, detail="url must be a string")
        try:
            return await asyncio.to_thread(
                browser.launch,
                proxy_host=settings.proxy_host,
                proxy_port=settings.proxy_port,
                data_dir=settings.data_dir,
                confdir=settings.confdir,
                url=url,
            )
        except browser.BrowserError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/codegen/csrf/open")
    async def open_csrf_poc(payload: CodegenBody) -> dict[str, Any]:
        """Write the CSRF page to disk and open it in the proxied browser.

        A proof of concept is only convincing when it is watched: served
        from a file, through the proxy, the forged request shows up in the
        history next to the real one. Copying the HTML leaves the user to
        do that by hand.
        """
        spec = await _spec_from(payload)
        html = codegen.as_csrf_html(spec)
        if "<form" not in html:
            # It explained why not; sending the user to a blank page would
            # look like the tool failing rather than the request being
            # unforgeable.
            raise HTTPException(
                status_code=409,
                detail="this request cannot be forged with a cross-site form",
            )
        target = settings.data_dir / "csrf-poc.html"
        await asyncio.to_thread(target.write_text, html, encoding="utf-8")
        try:
            result = await asyncio.to_thread(
                browser.launch,
                proxy_host=settings.proxy_host,
                proxy_port=settings.proxy_port,
                data_dir=settings.data_dir,
                confdir=settings.confdir,
                url=target.as_uri(),
            )
        except browser.BrowserError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {**result, "path": str(target)}

    @app.delete("/api/browser/profile")
    async def clear_browser_profile() -> dict[str, Any]:
        """Throw away the browser profile: cookies, logins and history."""
        try:
            removed = await asyncio.to_thread(browser.clear_profile, settings.data_dir)
        except browser.BrowserError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"cleared": removed}

    MCP_ENABLED_SETTING = "mcp_enabled"

    def mcp_enabled() -> bool:
        # On unless explicitly turned off, which is how it has always
        # behaved; the setting only exists so it can be turned off.
        return store.get_setting(MCP_ENABLED_SETTING) != "0"

    def mcp_state() -> dict[str, Any]:
        server = getattr(app.state, "mcp", None)
        tools: list[dict[str, Any]] = []
        if server is not None:
            try:
                from ..mcp import describe_tools

                tools = describe_tools(server)
            except Exception:  # pragma: no cover - depends on the mcp package
                logger.debug("could not list MCP tools", exc_info=True)
        return {
            "available": server is not None,
            "enabled": mcp_enabled(),
            # What a client connects to. The mount is at /mcp and the
            # transport adds its own /mcp beneath it, so the path a client
            # needs really is doubled; giving out /mcp alone fails to
            # connect. Local-only, like the rest of the API.
            "url": f"http://{settings.api_host}:{settings.api_port}/mcp/mcp",
            "host": settings.api_host,
            "port": settings.api_port,
            "tools": tools,
        }

    @app.get("/api/mcp")
    async def mcp_status() -> dict[str, Any]:
        return mcp_state()

    @app.post("/api/mcp")
    async def set_mcp(payload: dict[str, Any]) -> dict[str, Any]:
        """Turn the MCP server on or off.

        The mount stays in place either way; requests are refused while it
        is off, which avoids rebuilding the app to change one setting.
        """
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            raise HTTPException(status_code=422, detail="enabled must be true or false")
        store.set_setting(MCP_ENABLED_SETTING, "1" if enabled else "0")
        broker.publish("mcp.toggled", {"enabled": enabled})
        return mcp_state()

    @app.get("/api/listener")
    async def listener() -> dict[str, Any]:
        return engine.listener_state()

    @app.post("/api/listener")
    async def set_listener(payload: dict[str, Any]) -> dict[str, Any]:
        """Move the proxy to a different address or port.

        Needed when another tool already holds the port, and to expose the
        proxy to other machines by binding beyond loopback.
        """
        host = payload.get("host", settings.proxy_host)
        if not isinstance(host, str):
            raise HTTPException(status_code=422, detail="host must be a string")
        port = payload.get("port", settings.proxy_port)
        if isinstance(port, str) and port.isdigit():
            port = int(port)
        if not isinstance(port, int) or isinstance(port, bool):
            raise HTTPException(status_code=422, detail="port must be a number")
        try:
            return await engine.set_listener(host, port)
        except ProxyStartError as exc:
            # The old listener has been restored, so this is a rejection of
            # the new address rather than an outage.
            raise HTTPException(status_code=409, detail=str(exc)) from exc

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

    @app.get("/api/about")
    async def about() -> dict[str, Any]:
        """What build this is, for a bug report.

        Every nightly this month reports version 0.1.0, so the version
        alone does not say which build someone is running.
        """
        return build_info()

    @app.get("/api/codegen/formats")
    async def codegen_formats() -> dict[str, Any]:
        """What the copy-as menus should offer, plugins included."""
        return {"formats": codegen.available_formats()}

    @app.post("/api/codegen")
    async def render_code(payload: CodegenBody) -> dict[str, Any]:
        """Render a request as curl, fetch, Python, or a CSRF PoC.

        Done here rather than in the UI so that plugins can add formats
        and so the rules about what counts as a secret live in one place.
        """
        spec = await _spec_from(payload)
        try:
            text = codegen.generate(payload.kind, spec)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"kind": payload.kind, "text": text}

    async def _spec_from(payload: CodegenBody) -> codegen.RequestSpec:
        """The request to render, whether stored or still being edited."""
        if payload.flow_id:
            record = await asyncio.to_thread(store.get, payload.flow_id)
            if record is None:
                raise HTTPException(status_code=404, detail="flow not found")
            detail = record.detail()
            spec = codegen.RequestSpec(
                method=detail.get("method") or "GET",
                # A record stores the parts, not the URL, so it is rebuilt
                # here. Passing detail["url"] gave an empty string and a
                # curl command that requested nothing at all.
                url=codegen.rebuild_url(
                    scheme=detail.get("scheme"),
                    host=detail.get("host"),
                    port=detail.get("port"),
                    path=detail.get("path"),
                    query=detail.get("query"),
                ),
                headers=[(k, v) for k, v in (record.request_headers or [])],
                body=detail.get("request_body") or "",
            )
        else:
            if not payload.url:
                raise HTTPException(
                    status_code=400, detail="url or flow_id is required"
                )
            spec = codegen.RequestSpec(
                method=payload.method,
                url=payload.url,
                headers=[(h[0], h[1]) for h in payload.headers if len(h) >= 2],
                body=payload.body,
            )
        return spec

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
    async def sitemap(
        in_scope_only: bool = False, with_paths: bool = False
    ) -> dict[str, Any]:
        """The site map, optionally with each site's paths included.

        with_paths exists because the tree needs them for every host it
        draws. Fetching them per host meant one request and one query per
        host, so opening Target on a real capture took seconds and got
        worse with every new host.
        """
        sites = await asyncio.to_thread(store.distinct_sites)
        by_site = await asyncio.to_thread(store.paths_by_site)
        items = []
        for site in sites:
            key = (site["scheme"], site["host"], site["port"])
            rows = by_site.get(key, [])
            # A site counts as in scope when any of its recorded paths is, so a
            # rule like /users/* still marks the host as a target.
            paths = {row["path"] for row in rows if row.get("path")}
            inside = any(
                engine.scope.contains(site["scheme"], site["host"], site["port"], p)
                for p in (paths or {"/"})
            )
            if in_scope_only and not inside:
                continue
            item = {**site, "in_scope": inside}
            if with_paths:
                # Not "paths": that key is already the count of them.
                item["path_items"] = rows
            items.append(item)
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

    def _resolve_payload_sets(body: AttackBody) -> list[list[str]]:
        """Literal lists first, then any saved sets named by id.

        Both are allowed so a quick one-off attack does not need a saved
        set, and a real wordlist does not need to be posted every time.
        """
        sets = [list(entry) for entry in body.payload_sets]
        for set_id in body.payload_set_ids:
            found = store.payload_sets.get(set_id)
            if found is None:
                raise HTTPException(
                    status_code=404, detail=f"payload set not found: {set_id}"
                )
            sets.append(found.payloads)
        return sets

    def _speed(body: AttackBody) -> AttackSpeed:
        try:
            return AttackSpeed(
                concurrency=(
                    body.concurrency
                    if body.concurrency is not None
                    else DEFAULT_CONCURRENCY
                ),
                delay=body.delay or 0.0,
            )
        except IntruderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/intruder/attacks")
    async def intruder_start(body: AttackBody) -> dict[str, Any]:
        try:
            attack = await engine.intruder.start(
                url=body.url,
                template=body.template,
                attack_type=body.attack_type,  # type: ignore[arg-type]
                payload_sets=_resolve_payload_sets(body),
                speed=_speed(body),
            )
        except IntruderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return attack.summary()

    # --- payload sets -----------------------------------------------------
    @app.get("/api/payload-sets")
    async def payload_sets_list() -> dict[str, Any]:
        """Names and sizes only: a picker does not need 30,000 entries."""
        items = await asyncio.to_thread(store.payload_sets.list)
        return {"items": [s.summary() for s in items]}

    @app.get("/api/payload-sets/{set_id}")
    async def payload_set_get(set_id: str) -> dict[str, Any]:
        found = await asyncio.to_thread(store.payload_sets.get, set_id)
        if found is None:
            raise HTTPException(status_code=404, detail="payload set not found")
        return found.as_dict()

    @app.post("/api/payload-sets")
    async def payload_set_save(body: PayloadSetBody) -> dict[str, Any]:
        try:
            saved = await asyncio.to_thread(
                lambda: store.payload_sets.save(
                    name=body.name,
                    payloads=parse_payloads(body.payloads),
                    source=body.source,
                )
            )
        except PayloadSetError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return saved.summary()

    @app.patch("/api/payload-sets/{set_id}")
    async def payload_set_rename(set_id: str, body: PayloadSetRename) -> dict[str, Any]:
        try:
            renamed = await asyncio.to_thread(
                store.payload_sets.rename, set_id, body.name
            )
        except PayloadSetError as exc:
            status = 404 if "not found" in str(exc) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        return renamed.summary()

    @app.delete("/api/payload-sets/{set_id}")
    async def payload_set_delete(set_id: str) -> dict[str, Any]:
        removed = await asyncio.to_thread(store.payload_sets.delete, set_id)
        if not removed:
            raise HTTPException(status_code=404, detail="payload set not found")
        return {"ok": True}

    # --- wordlists --------------------------------------------------------
    @app.get("/api/wordlists")
    async def wordlists_catalogue() -> dict[str, Any]:
        """What can be fetched. A fixed list, not a directory listing."""
        return {"items": wordlists.catalogue(), "ref": wordlists.SECLISTS_REF}

    @app.post("/api/wordlists/import")
    async def wordlist_import(body: WordlistImportBody) -> dict[str, Any]:
        """Fetch a wordlist and keep it as a payload set.

        Nothing is fetched until this is called: a proxy that reaches out
        on its own is not one to trust.
        """
        try:
            entry, payloads = await wordlists.fetch(body.list_id)
        except wordlists.WordlistError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        try:
            saved = await asyncio.to_thread(
                lambda: store.payload_sets.save(
                    name=body.name or entry.name,
                    payloads=payloads,
                    source=entry.url,
                )
            )
        except PayloadSetError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return saved.summary()

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

    # --- CA certificate / settings ----------------------------------------
    # Only the public CA certificate is exposed; the private key never is
    # (codex.md §10).
    CA_FILES = {
        "pem": "mitmproxy-ca-cert.pem",
        "cer": "mitmproxy-ca-cert.cer",
        "p12": "mitmproxy-ca-cert.p12",
    }

    @app.get("/api/ca")
    async def ca_info() -> dict[str, Any]:
        available = {
            fmt: (settings.confdir / filename).exists()
            for fmt, filename in CA_FILES.items()
        }
        return {
            "confdir": str(settings.confdir),
            "available": available,
            "install_url": "http://mitm.it",
            "proxy": f"{settings.proxy_host}:{settings.proxy_port}",
        }

    @app.get("/api/ca/{fmt}")
    async def ca_download(fmt: str) -> FileResponse:
        filename = CA_FILES.get(fmt)
        if filename is None:
            raise HTTPException(status_code=404, detail=f"unknown format {fmt!r}")
        path = settings.confdir / filename
        if not path.exists():
            raise HTTPException(
                status_code=404,
                detail="CA not generated yet; start the proxy once",
            )
        return FileResponse(
            path, filename=filename, media_type="application/octet-stream"
        )

    # --- events / logger --------------------------------------------------
    @app.get("/api/events")
    async def list_events(limit: int = Query(200, ge=1, le=2000)) -> dict[str, Any]:
        rows = await asyncio.to_thread(store.list_events, limit)
        return {"items": rows, "count": len(rows)}

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
