"""Connect mitmproxy's upstream OpenSSL handshake to macOS trust evaluation."""

from __future__ import annotations

import logging

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from mitmproxy import connection, ctx, tls
from OpenSSL import SSL, crypto

from ..macos_trust import macos_trust

logger = logging.getLogger(__name__)


class MacOSSystemTrustAddon:
    def __init__(self, additional_ca_pem: str) -> None:
        self.trust = macos_trust()
        self.anchors = tuple(
            cert.public_bytes(serialization.Encoding.DER)
            for cert in x509.load_pem_x509_certificates(additional_ca_pem.encode("ascii"))
        ) if additional_ca_pem else ()

    def tls_start_server(self, data: tls.TlsData) -> None:
        # Runs after mitmproxy's tlsconfig has set the TLS profile, SNI, ALPN,
        # client certificate and OpenSSL's strict SAN hostname verification.
        if data.ssl_conn is None or ctx.options.ssl_insecure:
            return
        assert isinstance(data.conn, connection.Server)
        hostname = data.conn.sni or (data.conn.address[0] if data.conn.address else "")
        trusted: bool | None = None

        def verify(conn: SSL.Connection, cert: crypto.X509, error: int, depth: int, ok: int) -> bool:
            nonlocal trusted
            # Do not let Keychain's "allow expired" or hostname exceptions
            # weaken leaf validity or mitmproxy's SAN-only hostname matching.
            if error in (62, 64) or (depth == 0 and error in (9, 10)):
                return False
            if trusted is None:
                try:
                    chain = conn.get_peer_cert_chain(as_cryptography=True) or []
                    trusted = self.trust.verify([
                        item.public_bytes(serialization.Encoding.DER) for item in chain
                    ], hostname, self.anchors)
                except Exception:
                    logger.exception("macOS upstream certificate verification failed for %s", hostname)
                    trusted = False
            # Evaluate even when OpenSSL trusts the chain so Keychain's deny
            # decisions and SSL policy constraints still apply. Cache only for
            # this handshake; new connections see updated Keychain settings.
            return trusted

        data.ssl_conn.set_verify(SSL.VERIFY_PEER, verify)
