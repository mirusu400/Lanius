"""Inspect the proxy's public CA and local Windows trust stores, without egress.

This is client trust for our interception CA, not upstream server TLS trust.
It neither installs certificates nor changes any verification setting.
"""

from __future__ import annotations

import platform
import ssl
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization

SERVER_AUTH = "1.3.6.1.5.5.7.3.1"


def system_trust(confdir: Path) -> dict[str, Any]:
    """Does Windows trust this exact CA for HTTPS? Other clients remain unknown.

    ssl.enum_certificates includes readable current-user, local-machine and
    policy stores. Compare DER, not the subject name: old mitmproxy CAs often
    have the same name. See Python's ssl.enum_certificates documentation.
    """
    result: dict[str, Any] = {"platform": platform.system(), "status": "unknown"}
    try:
        cert = x509.load_pem_x509_certificate(
            (confdir / "mitmproxy-ca-cert.pem").read_bytes()
        )
    except (OSError, ValueError) as exc:
        return {**result, "status": "invalid", "detail": str(exc)}

    result["fingerprint_sha256"] = cert.fingerprint(hashes.SHA256()).hex().upper()
    now = datetime.now(timezone.utc)
    if not cert.not_valid_before_utc <= now <= cert.not_valid_after_utc:
        return {**result, "status": "invalid", "detail": "CA is outside its validity period"}

    if result["platform"] != "Windows":
        return {**result, "status": "unsupported"}

    enum_certificates = getattr(ssl, "enum_certificates", None)
    if enum_certificates is None:
        return {**result, "detail": "Windows certificate store inspection is unavailable"}
    der = cert.public_bytes(serialization.Encoding.DER)
    try:
        # A root explicitly distrusted by Windows must not report as trusted.
        disallowed = enum_certificates("Disallowed")
        if any(data == der and encoding == "x509_asn" for data, encoding, _ in disallowed):
            return {**result, "status": "not_trusted"}
        roots = enum_certificates("ROOT")
    except OSError as exc:
        # A failed inspection is not evidence that the user's CA is untrusted.
        return {**result, "detail": str(exc)}

    trusted = any(
        data == der and encoding == "x509_asn"
        and (trust is True or SERVER_AUTH in trust)
        for data, encoding, trust in roots
    )
    return {**result, "status": "trusted" if trusted else "not_trusted"}
