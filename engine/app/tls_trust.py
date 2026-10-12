"""Explicit additional trust for HTTPS origins behind private/VPN CAs."""

from __future__ import annotations

import hashlib
import logging
import re
import ssl
import sys
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import certifi
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization

from .config import ensure_private_dir

logger = logging.getLogger(__name__)

TRUSTED_CA_SETTING = "tls_trusted_ca_pem"
MAX_CA_BYTES = 128 * 1024
_SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1"
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


def _windows_certificates(store: str) -> list[tuple[bytes, str, object]]:
    """Read a Windows certificate store without doing any network I/O."""
    enum_certificates = getattr(ssl, "enum_certificates", None)
    if sys.platform != "win32" or enum_certificates is None:
        return []
    return list(enum_certificates(store))


def windows_root_pem() -> bytes:
    if sys.platform != "win32":
        return b""
    return _cached_windows_root_pem()


@lru_cache(maxsize=1)
def _cached_windows_root_pem() -> bytes:
    """Export Windows roots trusted for TLS server authentication.

    mitmproxy's OpenSSL context does not consume the Windows certificate store
    by itself. VPN and enterprise interception roots are normally installed
    there, so include them while honoring purpose restrictions and the Windows
    Disallowed store. Store enumeration is local-only and cannot trigger
    certificate, CRL, or OCSP downloads.
    """
    try:
        disallowed = {
            hashlib.sha256(encoded).digest()
            for encoded, encoding, _trust in _windows_certificates("Disallowed")
            if encoding == "x509_asn"
        }
        roots = _windows_certificates("ROOT")
    except OSError:
        # If the deny list cannot be inspected, do not partially import system
        # trust. The certifi bundle remains available as the safe fallback.
        logger.warning("could not read Windows certificate trust", exc_info=True)
        return b""

    certificates: dict[bytes, bytes] = {}
    for encoded, encoding, trust in roots:
        if encoding != "x509_asn":
            continue
        if trust is not True and (
            not isinstance(trust, (set, frozenset))
            or _SERVER_AUTH_OID not in trust
        ):
            continue
        fingerprint = hashlib.sha256(encoded).digest()
        if fingerprint in disallowed:
            continue
        certificates[fingerprint] = ssl.DER_cert_to_PEM_cert(encoded).encode("ascii")
    # A stable order keeps the content-addressed filename unchanged when the
    # Windows API happens to enumerate the same roots in a different order.
    return b"".join(certificates[key] for key in sorted(certificates))


def linux_ca_bundle() -> bytes:
    if not sys.platform.startswith("linux"):
        return b""
    return _cached_linux_ca_paths()[0]


def linux_ca_dir() -> str | None:
    if not sys.platform.startswith("linux"):
        return None
    return _cached_linux_ca_paths()[1]


@lru_cache(maxsize=1)
def _cached_linux_ca_paths() -> tuple[bytes, str | None]:
    """Read OpenSSL's Linux trust locations without doing network I/O.

    Linux distributions expose trust through a bundle, a hashed certificate
    directory, or both. Preserve the bundle bytes so OpenSSL-specific trust
    and reject annotations remain intact, and pass the directory through to
    mitmproxy separately. The cache means trust-store changes take effect on
    the next Lanius start, matching the Windows behavior.
    """
    paths = ssl.get_default_verify_paths()
    bundle = b""
    if paths.cafile:
        try:
            bundle = Path(paths.cafile).read_bytes()
        except OSError:
            logger.warning("could not read Linux CA bundle", exc_info=True)

    ca_dir: str | None = None
    if paths.capath:
        try:
            path = Path(paths.capath)
            if path.is_dir():
                ca_dir = str(path.resolve())
        except OSError:
            logger.warning("could not inspect Linux CA directory", exc_info=True)
    return bundle, ca_dir


def upstream_ca_file(data_dir: Path, pem: str) -> str | None:
    """Extend public and operating-system roots rather than replacing them.

    Content-addressed filenames prevent mitmproxy's cached OpenSSL contexts
    from retaining an old CA after the user replaces the bundle.
    """
    normalized, _ = parse_ca_bundle(pem)
    system_roots = windows_root_pem() + linux_ca_bundle()
    if not normalized and not system_roots and not linux_ca_dir():
        return None
    bundle = Path(certifi.where()).read_bytes()
    if system_roots:
        bundle += b"\n" + system_roots
    if normalized:
        bundle += b"\n" + normalized.encode("ascii")
    directory = data_dir / "upstream-ca"
    ensure_private_dir(directory)
    path = directory / f"{hashlib.sha256(bundle).hexdigest()}.pem"
    if not path.exists():
        path.write_bytes(bundle)
        if path.stat().st_mode & 0o077:
            path.chmod(0o600)
    return str(path)
