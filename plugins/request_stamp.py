"""Example plugin: stamp every proxied request with a marker header.

Demonstrates modifying traffic in flight. Useful for correlating your test
traffic in server-side logs.
"""

from mitmproxy import http

DESCRIPTION = "모든 요청에 X-Lanius 헤더 추가"
VERSION = "1.0.0"
AUTHOR = "Lanius"

HEADER = "X-Lanius"


class Plugin:
    def __init__(self, value: str = "1") -> None:
        self.value = value
        self.stamped = 0

    def request(self, flow: http.HTTPFlow) -> None:
        flow.request.headers[HEADER] = self.value
        self.stamped += 1
