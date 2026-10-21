"""Upstream HTTP policy shared by proxy, Replay and Fuzzer.

The small core adapter checks the negotiated connection before request headers
leave HttpStream. An addon alone cannot enforce this on lazy connections:
request hooks run before TLS, and TLS hooks cannot fail an HTTP stream.
"""
from __future__ import annotations

from contextvars import ContextVar
from functools import wraps
from typing import TYPE_CHECKING, Literal, cast

from mitmproxy import http, tls
from mitmproxy.flow import Error
from mitmproxy.proxy.layer import CommandGenerator

if TYPE_CHECKING:
    from .db.store import FlowStore

HttpMode = Literal["auto", "http1.0", "http1.1", "http2"]
MODES = ("auto", "http1.0", "http1.1", "http2")
SETTING = "http_mode"
MODE_KEY = "lanius.http_mode"
WIRE_KEY = "lanius.upstream_http_version"
# Connection tasks inherit this context; concurrent sends never change shared
# mitmproxy options or another request's TLS negotiation.
REPLAY_MODE: ContextVar[HttpMode | None] = ContextVar("lanius_http_mode", default=None)


def validate_mode(mode: str) -> HttpMode:
    if mode not in MODES:
        raise ValueError(f"unknown HTTP mode: {mode!r}")
    return cast(HttpMode, mode)


def project_mode(store: FlowStore) -> HttpMode:
    return validate_mode(store.get_setting(SETTING) or "auto")


def block(flow: http.HTTPFlow, message: str) -> None:
    flow.response = http.Response.make(502, message, {"Content-Type": "text/plain"})
    flow.error = Error(message)


class HttpProtocolAddon:
    def __init__(self, store: FlowStore) -> None:
        self.store = store
        install_core_adapter()

    def mode(self) -> HttpMode:
        return REPLAY_MODE.get() or project_mode(self.store)

    def tls_start_server(self, data: tls.TlsData) -> None:
        # The outer HTTPS proxy connection is transport, not the origin HTTP
        # protocol. Leave its ALPN alone (CONNECT is HTTP/1.1).
        if data.conn is not data.context.server or data.ssl_conn is None:
            return
        mode = self.mode()
        if mode == "auto" and REPLAY_MODE.get() is None:
            return  # preserve browser ALPN behavior
        if mode == "http2":
            offered = [b"h2"]
        elif mode in ("http1.0", "http1.1"):
            offered = [b"http/1.1"]
        else:
            offered = [b"h2", b"http/1.1"]
        data.conn.alpn_offers = tuple(offered)
        data.ssl_conn.set_alpn_protos(offered)

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        mode = self.mode()
        flow.metadata[MODE_KEY] = mode
        # Streamed uploads otherwise connect and send headers before request(),
        # bypassing version/framing edits and the final Intercept decision.
        # Forced modes buffer the upload so the request policy runs first.
        if mode != "auto" and flow.request.stream:
            transform = callable(flow.request.stream)
            flow.request.stream = False
            if transform:
                block(flow, "Forced HTTP modes do not support streaming request transforms")

    def request(self, flow: http.HTTPFlow) -> None:
        mode = self.mode()
        flow.metadata[MODE_KEY] = mode
        if flow.response or flow.error:
            return
        if mode == "http2" and flow.request.scheme != "https":
            block(flow, "HTTP/2 requires HTTPS; cleartext HTTP/2 (h2c) is not supported")
            return
        if mode in ("http1.0", "http2") and flow.request.headers.get("upgrade", "").lower() == "websocket":
            block(flow, "WebSocket upgrades require Auto or HTTP/1.1 mode")
            return
        if mode in ("http1.0", "http1.1"):
            request = flow.request
            if request.trailers:
                block(flow, "HTTP/1.x request trailers are not supported")
                return
            if request.authority and "host" not in request.headers:
                request.headers["Host"] = request.authority
            request.authority = ""
            request.http_version = "HTTP/1.0" if mode == "http1.0" else "HTTP/1.1"
            cookies = request.headers.get_all("cookie")
            if len(cookies) > 1:
                request.headers["Cookie"] = "; ".join(cookies)
            if mode == "http1.0":
                request.headers.pop("transfer-encoding", None)
                request.headers.pop("trailer", None)
                request.headers.pop("expect", None)
                request.headers["Connection"] = "close"
                if request.raw_content or "content-length" in request.headers:
                    request.headers["Content-Length"] = str(len(request.raw_content or b""))


def install_core_adapter() -> None:
    from mitmproxy.proxy import commands
    from mitmproxy.proxy.layers.http import HttpStream, ResponseProtocolError, ErrorCode

    original = HttpStream.make_server_connection
    if getattr(original, "_lanius_http_policy", False):
        return

    @wraps(original)
    def checked(stream: HttpStream) -> CommandGenerator[bool]:
        connected = yield from original(stream)
        if not connected:
            return False
        flow = stream.flow
        # Flows from another embedded mitmproxy instance are unaffected.
        mode = flow.metadata.get(MODE_KEY)
        if mode is None:
            return True
        alpn = flow.server_conn.alpn
        mismatch = (
            (mode == "http2" and alpn != b"h2") or
            (mode in ("http1.0", "http1.1") and alpn not in (None, b"", b"http/1.1", b"http/1.0"))
        )
        if mismatch:
            message = f"HTTP_VERSION_NEGOTIATION_FAILED: {mode} required, server negotiated {alpn!r}"
            yield commands.CloseConnection(flow.server_conn)
            yield from stream.handle_protocol_error(
                ResponseProtocolError(stream.stream_id, message, ErrorCode.CONNECT_FAILED)
            )
            return False
        if alpn == b"h2":
            version = "HTTP/2.0"
        elif alpn and alpn.startswith(b"h3"):
            version = "HTTP/3"
        elif flow.request.is_http2 or flow.request.is_http3:
            # mitmproxy converts HTTP/2 and HTTP/3 objects on HTTP/1 connections.
            version = "HTTP/1.1"
        else:
            version = flow.request.http_version
        flow.metadata[WIRE_KEY] = version
        return True

    setattr(checked, "_lanius_http_policy", True)
    setattr(HttpStream, "make_server_connection", checked)
