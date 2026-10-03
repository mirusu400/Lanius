"""Response snapshots before and after automatic Match & Replace rules."""

from __future__ import annotations

from typing import Any

from mitmproxy import http

ORIGINAL = "lanius.response.original"
AUTO_MODIFIED = "lanius.response.auto_modified"


def snapshot(response: http.Response) -> dict[str, Any]:
    return {
        "http_version": response.http_version,
        "status_code": response.status_code,
        "reason": response.reason,
        "headers": [(key, value) for key, value in response.headers.items(multi=True)],
        "body": response.raw_content or b"",
    }


def remember_original(flow: http.HTTPFlow) -> None:
    if flow.response is not None:
        flow.metadata.setdefault(ORIGINAL, snapshot(flow.response))


def remember_auto_modified(flow: http.HTTPFlow) -> None:
    if flow.response is not None:
        flow.metadata[AUTO_MODIFIED] = snapshot(flow.response)
