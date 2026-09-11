"""Example plugin: tag flows whose responses lack common security headers.

Copy this file into your plugins directory (default ``~/.lanius/plugins``)
and enable it from the Plugins tab.
"""

from mitmproxy import http

DESCRIPTION = "보안 헤더 누락을 flow 코멘트로 표시"
VERSION = "1.0.0"
AUTHOR = "Lanius"

SECURITY_HEADERS = (
    "content-security-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
)


class Plugin:
    """Adds a comment listing missing security headers."""

    def __init__(self) -> None:
        self.flagged = 0

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.response is None:
            return
        missing = [h for h in SECURITY_HEADERS if h not in flow.response.headers]
        if not missing:
            return
        self.flagged += 1
        flow.comment = "missing: " + ", ".join(missing)
