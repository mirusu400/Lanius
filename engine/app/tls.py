"""Upstream TLS profiles.

mitmproxy terminates TLS and opens its own connection to the server, so the
handshake the server sees is mitmproxy's, not the client's. That makes
Lanius easy to fingerprint. These profiles reorder the cipher list to
resemble a common browser, in the spirit of curl-cffi.

This is cipher-level shaping only. A full JA3/JA4 match would also need
control over extension order and GREASE, which OpenSSL does not expose, so
a determined fingerprinter can still tell the difference.
"""

from __future__ import annotations

from typing import Any

# Order matters: it is part of what a server fingerprints.
PROFILES: dict[str, dict[str, Any]] = {
    "default": {
        "label": "mitmproxy default",
        "ciphers": None,
        "curve": None,
        "min": "TLS1_2",
        "max": "UNBOUNDED",
    },
    "chrome": {
        "label": "Chrome",
        "ciphers": (
            "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:"
            "TLS_CHACHA20_POLY1305_SHA256:"
            "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:"
            "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:"
            "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:"
            "ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:"
            "AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA"
        ),
        "curve": "secp256r1",
        "min": "TLS1_2",
        "max": "UNBOUNDED",
    },
    "firefox": {
        "label": "Firefox",
        "ciphers": (
            "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:"
            "TLS_AES_256_GCM_SHA384:"
            "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:"
            "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:"
            "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:"
            "ECDHE-ECDSA-AES256-SHA:ECDHE-ECDSA-AES128-SHA:"
            "ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:"
            "AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA"
        ),
        "curve": "secp256r1",
        "min": "TLS1_2",
        "max": "UNBOUNDED",
    },
    "safari": {
        "label": "Safari",
        "ciphers": (
            "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:"
            "TLS_CHACHA20_POLY1305_SHA256:"
            "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:"
            "ECDHE-ECDSA-CHACHA20-POLY1305:"
            "ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:"
            "ECDHE-RSA-CHACHA20-POLY1305:"
            "ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA256:"
            "AES256-GCM-SHA384:AES128-GCM-SHA256"
        ),
        "curve": "secp256r1",
        "min": "TLS1_2",
        "max": "UNBOUNDED",
    },
    # Some servers behave differently on TLS 1.2, and a few middleboxes
    # still break on 1.3, so this is worth having as a one-click option.
    "tls12": {
        "label": "Force TLS 1.2",
        "ciphers": None,
        "curve": None,
        "min": "TLS1_2",
        "max": "TLS1_2",
    },
}

DEFAULT_PROFILE = "default"


def validate_ciphers(spec: str) -> None:
    """Raise ValueError if OpenSSL will not accept this cipher list.

    Checked before it is stored: an unusable list makes every upstream
    connection fail with a 502, which is hard to trace back.
    """
    import ssl

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        context.set_ciphers(spec)
    except ssl.SSLError as exc:
        raise ValueError(f"no usable ciphers in {spec!r}: {exc}") from exc


def options_for(profile: str, custom_ciphers: str | None = None) -> dict[str, Any]:
    """mitmproxy options that put the upstream side into this profile."""
    base = PROFILES.get(profile) or PROFILES[DEFAULT_PROFILE]
    ciphers = custom_ciphers or base["ciphers"]
    return {
        "ciphers_server": ciphers,
        "tls_ecdh_curve_server": base["curve"],
        "tls_version_server_min": base["min"],
        "tls_version_server_max": base["max"],
    }


def patch_version_probe() -> bool:
    """Stop mitmproxy crashing while building a TLS version warning.

    ``tlsconfig`` reacts to a change of ``tls_version_*`` by listing the
    versions this OpenSSL supports, and ``is_supported_version`` raises on
    OpenSSL 3.5 when asked about SSL3 rather than returning False. The
    probe is only used for an informational log line, so treating an error
    as "not supported" loses nothing and keeps the option change working.

    Returns True if the patch was applied.
    """
    try:
        from mitmproxy.net import tls as net_tls
    except ImportError:  # pragma: no cover - mitmproxy is a hard dependency
        return False

    original = getattr(net_tls, "is_supported_version", None)
    if original is None or getattr(original, "_lanius_patched", False):
        return False

    def safe_is_supported_version(version: object) -> bool:
        try:
            return bool(original(version))
        except Exception:
            return False

    safe_is_supported_version._lanius_patched = True  # type: ignore[attr-defined]
    setattr(net_tls, "is_supported_version", safe_is_supported_version)

    # tlsconfig imported the name into its own module namespace already.
    try:
        from mitmproxy.addons import tlsconfig

        if hasattr(tlsconfig, "net_tls"):
            setattr(tlsconfig.net_tls, "is_supported_version", safe_is_supported_version)
    except ImportError:  # pragma: no cover
        pass
    return True
