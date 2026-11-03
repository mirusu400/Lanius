"""Refuse user egress while the pinned public IP is not confirmed.

Every hook runs before DNS or socket creation. The decision does not depend
on the destination, so eager connection mode is safe: ``server_connect`` is
refused for every new connection, and requests on already-open connections
are refused by the request hooks. Live connections are closed by the engine
when the decision turns to "blocked".
"""

from __future__ import annotations

import time
from typing import Any

from mitmproxy import dns, http, tcp, udp

from ..egress_pin import EgressPinPolicy

BLOCKED_METADATA = "lanius.egress_pin_blocked"
BLOCKED_ERROR = "Lanius public IP pin blocked proxy traffic"


class EgressPinAddon:
    def __init__(self, pin: EgressPinPolicy, broker: Any = None) -> None:
        self.pin = pin
        self.broker = broker
        self._last_event: dict[str, float] = {}

    def allows_http(self, flow: http.HTTPFlow) -> bool:
        """Check a request without killing it (used when Intercept releases one)."""
        reason = self.pin.reason()
        if reason is None:
            return True
        self._mark(flow, reason, flow.request.pretty_host, flow.request.port)
        return False

    def _enforce_http(self, flow: http.HTTPFlow) -> None:
        if not self.allows_http(flow) and flow.killable:
            flow.kill()

    def http_connect(self, flow: http.HTTPFlow) -> None:
        self._enforce_http(flow)

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        self._enforce_http(flow)

    def request(self, flow: http.HTTPFlow) -> None:
        self._enforce_http(flow)

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        self._block_raw(flow)

    def udp_start(self, flow: udp.UDPFlow) -> None:
        self._block_raw(flow)

    def dns_request(self, flow: dns.DNSFlow) -> None:
        reason = self.pin.reason()
        if reason is None:
            return
        question = flow.request.question if flow.request is not None else None
        flow.metadata[BLOCKED_METADATA] = True
        if flow.killable:
            flow.kill()
        else:
            flow.server_conn.error = BLOCKED_ERROR
        self._publish(reason, question.name if question is not None else "", 53)

    def server_connect(self, data: Any) -> None:
        """Last line of defence immediately before mitmproxy opens a socket."""
        reason = self.pin.reason()
        if reason is None or data.server.error:
            return
        data.server.error = BLOCKED_ERROR
        address = data.server.address or ("", None)
        self._publish(reason, str(address[0]), address[1])

    def _block_raw(self, flow: tcp.TCPFlow | udp.UDPFlow) -> None:
        reason = self.pin.reason()
        if reason is None:
            return
        flow.metadata[BLOCKED_METADATA] = True
        # Checked by the proxy core before DNS lookup or socket creation.
        flow.server_conn.error = BLOCKED_ERROR
        address = flow.server_conn.address or ("", None)
        self._publish(reason, str(address[0]), address[1])

    def _mark(self, flow: http.HTTPFlow, reason: str, host: str, port: int | None) -> None:
        if flow.metadata.get(BLOCKED_METADATA):
            return
        flow.metadata[BLOCKED_METADATA] = True
        self._publish(reason, host, port)

    def _publish(self, reason: str, host: str, port: int | None) -> None:
        if self.broker is None:
            return
        # One toast per reason is enough; a browser retries constantly.
        now = time.monotonic()
        if now - self._last_event.get(reason, 0.0) < 3.0:
            return
        self._last_event[reason] = now
        self.broker.publish(
            "engine.egress_pin_blocked",
            {"reason": reason, "host": host, "port": port},
        )
