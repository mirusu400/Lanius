"""Drop out-of-scope proxy egress while Lockdown Mode requests it.

HTTP is checked once headers reveal the exact URL and again after automatic
request rewriting. Raw TCP and UDP have no trustworthy HTTP scope identity,
so the strict mode refuses them outright.
"""

from __future__ import annotations

import time
from typing import Any

from mitmproxy import dns, http, tcp, udp

BLOCKED_METADATA = "lanius.scope_egress_blocked"
RAW_BLOCKED_ERROR = "Lockdown scope guard blocked raw proxy traffic"


class ScopeEgressEarlyAddon:
    """Hooks that must run before built-in resolvers and any user addon."""

    def __init__(self, guard: "ScopeEgressGuardAddon") -> None:
        self.guard = guard

    def http_connect(self, flow: http.HTTPFlow) -> None:
        self.guard.check_connect(flow)

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        self.guard.enforce_http(flow)

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        self.guard.block_tcp(flow)

    def udp_start(self, flow: udp.UDPFlow) -> None:
        self.guard.block_udp(flow)

    def dns_request(self, flow: dns.DNSFlow) -> None:
        self.guard.block_dns(flow)

    def server_connect(self, data: Any) -> None:
        self.guard.check_server_connect(data)


class ScopeEgressGuardAddon:
    """Final HTTP check plus shared fail-closed policy implementation."""

    def __init__(self, scope: Any, lockdown: Any, broker: Any = None) -> None:
        self.scope = scope
        self.lockdown = lockdown
        self.broker = broker
        self._last_event: dict[tuple[str, str, int | None], float] = {}
        self._authorized_servers: set[tuple[str, str, int]] = set()

    @property
    def active(self) -> bool:
        return bool(self.lockdown.scope_egress_effective)

    def reset_connections(self) -> None:
        self._authorized_servers.clear()

    def check_connect(self, flow: http.HTTPFlow) -> None:
        """Reject CONNECT destinations that no enabled include can admit."""
        if not self.active:
            return
        request = flow.request
        if self.scope.could_contain_origin("https", request.pretty_host, request.port):
            return
        self._block_http(flow)

    def request(self, flow: http.HTTPFlow) -> None:
        # Match & Replace runs before this addon and may have changed the URL.
        self.enforce_http(flow)

    def block_tcp(self, flow: tcp.TCPFlow) -> None:
        if self.active:
            self._block_raw(flow, "tcp")

    def block_udp(self, flow: udp.UDPFlow) -> None:
        if self.active:
            self._block_raw(flow, "udp")

    def block_dns(self, flow: dns.DNSFlow) -> None:
        if not self.active:
            return
        question = flow.request.question if flow.request is not None else None
        host = question.name if question is not None else ""
        flow.metadata[BLOCKED_METADATA] = True
        if flow.killable:
            flow.kill()
        else:
            flow.server_conn.error = RAW_BLOCKED_ERROR
        self._publish("dns", host, 53, "/", "proxy")

    def allows_http(self, flow: http.HTTPFlow, *, publish: bool = True) -> bool:
        """Check an HTTP flow without killing it (used by Intercept edits)."""
        if not self.active:
            return True
        request = flow.request
        path = request.path.split("?", 1)[0] or "/"
        allowed = self.scope.contains(
            request.scheme, request.pretty_host, request.port, path
        )
        if allowed:
            self._authorize_http(flow)
        if not allowed and publish:
            self._mark_and_publish(
                flow,
                request.scheme or "http",
                request.pretty_host,
                request.port,
                path,
            )
        return bool(allowed)

    def check_server_connect(self, data: Any) -> None:
        """Last line of defence immediately before mitmproxy opens a socket."""
        if not self.active or data.server.error:
            return
        address = data.server.address
        if not address:
            data.server.error = RAW_BLOCKED_ERROR
            return
        host, port = str(address[0]).lower(), int(address[1])
        key = (str(data.server.transport_protocol), host, port)
        if key in self._authorized_servers:
            return
        data.server.error = RAW_BLOCKED_ERROR
        self._publish("connection", host, port, "/", "proxy")

    def enforce_http(self, flow: http.HTTPFlow) -> bool:
        if self.allows_http(flow):
            return True
        if flow.killable:
            flow.kill()
        return False

    def _block_http(self, flow: http.HTTPFlow) -> None:
        request = flow.request
        self._mark_and_publish(
            flow,
            request.scheme or "https",
            request.pretty_host,
            request.port,
            request.path.split("?", 1)[0] or "/",
        )
        if flow.killable:
            flow.kill()

    def _block_raw(self, flow: tcp.TCPFlow | udp.UDPFlow, protocol: str) -> None:
        address = flow.server_conn.address or ("", 0)
        host = str(address[0])
        port = int(address[1]) if len(address) > 1 else None
        flow.metadata[BLOCKED_METADATA] = True
        # tcp_start/udp_start run before OpenConnection. The proxy core checks
        # this field and returns without DNS lookup or socket creation.
        flow.server_conn.error = RAW_BLOCKED_ERROR
        self._publish(protocol, host, port, "/", "proxy")

    def _authorize_http(self, flow: http.HTTPFlow) -> None:
        request = flow.request
        transport = str(flow.server_conn.transport_protocol)
        self._authorized_servers.add(
            (transport, request.pretty_host.lower(), int(request.port))
        )
        if flow.server_conn.address:
            host, port = flow.server_conn.address
            self._authorized_servers.add((transport, str(host).lower(), int(port)))
        if flow.server_conn.via:
            _scheme, address = flow.server_conn.via
            self._authorized_servers.add(("tcp", str(address[0]).lower(), int(address[1])))

    def _mark_and_publish(
        self,
        flow: http.HTTPFlow,
        scheme: str,
        host: str,
        port: int | None,
        path: str,
    ) -> None:
        if flow.metadata.get(BLOCKED_METADATA):
            return
        flow.metadata[BLOCKED_METADATA] = True
        source = "replay" if flow.is_replay == "request" else "proxy"
        self._publish(scheme, host, port, path, source)

    def _publish(
        self,
        scheme: str,
        host: str,
        port: int | None,
        path: str,
        source: str,
    ) -> None:
        if self.broker is None:
            return
        # Browsers often retry a failed background request immediately. Keep
        # feedback useful without flooding every stream subscriber and log.
        key = (scheme, host, port)
        now = time.monotonic()
        if now - self._last_event.get(key, 0.0) < 1.0:
            return
        self._last_event[key] = now
        self.broker.publish(
            "engine.scope_egress_blocked",
            {
                "scheme": scheme,
                "host": host,
                "port": port,
                "path": path,
                "source": source,
            },
        )
