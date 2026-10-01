"""Explicit additional trust for HTTPS origins behind private/VPN CAs."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import certifi
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization

from .config import ensure_private_dir

TRUSTED_CA_SETTING = "tls_trusted_ca_pem"
MAX_CA_BYTES = 128 * 1024
_CERTIFICATE = re.compile(
    r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.DOTALL
)


def parse_ca_bundle(pem: str, *, check_dates: bool = False) -> tuple[str, list[dict[str, Any]]]:
    """Accept only public CA certificates, and normalize a PEM bundle."""
    if len(pem.encode("utf-8")) > MAX_CA_BYTES:
        raise ValueError("CA certificate bundle must be at most 128 KiB")
    if not pem.strip():
        return "", []
    blocks = _CERTIFICATE.findall(pem)
    if not blocks or _CERTIFICATE.sub("", pem).strip():
        raise ValueError("provide PEM CA certificates only, without private keys or other data")
    if len(blocks) > 32:
        raise ValueError("CA certificate bundle must contain at most 32 certificates")

    normalized: list[str] = []
    certificates: list[dict[str, Any]] = []
    seen: set[str] = set()
    now = datetime.now(timezone.utc)
    for block in blocks:
        try:
            cert = x509.load_pem_x509_certificate(block.encode("ascii"))
            if not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise ValueError("certificate is not a CA")
        except (ValueError, x509.ExtensionNotFound) as exc:
            raise ValueError("each certificate must be a valid PEM CA certificate") from exc
        try:
            usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
            if not usage.key_cert_sign:
                raise ValueError("CA certificate does not permit signing certificates")
        except x509.ExtensionNotFound:
            pass
        valid = cert.not_valid_before_utc <= now <= cert.not_valid_after_utc
        if check_dates and not valid:
            raise ValueError("CA certificate is expired or not yet valid")
        fingerprint = cert.fingerprint(hashes.SHA256()).hex()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        normalized.append(cert.public_bytes(serialization.Encoding.PEM).decode("ascii"))
        certificates.append({
            "subject": cert.subject.rfc4514_string(),
            "expires_at": cert.not_valid_after_utc.isoformat(),
            "sha256": fingerprint,
            "valid": valid,
        })
    return "".join(normalized), certificates


def upstream_ca_file(data_dir: Path, pem: str) -> str | None:
    """Extend certifi rather than replacing public roots with the private CA.

    Content-addressed filenames prevent mitmproxy's cached OpenSSL contexts
    from retaining an old CA after the user replaces the bundle.
    """
    normalized, _ = parse_ca_bundle(pem)
    if not normalized:
        return None
    bundle = Path(certifi.where()).read_bytes() + b"\n" + normalized.encode("ascii")
    directory = data_dir / "upstream-ca"
    ensure_private_dir(directory)
    path = directory / f"{hashlib.sha256(bundle).hexdigest()}.pem"
    if not path.exists():
        path.write_bytes(bundle)
        if path.stat().st_mode & 0o077:
            path.chmod(0o600)
    return str(path)
