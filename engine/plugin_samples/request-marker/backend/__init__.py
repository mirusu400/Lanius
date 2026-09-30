"""Bundled Request Marker sample plugin."""

from __future__ import annotations

import logging
from typing import Any, Mapping

from lanius_sdk import PluginContext, SettingDefinition
from mitmproxy import http

logger = logging.getLogger(__name__)


class RequestMarker:
    def __init__(self, context: PluginContext) -> None:
        self.context = context
        self.count = 0

    def request(self, flow: http.HTTPFlow) -> None:
        value = str(self.context.settings.get("header_value"))
        flow.request.headers["X-Lanius-Sample"] = value
        self.count += 1
        if self.context.settings.get("log_requests"):
            print(f"marked {flow.request.method} {flow.request.pretty_url}")

    def done(self) -> None:
        self.context.log.info("Request Marker stopped after %d requests", self.count)


def activate(context: PluginContext) -> RequestMarker:
    context.settings.define(
        SettingDefinition(
            "header_value",
            "Header value",
            description="Value written to the X-Lanius-Sample request header.",
            default="1",
        ),
        SettingDefinition(
            "log_requests",
            "Log every request",
            description="Write one stdout line for every marked request.",
            kind="boolean",
            default=False,
        ),
    )
    addon = RequestMarker(context)

    def stats(_payload: Mapping[str, Any]) -> dict[str, Any]:
        logger.debug("sample statistics requested")
        return {
            "count": addon.count,
            "header": "X-Lanius-Sample",
            "value": str(context.settings.get("header_value")),
        }

    def reset(_payload: Mapping[str, Any]) -> dict[str, Any]:
        addon.count = 0
        context.log.info("Request Marker count reset")
        return stats(_payload)

    context.actions.register(
        "stats",
        "Read Request Marker statistics",
        stats,
        locations=("global",),
    )
    context.actions.register(
        "reset",
        "Reset Request Marker count",
        reset,
        locations=("global",),
    )
    context.log.info("Request Marker activated")
    return addon
