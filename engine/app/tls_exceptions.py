"""Explicit exceptions to upstream certificate verification.

Upstream TLS stays verified by default. A project can name exact hosts whose
certificate is known to be wrong (a hostname mismatch, a self-signed test
server) so an authorized user can still inspect them. Each host exception is a
whole hostname or IP address: no wildcards. An intentionally conspicuous
project setting can also disable verification for every upstream when a lab
contains many deliberately invalid certificates.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
import ssl
from typing import Iterable

from mitmproxy import connection, tls
from mitmproxy.proxy.layers import quic
from OpenSSL import SSL

logger = logging.getLogger(__name__)

TLS_EXCEPTIONS_SETTING = "tls_verify_exceptions"
TLS_INSECURE_SETTING = "tls_verify_insecure"
MAX_EXCEPTIONS = 100

_LABEL = re.compile(r"^(?!-)[a-z0-9_-]{1,63}(?<!-)$")


def normalize_host(value: str) -> str:
    """One exception host in canonical form, or ValueError."""
    if not isinstance(value, str):
        raise ValueError("host must be a string")
    host = value.strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if not host:
        raise ValueError("host must not be empty")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if "*" in host:
        raise ValueError(f"{value!r}: wildcards are not allowed; name the exact host")
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError(f"{value!r} is not a valid hostname") from exc
    if len(ascii_host) > 253 or not all(_LABEL.match(label) for label in ascii_host.split(".")):
        raise ValueError(f"{value!r} is not a valid hostname")
    return ascii_host


def normalize_hosts(values: Iterable[str]) -> list[str]:
    hosts = sorted({normalize_host(value) for value in values})
    if len(hosts) > MAX_EXCEPTIONS:
        raise ValueError(f"at most {MAX_EXCEPTIONS} hosts can be excepted")
    return hosts


def parse_setting(raw: str | None) -> list[str]:
    """The stored list; a damaged value means no exceptions, never all."""
    if not raw:
        return []
    try:
        values = json.loads(raw)
        if not isinstance(values, list):
            raise ValueError("not a list")
        return normalize_hosts(values)
    except (ValueError, TypeError):
        logger.warning("ignoring invalid %s setting", TLS_EXCEPTIONS_SETTING)
        return []


def dump_setting(hosts: list[str]) -> str:
    return json.dumps(hosts)


def _server_hosts(server: connection.Server) -> frozenset[str]:
    """Every exact name by which this upstream connection is identified.

    A CONNECT target may be an IP address while TLS carries a different SNI.
    Accepting only SNI made a correctly entered IP exception appear broken.
    Both are properties of the same concrete connection, so either exact value
    may authorize the exception without introducing wildcard matching.
    """
    hosts: set[str] = set()
    for value in (server.sni, server.address[0] if server.address else None):
        if value is None:
            continue
        try:
            hosts.add(normalize_host(str(value)))
        except ValueError:
            continue
    return frozenset(hosts)


class UpstreamTlsExceptionsAddon:
    """Skip certificate verification for the listed upstream hosts only.

    Must run after mitmproxy's tlsconfig and any trust addon that installs
    its own verify callback, so the exception is the last word for these
    hosts and nothing else.
    """

    def __init__(self, hosts: Iterable[str]) -> None:
        self.hosts = frozenset(hosts)

    def _excepted(self, conn: connection.Connection) -> str | None:
        if not self.hosts or not isinstance(conn, connection.Server):
            return None
        return next(iter(_server_hosts(conn) & self.hosts), None)

    def tls_start_server(self, data: tls.TlsData) -> None:
        if data.ssl_conn is None or (host := self._excepted(data.conn)) is None:
            return
        # The handshake still happens and the certificate is still recorded;
        # only a failed verification no longer aborts it.
        data.ssl_conn.set_verify(SSL.VERIFY_NONE, None)
        logger.info("upstream certificate verification skipped for %s by exception", host)

    def quic_start_server(self, data: quic.QuicTlsData) -> None:
        if data.settings is None or self._excepted(data.conn) is None:
            return
        data.settings.verify_mode = ssl.CERT_NONE
