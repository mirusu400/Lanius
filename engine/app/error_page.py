"""Lanius wording for the error page the proxy returns to the browser.

mitmproxy answers a failed upstream connection with a bare "502 Bad Gateway"
page, which reads like the origin's own 502. When upstream certificate
verification is the cause, say so and point at the per-host exception.
"""

from __future__ import annotations

import html
from typing import Callable

TLS_VERIFY_PREFIX = "Certificate verify failed:"

_PAGE = """<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>{status} Lanius: upstream certificate rejected</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 42em; margin: 3em auto; line-height: 1.5">
    <h1>Lanius rejected the server certificate</h1>
    <p>This {status} response comes from the Lanius proxy, not from the website.
    The upstream HTTPS certificate failed verification:</p>
    <p><code>{message}</code></p>
    <p>Adding a trusted CA does not fix a hostname mismatch. If you are
    authorized to test this host and its certificate is known to be wrong,
    add the exact host under
    <b>Settings &rsaquo; Proxy &rsaquo; Upstream certificate exceptions</b>
    in Lanius, or use <b>Allow this host</b> on the request in HTTP history.</p>
</body>
</html>
"""


def format_error(status_code: int, message: str, fallback: Callable[[int, str], bytes]) -> bytes:
    if not message.startswith(TLS_VERIFY_PREFIX):
        return fallback(status_code, message)
    return _PAGE.format(status=status_code, message=html.escape(message)).encode("utf-8")


def install() -> bool:
    """Swap the page builder in mitmproxy's HTTP layers. Returns True if applied."""
    from mitmproxy.proxy.layers.http import _base, _http1, _http2, _http3

    original = _base.format_error
    if getattr(original, "_lanius_patched", False):
        return False

    def lanius_format_error(status_code: int, message: str) -> bytes:
        return format_error(status_code, message, original)

    lanius_format_error._lanius_patched = True  # type: ignore[attr-defined]
    for module in (_base, _http1, _http2, _http3):
        module.format_error = lanius_format_error  # type: ignore[attr-defined]
    return True
