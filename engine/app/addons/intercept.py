"""Intercept addon: breakpoints on requests/responses with edit + resume/drop.

Uses mitmproxy's own flow-interception primitive (``flow.intercept()`` /
``flow.resume()``) rather than reimplementing connection handling (codex.md §9).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Literal

from mitmproxy import http

from .. import charset
from ..content_encoding import auto_decompress_enabled, body_for_display
from ..db.store import FlowStore
from ..events import EventBroker

logger = logging.getLogger(__name__)

Phase = Literal["request", "response"]


class InterceptError(Exception):
    """Raised for invalid intercept operations (mapped to HTTP 4xx)."""


@dataclass(slots=True)
class InterceptRules:
    """What to pause on."""

    enabled: bool = False
    intercept_requests: bool = True
    intercept_responses: bool = False
    host_filter: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "intercept_requests": self.intercept_requests,
            "intercept_responses": self.intercept_responses,
            "host_filter": self.host_filter,
        }


def _matches(rules: InterceptRules, flow: http.HTTPFlow) -> bool:
    if not rules.enabled:
        return False
    if rules.host_filter and rules.host_filter not in flow.request.pretty_host:
        return False
    return True


def paused_payload(
    flow: http.HTTPFlow, phase: Phase, *, auto_decompress: bool = True
) -> dict[str, Any]:
    """Serialize a paused flow for the UI editor."""
    req = flow.request
    request_body, _, _, _ = body_for_display(
        req.headers.items(multi=True), req.raw_content, enabled=auto_decompress
    )
    payload: dict[str, Any] = {
        "id": flow.id,
        "phase": phase,
        "method": req.method,
        "scheme": req.scheme,
        "host": req.pretty_host,
        "port": req.port,
        "path": req.path,
        "http_version": req.http_version,
        "request_headers": [[k, v] for k, v in req.headers.items(multi=True)],
        "request_body": charset.decode_body(
            req.headers.get("content-type"), request_body
        ),
        # The editor sends text back; this is how to turn it into the bytes
        # the endpoint expects.
        "request_charset": charset.charset_of(
            req.headers.get("content-type"), request_body
        ),
    }
    if flow.response is not None:
        resp = flow.response
        response_body, _, _, _ = body_for_display(
            resp.headers.items(multi=True),
            resp.raw_content,
            enabled=auto_decompress,
        )
        payload.update(
            status_code=resp.status_code,
            reason=resp.reason,
            response_headers=[[k, v] for k, v in resp.headers.items(multi=True)],
            response_body=charset.decode_body(
                resp.headers.get("content-type"), response_body
            ),
            response_charset=charset.charset_of(
                resp.headers.get("content-type"), response_body
            ),
        )
    return payload


class InterceptAddon:
    """Holds flows at a breakpoint until the UI resolves them."""

    def __init__(
        self,
        broker: EventBroker,
        rules: InterceptRules | None = None,
        *,
        store: FlowStore | None = None,
        on_forwarded: Callable[[http.HTTPFlow], None] | None = None,
    ) -> None:
        self.broker = broker
        self.rules = rules or InterceptRules()
        self.store = store
        self.on_forwarded = on_forwarded
        self.paused: dict[str, tuple[http.HTTPFlow, Phase]] = {}

    def _auto_decompress(self) -> bool:
        return self.store is None or auto_decompress_enabled(self.store)

    # --- mitmproxy hooks --------------------------------------------------
    def request(self, flow: http.HTTPFlow) -> None:
        if flow.is_replay == "request":
            return
        if self.rules.intercept_requests and _matches(self.rules, flow):
            self._hold(flow, "request")

    def response(self, flow: http.HTTPFlow) -> None:
        if self.rules.intercept_responses and _matches(self.rules, flow):
            self._hold(flow, "response")

    # --- control API ------------------------------------------------------
    def set_rules(self, **changes: Any) -> InterceptRules:
        for key, value in changes.items():
            if value is None or not hasattr(self.rules, key):
                continue
            setattr(self.rules, key, value)
        if not self.rules.enabled:
            self.resume_all()
        self.broker.publish("intercept.rules", self.rules.as_dict())
        return self.rules

    def list_paused(self) -> list[dict[str, Any]]:
        enabled = self._auto_decompress()
        return [
            paused_payload(f, phase, auto_decompress=enabled)
            for f, phase in self.paused.values()
        ]

    def forward(self, flow_id: str, edits: dict[str, Any] | None = None) -> None:
        flow, phase = self._take(flow_id)
        if edits:
            apply_edits(
                flow,
                phase,
                edits,
                body_is_decoded=self._auto_decompress(),
            )
            if self.on_forwarded is not None:
                self.on_forwarded(flow)
        flow.resume()
        self.broker.publish("intercept.resolved", {"id": flow_id, "action": "forward"})

    def drop(self, flow_id: str) -> None:
        flow, _phase = self._take(flow_id)
        # Order matters: ``kill()`` clears ``intercepted`` *without* firing the
        # resume event, so killing first would leave the client hanging
        # forever. Resume wakes the paused hook, then the error makes
        # mitmproxy tear the exchange down instead of forwarding it.
        flow.resume()
        if flow.killable:
            flow.kill()
        self.broker.publish("intercept.resolved", {"id": flow_id, "action": "drop"})

    def resume_all(self) -> int:
        count = len(self.paused)
        for flow_id in list(self.paused):
            flow, _ = self.paused.pop(flow_id)
            flow.resume()
            self.broker.publish(
                "intercept.resolved", {"id": flow_id, "action": "forward"}
            )
        return count

    # --- internals --------------------------------------------------------
    def _hold(self, flow: http.HTTPFlow, phase: Phase) -> None:
        flow.intercept()
        self.paused[flow.id] = (flow, phase)
        self.broker.publish(
            "intercept.paused",
            paused_payload(
                flow, phase, auto_decompress=self._auto_decompress()
            ),
        )

    def _take(self, flow_id: str) -> tuple[http.HTTPFlow, Phase]:
        entry = self.paused.pop(flow_id, None)
        if entry is None:
            raise InterceptError(f"flow {flow_id} is not paused")
        return entry


def apply_edits(
    flow: http.HTTPFlow,
    phase: Phase,
    edits: dict[str, Any],
    *,
    body_is_decoded: bool = True,
) -> None:
    """Apply UI edits to a paused flow before resuming."""
    if phase == "request":
        req = flow.request
        if (method := edits.get("method")) is not None:
            req.method = method
        if (path := edits.get("path")) is not None:
            req.path = path
        if (host := edits.get("host")) is not None:
            req.host = host
        if (port := edits.get("port")) is not None:
            req.port = int(port)
        if (headers := edits.get("request_headers")) is not None:
            _replace_headers(req.headers, headers)
        if (body := edits.get("request_body")) is not None:
            _set_body(req, body, decoded=body_is_decoded)
        return

    if flow.response is None:
        raise InterceptError("flow has no response to edit")
    resp = flow.response
    if (status := edits.get("status_code")) is not None:
        resp.status_code = int(status)
    if (reason := edits.get("reason")) is not None:
        resp.reason = reason
    if (headers := edits.get("response_headers")) is not None:
        _replace_headers(resp.headers, headers)
    if (body := edits.get("response_body")) is not None:
        _set_body(resp, body, decoded=body_is_decoded)


def _replace_headers(target: Any, headers: list[list[str]]) -> None:
    target.clear()
    for item in headers:
        if len(item) != 2:
            raise InterceptError(f"invalid header entry: {item!r}")
        target.add(item[0], item[1])


def _set_body(message: Any, body: str, *, decoded: bool) -> None:
    # Back to the charset this message declares. Writing UTF-8 into a
    # EUC-KR request delivers mojibake to the server, and the header would
    # then be lying about its own body.
    if not decoded and message.headers.get("content-encoding"):
        try:
            raw = body.encode("latin-1")
        except UnicodeEncodeError:
            raw = charset.encode(
                body,
                charset.charset_of(message.headers.get("content-type"), None),
            )
    else:
        raw = charset.encode(
            body, charset.charset_of(message.headers.get("content-type"), None)
        )
    if decoded:
        # Setting logical content re-applies gzip/deflate/br/zstd according
        # to Content-Encoding and fixes Content-Length.
        message.content = raw
    else:
        message.raw_content = raw
        if "transfer-encoding" not in message.headers:
            message.headers["content-length"] = str(len(raw))
