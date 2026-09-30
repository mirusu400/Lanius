"""FastAPI application: REST routes + WebSocket flow stream."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import sqlite3
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field

from .. import __version__
from ..addons.intercept import InterceptError
from ..addons.match_replace import MatchReplaceError, preview as preview_match_replace
from ..addons.replay import ReplayError, build_flow, render_raw
from ..addons.websocket_proxy import WebSocketProxyError
from ..addons.codecs import (
    ChainStep,
    CodecError,
    available_codecs,
    compare,
    run_chain,
)
from ..addons.fuzzer import (
    DEFAULT_CONCURRENCY,
    RunSpeed,
    FuzzerError,
    find_positions,
    strip_markers,
)
from ..db.payloads import PayloadSetError, parse_payloads
from .. import wordlists
from ..addons.plugins import PluginError
from ..addons.scanner import ScannerError, request_snapshot
from ..plugin_registry import PluginApiError
from ..plugin_packages import (
    MAX_ARCHIVE_BYTES,
    PluginPackageError,
    file_sha256,
    load_manifest,
)
from ..plugin_catalogue import PluginCatalogueError
from .. import codegen
from ..build_info import build_info
from ..lockdown import BLOCKED_DETAIL, LockdownBlocked, LockdownPolicy
from .. import updates
from ..addons.scope import ScopeError, rule_from_url
from .. import browser
from ..config import Settings
from ..content_encoding import AUTO_DECOMPRESS_SETTING, auto_decompress_enabled
from ..db.store import FlowStore
from ..events import EventBroker
from ..processes import list_processes
from ..proxy import ProxyEngine, ProxyStartError, local_capture_state
from ..preview import response_preview

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


class ReplayRequest(BaseModel):
    url: str
    method: str = "GET"
    headers: list[list[str]] = []
    body: str = ""
    http_version: str = "HTTP/1.1"
    timeout: float = 30.0


class MatchReplaceBody(BaseModel):
    rules: list[dict[str, Any]] = []


class MatchReplacePreviewBody(MatchReplaceBody):
    phase: str
    raw: str


class BodyDisplayPatch(BaseModel):
    auto_decompress: bool


class LockdownPatch(BaseModel):
    enabled: bool


class WebSocketRulesPatch(BaseModel):
    enabled: bool | None = None
    client_messages: bool | None = None
    server_messages: bool | None = None


class WebSocketForwardBody(BaseModel):
    content: str
    encoding: str = "utf-8"


class WebSocketRepeatBody(WebSocketForwardBody):
    connection_id: str
    to_client: bool = False
    is_text: bool = True


class CodegenBody(BaseModel):
    """A request to render as code.

    Either a stored flow (flow_id) or one being edited in Replay or
    Fuzzer, which has no id yet.
    """

    kind: str
    flow_id: str | None = None
    url: str = ""
    method: str = "GET"
    headers: list[list[str]] = []
    body: str = ""


class DeleteSubtree(BaseModel):
    host: str = Field(min_length=1)
    port: int | None = None
    port_is_null: bool = False
    scheme: str | None = None
    path_prefix: str | None = None


class DeleteFlowsBody(BaseModel):
    """What to remove from the history.

    Either a set of ids, or the subtree a site map folder stands for.
    Sending ids for a subtree would mean listing thousands of them to
    describe something the database can select itself.
    """

    ids: list[str] = Field(default_factory=list)
    subtrees: list[DeleteSubtree] = Field(default_factory=list)
    host: str | None = None
    port: int | None = None
    port_is_null: bool = False
    scheme: str | None = None
    path_prefix: str | None = None


class CompactSite(BaseModel):
    scheme: str | None
    host: str | None
    port: int | None
    flows: int = Field(gt=0)


class CompactProjectBody(BaseModel):
    sites: list[CompactSite] = Field(default_factory=list)


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
    regex: bool = False


class CaptureRestriction(BaseModel):
    restrict_capture: bool


class FuzzRunBody(BaseModel):
    url: str
    template: str
    mode: str = "single_position"
    payload_sets: list[list[str]] = []
    #: Ids of saved sets, used for any position a literal list does not
    #: cover. Saves posting a 30,000 line wordlist with every run.
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


class PluginSettingsPatch(BaseModel):
    values: dict[str, Any]


class PluginActionBody(BaseModel):
    context: dict[str, Any] = {}


class PluginPayloadGeneratorBody(BaseModel):
    options: dict[str, Any] = {}


class PluginPayloadProcessorBody(BaseModel):
    value: str
    context: dict[str, Any] = {}


class PluginDevelopmentInstall(BaseModel):
    path: str


class PluginCatalogueSourceBody(BaseModel):
    id: str
    title: str
    url: str
    public_key: str
    key_id: str | None = None
    enabled: bool = True


class PluginCatalogueSourcesBody(BaseModel):
    sources: list[PluginCatalogueSourceBody] = Field(default_factory=list)


class PluginCatalogueInstallBody(BaseModel):
    source: str
    plugin: str
    version: str | None = None
    enable: bool = True


class PluginRollbackBody(BaseModel):
    version: str | None = None


class IssueStatusPatch(BaseModel):
    status: str


class ActiveScanBody(BaseModel):
    check_ids: list[str] = []
    concurrency: int = 3
    requests_per_second: float = 5.0


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
    lockdown = LockdownPolicy.from_env(store)

    # Notable (non per-flow) events are persisted for the Logger tab.
    LOGGED_EVENTS = (
        "engine.",
        "intercept.rules",
        "scope.changed",
        "plugins.changed",
        "issues.",
        "scanner.",
        "fuzzer.started",
        "fuzzer.finished",
        "flows.cleared",
        "flows.deleted",
    )

    def _log_event(event_type: str, data: Any) -> None:
        if not event_type.startswith(LOGGED_EVENTS):
            return
        try:
            store.log_event(time.time(), "info", f"{event_type} {data}"[:2000])
        except Exception:  # pragma: no cover - logging must never break
            logger.exception("failed to log event %s", event_type)

    broker = EventBroker(on_publish=_log_event)
    engine = ProxyEngine(settings, store, broker, lockdown)

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

    @app.exception_handler(LockdownBlocked)
    async def lockdown_blocked(_request: Request, _error: LockdownBlocked) -> JSONResponse:
        return JSONResponse(status_code=423, content={"detail": BLOCKED_DETAIL})

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
    allowed_origins = (
        r"(http://(127\.0\.0\.1|localhost)(:\d+)?"
        r"|tauri://localhost"
        r"|https?://tauri\.localhost)"
    )
    allowed_origin = re.compile(allowed_origins)

    @app.middleware("http")
    async def refuse_cross_site_writes(request: Any, call_next: Any) -> Any:
        """Stop other sites driving the API from the user's browser.

        CORS only hides responses; a page can still fire a no-preflight
        POST (for example a plugin archive to /api/plugins/install). Browsers
        always send Origin on such requests, so any foreign one is refused.
        Local tools that send no Origin are unaffected.
        """
        origin = request.headers.get("origin")
        if (
            request.method not in {"GET", "HEAD", "OPTIONS"}
            and origin is not None
            and not allowed_origin.fullmatch(origin)
        ):
            return JSONResponse(
                {"detail": "cross-origin request refused"}, status_code=403
            )
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=allowed_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.store = store
    app.state.broker = broker
    app.state.engine = engine
    app.state.lockdown = lockdown

    async def _apply_lockdown_to_plugins(locked: bool) -> None:
        """Plugins are arbitrary Python, so they follow the mode both ways."""
        if locked:
            await engine.plugins.suspend_for_lockdown()
        else:
            await engine.plugins.resume_after_lockdown()

    @app.get("/api/lockdown")
    async def lockdown_status() -> dict[str, Any]:
        return lockdown.status()

    @app.put("/api/lockdown/project")
    async def set_project_lockdown(body: LockdownPatch) -> dict[str, Any]:
        was_scope_egress = lockdown.scope_egress_effective
        result = lockdown.set_project(body.enabled)
        await _apply_lockdown_to_plugins(result["effective"])
        if was_scope_egress != result["scope_egress_effective"]:
            await engine.restart_for_scope_egress()
        return result

    @app.put("/api/lockdown/scope-egress")
    async def set_scope_egress(body: LockdownPatch) -> dict[str, Any]:
        was_effective = lockdown.scope_egress_effective
        result = lockdown.set_scope_egress(body.enabled)
        if was_effective != result["scope_egress_effective"]:
            await engine.restart_for_scope_egress()
        return result

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
        """Saved state for one part of the UI, e.g. the Replay tabs."""
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
        and sharing a scope and a set of Replay requests is the common
        case.
        """
        if include_flows and await asyncio.to_thread(store.count) > 100_000:
            raise HTTPException(
                status_code=413,
                detail="JSON export is limited to 100,000 flows; use the complete SQLite backup",
            )
        data: dict[str, Any] = {
            "format": "lanius-project",
            "version": 1,
            "exported_at": time.time(),
            "engine_version": __version__,
            "scope": await asyncio.to_thread(store.list_scope_rules),
            "workspace": await asyncio.to_thread(store.all_workspace),
            "settings": await asyncio.to_thread(store.all_settings),
            "issues": await asyncio.to_thread(store.all_issues),
        }
        if include_flows:
            flows = await asyncio.to_thread(lambda: store.list(limit=100000))
            data["flows"] = [flow.detail() for flow in flows]
        return data

    @app.get("/api/project/backup")
    async def backup_project() -> FileResponse:
        path = await asyncio.to_thread(store.backup_database)
        return FileResponse(
            path, filename="lanius-project.sqlite",
            media_type="application/x-sqlite3",
            background=BackgroundTask(Path(path).unlink, missing_ok=True),
        )

    @app.post("/api/project/import")
    async def import_project(request: Request) -> dict[str, Any]:
        """Load a project document, replacing what is currently open."""
        try:
            payload = await asyncio.to_thread(json.loads, await request.body())
        except (ValueError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=422, detail="invalid project JSON") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="not a Lanius project")
        if payload.get("format") != "lanius-project":
            raise HTTPException(status_code=422, detail="not a Lanius project")
        version = payload.get("version")
        if version != 1:
            raise HTTPException(
                status_code=422, detail=f"unsupported project version: {version!r}"
            )
        was_locked = lockdown.project_enabled
        was_scope_egress = lockdown.scope_egress_effective
        counts = await asyncio.to_thread(store.import_project, payload)
        # Project exports carry this setting too. Apply an imported switch
        # before any pending product request can continue. A file can turn
        # Lockdown on but never off: only the user's own switch loosens it.
        imported = lockdown.reload()
        lockdown.set_project(was_locked or imported["project_enabled"])
        # The same rule applies to an effective scope guard: importing an
        # untrusted project may tighten it, but cannot silently open egress.
        if was_scope_egress:
            lockdown.set_scope_egress(True)
        # The scope lives in memory once loaded, so without this the
        # imported rules sit in the database and affect nothing.
        scope = await asyncio.to_thread(engine.scope.reload)
        engine.match_replace.reload()
        await _apply_lockdown_to_plugins(lockdown.enabled)
        if lockdown.scope_egress_effective:
            # Rules and routing settings have just been replaced. Close every
            # old session before accepting traffic under the new snapshot.
            await engine.restart_for_scope_egress()
        broker.publish("scope.changed", scope.as_dict())
        broker.publish("project.imported", counts)
        return {"ok": True, **counts}

    @app.get("/api/project/compact")
    async def compact_preview() -> dict[str, Any]:
        """Show actual file use and exact captured targets before deletion."""
        overview = await asyncio.to_thread(store.compact_overview)
        paths_by_site = await asyncio.to_thread(store.paths_by_site)
        for site in overview["sites"]:
            key = (site["scheme"], site["host"], site["port"])
            paths = {row["path"] for row in paths_by_site.get(key, []) if row.get("path")}
            site["in_scope"] = bool(site["host"]) and any(
                engine.scope.contains(site["scheme"], site["host"], site["port"], path)
                for path in (paths or {"/"})
            )
        return overview

    @app.post("/api/project/compact")
    async def compact_project(payload: CompactProjectBody) -> dict[str, Any]:
        """Delete selected exact sites, then return unused DB pages to disk.

        An empty selection only VACUUMs free pages left by earlier edits.
        Scope, project settings, and saved editor tabs are never cleared.
        """
        if len(payload.sites) > 5000:
            raise HTTPException(status_code=422, detail="too many sites selected")
        before = await asyncio.to_thread(store.compact_overview)
        available = {
            (site["scheme"], site["host"], site["port"]): site["flows"]
            for site in before["sites"]
        }
        selected = {
            (site.scheme, site.host, site.port): site.flows for site in payload.sites
        }
        if not selected.keys() <= available.keys():
            raise HTTPException(status_code=422, detail="a selected site no longer exists")
        try:
            deleted = await asyncio.to_thread(
                store.delete_sites,
                [(*key, count) for key, count in selected.items()],
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        reclaim_error = None
        try:
            await asyncio.to_thread(store.reclaim_space)
        except (sqlite3.Error, OSError) as exc:
            # Deletion has committed. Report that accurately so the UI does
            # not suggest retrying a destructive action that already ran.
            reclaim_error = str(exc)
            logger.exception("could not compact project database")
        if deleted:
            broker.publish("flows.deleted", {"count": deleted})
        after = await asyncio.to_thread(store.compact_overview)
        return {
            "deleted": deleted,
            "before_bytes": before["db_bytes"],
            "after_bytes": after["db_bytes"],
            "reclaimed_bytes": max(0, before["db_bytes"] - after["db_bytes"]),
            "reclaim_error": reclaim_error,
        }

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

    @app.get("/api/upstream")
    async def upstream() -> dict[str, Any]:
        return engine.upstream_state()

    @app.post("/api/upstream")
    async def set_upstream(payload: dict[str, Any]) -> dict[str, Any]:
        hops = payload.get("hops") if "hops" in payload else payload.get("url")
        if hops is not None and not (
            isinstance(hops, str)
            or (isinstance(hops, list) and all(isinstance(hop, str) for hop in hops))
        ):
            raise HTTPException(status_code=422, detail="hops must be a list of proxy URLs")
        try:
            return await engine.set_upstream(hops)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ProxyStartError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

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
        anchor: int | None = Query(None, ge=0),
        cursor: str | None = None,
        host: str | None = None,
        method: str | None = None,
        status_code: int | None = None,
        search: str | None = None,
        # Repeatable, so the filter can be a set of checkboxes rather
        # than a single choice: ?methods=GET&methods=POST
        methods: list[str] | None = Query(None),
        status_classes: list[int] | None = Query(None),
        extensions: list[str] | None = Query(None),
        exclude_extensions: list[str] | None = Query(None),
        in_scope_only: bool = False,
    ) -> dict[str, Any]:
        try:
            page = await asyncio.to_thread(
                store.page_summaries,
                limit=limit,
                offset=offset,
                anchor=anchor,
                cursor=cursor,
                scope_predicate=(engine.scope.contains if in_scope_only and any(
                    rule.enabled for rule in engine.scope.scope.rules
                ) else None),
                host=host,
                method=method,
                status_code=status_code,
                search=search,
                methods=methods,
                status_classes=status_classes,
                extensions=extensions,
                exclude_extensions=exclude_extensions,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {**page, "count": len(page["items"])}

    @app.get("/api/flows/{flow_id}")
    async def get_flow(flow_id: str, reveal: bool = False) -> dict[str, Any]:
        record = await asyncio.to_thread(store.get, flow_id)
        if record is None:
            raise HTTPException(status_code=404, detail="flow not found")
        data = record.detail(auto_decompress=auto_decompress_enabled(store))
        data["request_headers"] = redact_headers(
            record.request_headers, reveal=reveal
        )
        data["response_headers"] = redact_headers(
            record.response_headers, reveal=reveal
        )
        variants = data.get("request_variants")
        if isinstance(variants, dict):
            for variant in variants.values():
                if isinstance(variant, dict):
                    variant["headers"] = redact_headers(
                        variant.get("headers"), reveal=reveal
                    )
        return data

    @app.get("/api/flows/{flow_id}/body/{side}")
    async def get_flow_body(flow_id: str, side: str) -> Response:
        if side not in {"request", "response"}:
            raise HTTPException(status_code=400, detail="side must be request or response")
        body = await asyncio.to_thread(store.get_body_bytes, flow_id, side)
        if body is None:
            raise HTTPException(status_code=404, detail="body not found")
        return Response(body, media_type="application/octet-stream")
    @app.get("/api/flows/{flow_id}/response-preview")
    async def get_response_preview(flow_id: str) -> dict[str, Any]:
        record = await asyncio.to_thread(store.get, flow_id)
        if record is None:
            raise HTTPException(status_code=404, detail="flow not found")
        return await asyncio.to_thread(response_preview, record)

    @app.get("/api/about")
    async def about() -> dict[str, Any]:
        """What build this is, for a bug report.

        Every nightly this month reports version 0.1.0, so the version
        alone does not say which build someone is running.
        """
        return build_info()

    @app.get("/api/updates")
    async def check_updates(
        channel: str | None = None, refresh: bool = False
    ) -> dict[str, Any]:
        """Whether a newer build has been published.

        Asked for, never volunteered: the engine makes no outbound call
        until the UI asks, because a proxy on an isolated network should
        not phone home on its own.
        """
        try:
            return await updates.check(channel=channel, refresh=refresh, policy=lockdown)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except updates.UpdateError as exc:
            # Offline is the common case here, and the reason belongs on
            # screen rather than as a bare 502.
            raise HTTPException(status_code=502, detail=str(exc)) from exc

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
        await asyncio.to_thread(store.reclaim_space)
        broker.publish("flows.cleared", {})
        return {"ok": True}

    @app.post("/api/flows/delete")
    async def delete_flows(payload: DeleteFlowsBody) -> dict[str, Any]:
        """Delete some of the history.

        A POST rather than DELETE /api/flows/{id}: a selection is
        several ids, and a site map folder is a filter rather than a
        list, neither of which fits in a path.
        """
        if payload.subtrees:
            if len(payload.subtrees) > 5000:
                raise HTTPException(status_code=422, detail="too many subtrees selected")
            deleted = await asyncio.to_thread(
                store.delete_selection,
                payload.ids,
                [
                    (item.host, item.port, item.port_is_null, item.scheme, item.path_prefix)
                    for item in payload.subtrees
                ],
            )
        elif payload.ids:
            deleted = await asyncio.to_thread(store.delete, payload.ids)
        elif payload.host or payload.path_prefix:
            deleted = await asyncio.to_thread(
                store.delete_by_prefix,
                host=payload.host,
                port=payload.port,
                port_is_null=payload.port_is_null,
                scheme=payload.scheme,
                path_prefix=payload.path_prefix,
            )
        else:
            # An empty body would otherwise mean "everything", which is
            # not something to arrive at by accident. Clearing has its
            # own endpoint and its own confirmation.
            raise HTTPException(
                status_code=400, detail="nothing to delete: give ids or a host"
            )

        if deleted:
            # Deleting is for saving space, and sqlite keeps the pages
            # unless asked. Done here so the file shrinks when the user
            # expects it to.
            await asyncio.to_thread(store.reclaim_space)
            broker.publish("flows.deleted", {"count": deleted})
        return {"deleted": deleted}

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

    # --- automatic Match & Replace --------------------------------------
    @app.get("/api/match-replace")
    async def match_replace_state() -> dict[str, Any]:
        return {"rules": engine.match_replace.state()}

    @app.put("/api/match-replace")
    async def put_match_replace(payload: MatchReplaceBody) -> dict[str, Any]:
        try:
            rules = engine.match_replace.replace_rules(payload.rules)
        except MatchReplaceError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"rules": rules}

    @app.post("/api/match-replace/preview")
    async def match_replace_preview(payload: MatchReplacePreviewBody) -> dict[str, str]:
        try:
            result = await asyncio.to_thread(
                preview_match_replace, payload.raw, payload.phase, payload.rules
            )
        except MatchReplaceError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"raw": result}

    # --- body display ----------------------------------------------------
    @app.get("/api/body-display")
    async def body_display_state() -> dict[str, bool]:
        return {"auto_decompress": auto_decompress_enabled(store)}

    @app.patch("/api/body-display")
    async def patch_body_display(payload: BodyDisplayPatch) -> dict[str, bool]:
        store.set_setting(
            AUTO_DECOMPRESS_SETTING, "1" if payload.auto_decompress else "0"
        )
        state = {"auto_decompress": payload.auto_decompress}
        broker.publish("body_display.changed", state)
        return state

    # --- WebSocket proxy -------------------------------------------------
    @app.get("/api/websockets")
    async def websocket_state() -> dict[str, Any]:
        return await asyncio.to_thread(engine.websockets.state)

    @app.get("/api/websockets/messages")
    async def websocket_messages(
        limit: int = Query(200, ge=1, le=1000),
        before: int | None = Query(None, ge=1),
    ) -> dict[str, Any]:
        return await asyncio.to_thread(store.page_websocket_messages, limit=limit, before=before)

    @app.get("/api/websockets/messages/{message_id}/raw")
    async def websocket_message_raw(message_id: str) -> Response:
        body = await asyncio.to_thread(store.get_websocket_message_bytes, message_id)
        if body is None:
            raise HTTPException(status_code=404, detail="message not found")
        return Response(body, media_type="application/octet-stream")

    @app.patch("/api/websockets/intercept")
    async def patch_websocket_intercept(
        patch: WebSocketRulesPatch,
    ) -> dict[str, bool]:
        return engine.websockets.set_rules(**patch.model_dump(exclude_unset=True))

    @app.post("/api/websockets/{message_id}/forward")
    async def forward_websocket_message(
        message_id: str, payload: WebSocketForwardBody
    ) -> dict[str, bool]:
        try:
            engine.websockets.forward(message_id, payload.content, payload.encoding)
        except WebSocketProxyError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @app.post("/api/websockets/{message_id}/drop")
    async def drop_websocket_message(message_id: str) -> dict[str, bool]:
        try:
            engine.websockets.drop(message_id)
        except WebSocketProxyError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @app.post("/api/websockets/repeat")
    async def repeat_websocket_message(
        payload: WebSocketRepeatBody,
    ) -> dict[str, bool]:
        try:
            engine.websockets.repeat(
                payload.connection_id,
                to_client=payload.to_client,
                content=payload.content,
                encoding=payload.encoding,
                is_text=payload.is_text,
            )
        except WebSocketProxyError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True}

    @app.delete("/api/websockets")
    async def clear_websocket_messages() -> dict[str, bool]:
        await asyncio.to_thread(store.clear_websocket_messages)
        engine.websockets.clear(persist=False)
        return {"ok": True}

    # --- replay (M3) ----------------------------------------------------
    @app.post("/api/replay/send")
    async def replay_send(req: ReplayRequest) -> dict[str, Any]:
        try:
            flow = build_flow(
                url=req.url,
                method=req.method,
                headers=[list(h) for h in req.headers],
                body=req.body,
                http_version=req.http_version,
                encode_content_body=auto_decompress_enabled(store),
            )
            record = await engine.replay.send(flow, timeout=req.timeout)
        except ReplayError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return render_raw(
            record, auto_decompress=auto_decompress_enabled(store)
        )

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
        if lockdown.scope_egress_effective:
            await engine.restart_for_scope_egress()
        return rule.as_dict()

    @app.post("/api/scope/from-url")
    async def add_scope_from_url(body: ScopeFromUrl) -> dict[str, Any]:
        try:
            template = rule_from_url(body.url, kind=body.kind, prefix=body.prefix, regex=body.regex)  # type: ignore[arg-type]
            fields = template.as_dict()
            fields.pop("id", None)
            rule = await asyncio.to_thread(lambda: engine.scope.add_rule(**fields))
        except ScopeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if lockdown.scope_egress_effective:
            await engine.restart_for_scope_egress()
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
        if lockdown.scope_egress_effective:
            await engine.restart_for_scope_egress()
        return scope.as_dict()

    @app.delete("/api/scope/rules/{rule_id}")
    async def delete_scope_rule(rule_id: int) -> dict[str, Any]:
        try:
            await asyncio.to_thread(lambda: engine.scope.delete_rule(rule_id))
        except ScopeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if lockdown.scope_egress_effective:
            await engine.restart_for_scope_egress()
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
        """Site summaries; small legacy callers can include all paths."""
        sites = await asyncio.to_thread(store.distinct_sites)
        # Keep small legacy callers working without letting a combined
        # response materialize millions of Python objects again.
        if with_paths and await asyncio.to_thread(store.count) > 50_000:
            raise HTTPException(
                status_code=413,
                detail="site map is too large; use /api/sitemap/paths pages",
            )
        by_site = await asyncio.to_thread(store.paths_by_site) if with_paths else {}
        active_rules = [rule for rule in engine.scope.scope.rules if rule.enabled]
        items = []
        for site in sites:
            key = (site["scheme"], site["host"], site["port"])
            rows = by_site.get(key, [])
            path_independent_scope = all(
                rule.path in ({"", "*"} if rule.match_type == "glob" else {".*"})
                or (rule.match_type == "glob" and rule.path == "/*"
                    and site["scheme"] in {"http", "https"})
                for rule in active_rules
            )
            if not active_rules:
                inside = True
            elif path_independent_scope or site["paths"] == 0:
                inside = engine.scope.contains(*key, "/")
            else:
                def matches_site_path(path: str) -> bool:
                    return engine.scope.contains(*key, path)

                inside = await asyncio.to_thread(
                    store.any_path_for_site,
                    *key,
                    matches_site_path,
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
        host: str,
        scheme: str = "https",
        port: int | None = None,
        port_is_null: bool = False,
        in_scope_only: bool = False,
        path_prefix: str | None = None,
        limit: int = Query(200, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        predicate, site_wide = await endpoint_scope_mode(in_scope_only)
        if predicate is not None and site_wide and (port is not None or port_is_null):
            if not predicate(scheme, host, port, "/"):
                return {"items": [], "count": 0}
            predicate = None
        return await asyncio.to_thread(
            store.page_paths_for_site,
            scheme, host, port,
            path_prefix=path_prefix, limit=limit, offset=offset,
            port_is_null=port_is_null,
            scope_predicate=predicate,
        )

    @app.get("/api/sitemap/folders")
    async def sitemap_folders(
        host: str, scheme: str = "https", port: int | None = None,
        port_is_null: bool = False, path_prefix: str | None = None,
        in_scope_only: bool = False,
        limit: int = Query(200, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        predicate, site_wide = await endpoint_scope_mode(in_scope_only)
        if predicate is not None and site_wide and (port is not None or port_is_null):
            if not predicate(scheme, host, port, "/"):
                return {"items": [], "has_more": False}
            predicate = None
        return await asyncio.to_thread(
            store.page_folders_for_site, scheme, host, port,
            path_prefix=path_prefix, limit=limit, offset=offset,
            port_is_null=port_is_null,
            scope_predicate=predicate,
        )

    async def endpoint_scope_mode(in_scope_only: bool) -> tuple[Any, bool]:
        if not in_scope_only:
            return None, False
        rules = [rule for rule in engine.scope.scope.rules if rule.enabled]
        if not rules:
            return None, False
        def any_path(rule: Any) -> bool:
            return rule.path in ("", "*") or (
                rule.match_type == "regex" and rule.path == ".*"
            )
        site_wide = all(any_path(rule) for rule in rules)
        if not site_wide and all(
            any_path(rule) or (rule.match_type == "glob" and rule.path == "/*")
            for rule in rules
        ):
            site_wide = await asyncio.to_thread(store.all_paths_start_with_slash)
        return engine.scope.contains, site_wide

    @app.get("/api/endpoints")
    async def endpoints(
        host: str | None = None,
        in_scope_only: bool = False,
        limit: int = Query(5000, ge=1, le=20000),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        predicate, site_wide = await endpoint_scope_mode(in_scope_only)
        return await asyncio.to_thread(
            store.page_endpoints, host=host, limit=limit, offset=offset,
            scope_predicate=predicate, scope_site_wide=site_wide,
        )

    @app.get("/api/endpoints/flows")
    async def endpoint_flows(
        scheme: str,
        host: str,
        method: str,
        template: str,
        port: int | None = None,
        in_scope_only: bool = False,
        limit: int = Query(200, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        predicate, site_wide = await endpoint_scope_mode(in_scope_only)
        return await asyncio.to_thread(
            store.page_endpoint_flows, scheme, host, port, method, template,
            limit=limit, offset=offset,
            scope_predicate=predicate, scope_site_wide=site_wide,
        )

    # --- fuzzer (M5) ----------------------------------------------------
    @app.post("/api/fuzzer/positions")
    async def fuzzer_positions(body: PositionsBody) -> dict[str, Any]:
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
        except FuzzerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/fuzzer/plan")
    async def fuzzer_plan(body: FuzzRunBody) -> dict[str, Any]:
        try:
            total = engine.fuzzer.plan(
                mode=body.mode,  # type: ignore[arg-type]
                template=body.template,
                payload_sets=body.payload_sets,
            )
        except FuzzerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"total": total}

    def _resolve_payload_sets(body: FuzzRunBody) -> list[list[str]]:
        """Literal lists first, then any saved sets named by id.

        Both are allowed so a quick one-off run does not need a saved
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

    def _speed(body: FuzzRunBody) -> RunSpeed:
        try:
            return RunSpeed(
                concurrency=(
                    body.concurrency
                    if body.concurrency is not None
                    else DEFAULT_CONCURRENCY
                ),
                delay=body.delay or 0.0,
            )
        except FuzzerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/fuzzer/runs")
    async def fuzzer_start(body: FuzzRunBody) -> dict[str, Any]:
        try:
            run = await engine.fuzzer.start(
                url=body.url,
                template=body.template,
                mode=body.mode,  # type: ignore[arg-type]
                payload_sets=_resolve_payload_sets(body),
                speed=_speed(body),
            )
        except FuzzerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return run.summary()

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
            entry, payloads = await wordlists.fetch(body.list_id, lockdown)
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

    @app.get("/api/fuzzer/runs")
    async def fuzzer_list() -> dict[str, Any]:
        return {
            "items": [run.summary() for run in engine.fuzzer.runs.values()],
        }

    @app.get("/api/fuzzer/runs/{run_id}")
    async def fuzzer_get(run_id: str) -> dict[str, Any]:
        try:
            return engine.fuzzer.get(run_id).as_dict()
        except FuzzerError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/fuzzer/runs/{run_id}/stop")
    async def fuzzer_stop(run_id: str) -> dict[str, Any]:
        try:
            return engine.fuzzer.stop(run_id).summary()
        except FuzzerError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # --- decoder / diff (M6) ------------------------------------------
    @app.get("/api/codecs")
    async def list_codecs() -> dict[str, Any]:
        return available_codecs()

    @app.post("/api/decode")
    async def decode_chain(body: DecodeBody) -> dict[str, Any]:
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
        await engine.plugins.refresh()
        return {
            "items": engine.plugins.list(),
            "directory": str(settings.plugins_dir),
            "safe_mode": engine.plugins.safe_mode,
            "development_mode": settings.plugin_dev_mode,
        }

    @app.post("/api/plugins/{name}/enable")
    async def enable_plugin(name: str) -> dict[str, Any]:
        lockdown.require_outbound("plugin execution")
        try:
            return (await engine.plugins.enable_async(name)).as_dict()
        except PluginError as exc:
            status = 404 if "not found" in str(exc) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.post("/api/plugins/{name}/disable")
    async def disable_plugin(name: str) -> dict[str, Any]:
        try:
            return (await engine.plugins.disable_async(name)).as_dict()
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/plugins/{name}/reload")
    async def reload_plugin(name: str) -> dict[str, Any]:
        lockdown.require_outbound("plugin execution")
        try:
            return (await engine.plugins.reload_async(name)).as_dict()
        except PluginError as exc:
            status = 404 if "not found" in str(exc) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.put("/api/plugins/order")
    async def order_plugins(names: list[str]) -> dict[str, Any]:
        try:
            return {"items": await engine.plugins.set_order(names)}
        except PluginError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/api/plugins/{name}/auto-reload")
    async def auto_reload_plugin(name: str, enabled: bool) -> dict[str, Any]:
        try:
            return (await engine.plugins.set_auto_reload(name, enabled)).as_dict()
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/plugin-contributions")
    async def plugin_contributions() -> dict[str, Any]:
        """Serializable catalogue of every live SDK contribution."""

        return engine.plugins.registry.list()

    @app.post("/api/plugins/install")
    async def install_plugin_package(
        request: Request,
        allow_unsigned: bool = True,
        replace: bool = False,
        enable: bool = False,
    ) -> dict[str, Any]:
        chunks: list[bytes] = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_ARCHIVE_BYTES:
                raise HTTPException(status_code=413, detail="package archive exceeds 50 MiB")
            chunks.append(chunk)
        archive = b"".join(chunks)
        try:
            result = await asyncio.to_thread(
                engine.plugin_packages.install,
                archive,
                allow_unsigned=allow_unsigned,
                replace=replace,
            )
            # A replaced package must not keep running the old code, and its
            # metadata only refreshes while unloaded.
            existing = engine.plugins.plugins.get(result["id"])
            restore_enabled = bool(existing and existing.enabled)
            if existing is not None and existing.loaded:
                await engine.plugins.disable_async(existing.name)
            await engine.plugins.refresh()
            plugin = engine.plugins.get(result["id"])
            if enable or restore_enabled:
                plugin = await engine.plugins.enable_async(plugin.name)
            return {**result, "plugin": plugin.as_dict()}
        except PluginPackageError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except PluginError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/plugins/install-development")
    async def install_development_plugin(
        payload: PluginDevelopmentInstall,
    ) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(
                engine.plugin_packages.install_development, Path(payload.path)
            )
            await engine.plugins.refresh()
            await engine.plugins.set_auto_reload(result["id"], True)
            return {
                **result,
                "plugin": engine.plugins.get(result["id"]).as_dict(),
            }
        except (PluginPackageError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.delete("/api/plugins/{name}/package")
    async def uninstall_plugin_package(name: str) -> dict[str, Any]:
        try:
            plugin = engine.plugins.get(name)
            if plugin.package_root is None:
                raise PluginPackageError(f"installed package not found: {name}")
            if plugin.loaded or plugin.enabled:
                await engine.plugins.disable_async(name)
            result = await asyncio.to_thread(engine.plugin_packages.uninstall, name)
            await engine.plugins.refresh()
            return result
        except PluginPackageError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/plugin-catalogue")
    async def plugin_catalogue(refresh: bool = False) -> dict[str, Any]:
        # Only a refresh leaves the machine; the cached catalogue is local.
        if refresh:
            lockdown.require_outbound("plugin catalogue refresh")
        try:
            result = await asyncio.to_thread(
                engine.plugin_catalogue.catalogue, refresh=refresh
            )
            if refresh:
                await engine.plugins.refresh()
            return result
        except PluginCatalogueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.put("/api/plugin-catalogue/sources")
    async def save_plugin_catalogue_sources(
        payload: PluginCatalogueSourcesBody,
    ) -> dict[str, Any]:
        try:
            sources = await asyncio.to_thread(
                engine.plugin_catalogue.save_sources,
                [source.model_dump() for source in payload.sources],
            )
            broker.publish("plugins.catalogue", {"sources": sources})
            return {"sources": sources}
        except PluginCatalogueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/plugin-catalogue/install")
    async def install_catalogue_plugin(
        payload: PluginCatalogueInstallBody,
    ) -> dict[str, Any]:
        # Refuse before the installed plugin is torn down, so a blocked
        # install leaves the working one running.
        lockdown.require_outbound("plugin catalogue install")
        existing = engine.plugins.plugins.get(payload.plugin)
        restore_enabled = bool(existing and existing.enabled)
        if existing is not None and (existing.loaded or existing.enabled):
            await engine.plugins.disable_async(payload.plugin)
        try:
            result = await asyncio.to_thread(
                engine.plugin_catalogue.install,
                payload.source,
                payload.plugin,
                payload.version,
            )
            await engine.plugins.refresh()
            plugin = engine.plugins.get(payload.plugin)
            if payload.enable or restore_enabled:
                plugin = await engine.plugins.enable_async(plugin.name)
            broker.publish("plugins.catalogue", {"installed": result})
            return {**result, "plugin": plugin.as_dict()}
        except (PluginCatalogueError, PluginPackageError) as exc:
            await engine.plugins.refresh()
            if restore_enabled and payload.plugin in engine.plugins.plugins:
                await engine.plugins.enable_async(payload.plugin)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except PluginError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/plugins/{name}/rollback")
    async def rollback_plugin(
        name: str, payload: PluginRollbackBody
    ) -> dict[str, Any]:
        restore_enabled = False
        try:
            plugin = engine.plugins.get(name)
            restore_enabled = plugin.enabled
            if plugin.loaded or plugin.enabled:
                await engine.plugins.disable_async(name)
            result = await asyncio.to_thread(
                engine.plugin_packages.rollback, name, payload.version
            )
            await engine.plugins.refresh()
            plugin = engine.plugins.get(name)
            if restore_enabled:
                plugin = await engine.plugins.enable_async(name)
            broker.publish("plugins.catalogue", {"rolled_back": result})
            return {**result, "plugin": plugin.as_dict()}
        except PluginPackageError as exc:
            await engine.plugins.refresh()
            if restore_enabled and name in engine.plugins.plugins:
                await engine.plugins.enable_async(name)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/plugin-ui/{name}/{asset:path}")
    async def plugin_ui_asset(name: str, asset: str) -> FileResponse:
        try:
            plugin = engine.plugins.get(name)
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not plugin.loaded or plugin.package_root is None or not plugin.meta.get("ui"):
            raise HTTPException(status_code=404, detail="plugin UI is not active")
        root = (plugin.package_root / "ui").resolve()
        candidate = (root / asset).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="UI asset not found") from exc
        relative = candidate.relative_to(plugin.package_root.resolve()).as_posix()
        integrity = load_manifest(plugin.package_root).integrity
        if (
            relative not in integrity
            or not candidate.is_file()
            or (
                not plugin.package_root.is_symlink()
                and file_sha256(candidate) != integrity[relative]
            )
        ):
            raise HTTPException(status_code=404, detail="UI asset not found")
        return FileResponse(
            candidate,
            headers={
                "Cache-Control": "no-store" if plugin.package_root.is_symlink() else "public, max-age=31536000, immutable",
                "Content-Security-Policy": (
                    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                    "img-src 'self' data:; font-src 'self'; connect-src 'none'; "
                    "base-uri 'none'; form-action 'none'; navigate-to 'none'; "
                    "frame-src 'none'; frame-ancestors 'self'; sandbox allow-scripts"
                ),
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/plugins/{name}/settings")
    async def plugin_settings(name: str) -> dict[str, Any]:
        try:
            engine.plugins.get(name)
            return engine.plugins.registry.settings(name)
        except (PluginError, PluginApiError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/plugins/{name}/diagnostics")
    async def plugin_diagnostics(name: str) -> dict[str, Any]:
        try:
            engine.plugins.get(name)
            return engine.plugins.registry.diagnostics(name)
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/plugins/{name}/diagnostics/reset")
    async def reset_plugin_diagnostics(name: str) -> dict[str, Any]:
        try:
            engine.plugins.get(name)
            result = engine.plugins.registry.reset_diagnostics(name)
            broker.publish("plugins.diagnostics", {"plugin": name, "reset": True})
            return result
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.patch("/api/plugins/{name}/settings")
    async def patch_plugin_settings(
        name: str, payload: PluginSettingsPatch
    ) -> dict[str, Any]:
        try:
            engine.plugins.get(name)
            for key, value in payload.values.items():
                engine.plugins.registry.set_setting(name, key, value)
            broker.publish("plugins.settings", {"plugin": name})
            return engine.plugins.registry.settings(name)
        except PluginApiError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except PluginError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/plugin-actions/{action_id}/invoke")
    async def invoke_plugin_action(
        action_id: str, payload: PluginActionBody
    ) -> dict[str, Any]:
        try:
            result = await engine.plugins.registry.invoke_action(
                action_id, payload.context
            )
            return {"result": result}
        except PluginApiError as exc:
            status = 404 if str(exc).startswith("unknown") else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.post("/api/plugin-payload-generators/{generator_id}/generate")
    async def generate_plugin_payloads(
        generator_id: str, payload: PluginPayloadGeneratorBody
    ) -> dict[str, Any]:
        try:
            values = await engine.plugins.registry.generate_payloads(
                generator_id, payload.options
            )
            return {"values": values, "count": len(values)}
        except PluginApiError as exc:
            status = 404 if str(exc).startswith("unknown") else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.post("/api/plugin-payload-processors/{processor_id}/process")
    async def process_plugin_payload(
        processor_id: str, payload: PluginPayloadProcessorBody
    ) -> dict[str, Any]:
        try:
            value = await engine.plugins.registry.process_payload(
                processor_id, payload.value, payload.context
            )
            return {"value": value}
        except PluginApiError as exc:
            status = 404 if str(exc).startswith("unknown") else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    # --- scanner and issues ---------------------------------------------
    @app.get("/api/issues")
    async def list_issues(
        status: str | None = None,
        severity: str | None = None,
        host: str | None = None,
        search: str | None = None,
        limit: int = Query(500, ge=1, le=5000),
    ) -> dict[str, Any]:
        if status not in (None, "open", "resolved", "false_positive"):
            raise HTTPException(status_code=422, detail="invalid issue status")
        if severity not in (None, "info", "low", "medium", "high", "critical"):
            raise HTTPException(status_code=422, detail="invalid issue severity")
        items = await asyncio.to_thread(
            store.list_issues,
            status=status,
            severity=severity,
            host=host,
            search=search,
            limit=limit,
        )
        summary = await asyncio.to_thread(store.issue_summary)
        return {"items": items, "count": len(items), "summary": summary}

    @app.get("/api/issues/{issue_id}")
    async def get_issue(issue_id: str) -> dict[str, Any]:
        issue = await asyncio.to_thread(store.get_issue, issue_id)
        if issue is None:
            raise HTTPException(status_code=404, detail="issue not found")
        return issue

    @app.patch("/api/issues/{issue_id}")
    async def patch_issue(
        issue_id: str, payload: IssueStatusPatch
    ) -> dict[str, Any]:
        if payload.status not in ("open", "resolved", "false_positive"):
            raise HTTPException(status_code=422, detail="invalid issue status")
        issue = await asyncio.to_thread(
            store.set_issue_status, issue_id, payload.status
        )
        if issue is None:
            raise HTTPException(status_code=404, detail="issue not found")
        broker.publish("issues.changed", issue)
        return issue

    @app.delete("/api/issues/{issue_id}")
    async def delete_issue(issue_id: str) -> dict[str, Any]:
        deleted = await asyncio.to_thread(store.delete_issue, issue_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="issue not found")
        broker.publish("issues.changed", {"id": issue_id, "deleted": True})
        return {"id": issue_id, "deleted": True}

    @app.get("/api/scanner")
    async def scanner_state() -> dict[str, Any]:
        contributions = engine.plugins.registry.list()
        return {
            "passive_enabled": engine.scanner.passive_enabled,
            "passive_checks": contributions["passive_scanners"],
            "active_checks": contributions["active_scanners"],
            "jobs": [job.as_dict() for job in engine.scanner.jobs.values()],
        }

    @app.patch("/api/scanner/passive")
    async def set_passive_scanner(enabled: bool) -> dict[str, Any]:
        engine.scanner.set_passive_enabled(enabled)
        return {"passive_enabled": enabled}

    @app.post("/api/scanner/passive/{flow_id}")
    async def run_passive_scanner(flow_id: str) -> dict[str, Any]:
        record = await asyncio.to_thread(store.get, flow_id)
        if record is None or record.type != "http":
            raise HTTPException(status_code=404, detail="HTTP flow not found")
        issues = await engine.scanner.scan_passive(request_snapshot(record))
        return {"items": issues, "count": len(issues)}

    @app.post("/api/scanner/active/{flow_id}")
    async def start_active_scan(
        flow_id: str, payload: ActiveScanBody
    ) -> dict[str, Any]:
        try:
            job = await engine.scanner.start_active(
                flow_id,
                check_ids=payload.check_ids or None,
                concurrency=payload.concurrency,
                requests_per_second=payload.requests_per_second,
            )
            return job.as_dict()
        except ScannerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/scanner/jobs/{job_id}")
    async def get_scan_job(job_id: str) -> dict[str, Any]:
        try:
            return engine.scanner.get_job(job_id).as_dict()
        except ScannerError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/scanner/jobs/{job_id}/stop")
    async def stop_scan_job(job_id: str) -> dict[str, Any]:
        try:
            job = engine.scanner.stop_job(job_id)
            await asyncio.sleep(0)
            return job.as_dict()
        except ScannerError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

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
