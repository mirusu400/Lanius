"""Request snapshots across automatic and interactive modification stages."""

from __future__ import annotations

from typing import Any

from mitmproxy import http

ORIGINAL = "lanius.request.original"
AUTO_MODIFIED = "lanius.request.auto_modified"


def snapshot(request: http.Request) -> dict[str, Any]:
    return {
        "method": request.method,
        "scheme": request.scheme,
        "host": request.pretty_host,
        "port": request.port,
        "path": request.path,
        "http_version": request.http_version,
        "headers": [(key, value) for key, value in request.headers.items(multi=True)],
        "body": request.raw_content or b"",
    }


def remember_original(flow: http.HTTPFlow) -> None:
    flow.metadata.setdefault(ORIGINAL, snapshot(flow.request))


def remember_auto_modified(flow: http.HTTPFlow) -> None:
    flow.metadata[AUTO_MODIFIED] = snapshot(flow.request)


def request_changed(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return left != right


__all__ = [
    "AUTO_MODIFIED",
    "ORIGINAL",
    "remember_auto_modified",
    "remember_original",
    "request_changed",
    "snapshot",
]
