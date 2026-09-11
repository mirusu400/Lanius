"""Endpoints: group flows into templates and identify parameters.

Concrete paths such as ``/users/42/orders/7`` collapse into the endpoint
``/users/{id}/orders/{id}`` so a site's real API surface becomes visible.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import parse_qsl

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
HEX_RE = re.compile(r"^[0-9a-f]{16,}$", re.I)
NUMERIC_RE = re.compile(r"^\d+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Long opaque strings (tokens, slugs with ids, base64-ish blobs).
OPAQUE_RE = re.compile(r"^[A-Za-z0-9_-]{24,}$")


def classify_segment(segment: str) -> str | None:
    """Return a placeholder name when a path segment looks like a parameter."""
    if not segment:
        return None
    if NUMERIC_RE.match(segment):
        return "id"
    if UUID_RE.match(segment):
        return "uuid"
    if DATE_RE.match(segment):
        return "date"
    if HEX_RE.match(segment):
        return "hash"
    if OPAQUE_RE.match(segment):
        return "token"
    return None


def templatize(path: str) -> tuple[str, list[str]]:
    """Convert a concrete path into a template plus the parameter values found."""
    if not path:
        return "/", []
    segments = path.split("/")
    values: list[str] = []
    out: list[str] = []
    for segment in segments:
        placeholder = classify_segment(segment)
        if placeholder is None:
            out.append(segment)
        else:
            out.append(f"{{{placeholder}}}")
            values.append(segment)
    return "/".join(out) or "/", values


def query_params(query: str | None) -> list[str]:
    if not query:
        return []
    return [name for name, _value in parse_qsl(query, keep_blank_values=True)]


@dataclass(slots=True)
class Endpoint:
    """An aggregated group of flows sharing method + path template."""

    method: str
    host: str
    scheme: str
    port: int | None
    template: str
    count: int = 0
    path_params: list[str] = field(default_factory=list)
    query_params: list[str] = field(default_factory=list)
    statuses: list[int] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)
    last_seen: float | None = None

    @property
    def key(self) -> str:
        return f"{self.method} {self.scheme}://{self.host}:{self.port}{self.template}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "method": self.method,
            "scheme": self.scheme,
            "host": self.host,
            "port": self.port,
            "template": self.template,
            "count": self.count,
            "path_params": self.path_params,
            "query_params": self.query_params,
            "statuses": sorted(self.statuses),
            "examples": self.examples[:5],
            "last_seen": self.last_seen,
        }


def build_endpoints(flows: Iterable[Any]) -> list[Endpoint]:
    """Group flow records (or dicts) into endpoints."""
    grouped: dict[tuple[str, str, str, int | None, str], Endpoint] = {}
    statuses: dict[tuple, set[int]] = defaultdict(set)
    qparams: dict[tuple, set[str]] = defaultdict(set)
    pparams: dict[tuple, set[str]] = defaultdict(set)

    for flow in flows:
        get = flow.get if isinstance(flow, dict) else lambda k: getattr(flow, k, None)
        method = (get("method") or "GET").upper()
        host = get("host") or ""
        scheme = get("scheme") or "http"
        port = get("port")
        path = get("path") or "/"
        template, values = templatize(path)
        key = (method, scheme, host, port, template)

        endpoint = grouped.get(key)
        if endpoint is None:
            endpoint = Endpoint(
                method=method,
                host=host,
                scheme=scheme,
                port=port,
                template=template,
            )
            grouped[key] = endpoint
        endpoint.count += 1

        status = get("status_code")
        if status is not None:
            statuses[key].add(int(status))
        for name in query_params(get("query")):
            qparams[key].add(name)
        for index, value in enumerate(values):
            pparams[key].add(value if len(value) <= 32 else f"{value[:29]}…")
            del index

        example = path + (f"?{get('query')}" if get("query") else "")
        if example not in endpoint.examples:
            endpoint.examples.append(example)

        started = get("started_at")
        if started is not None and (
            endpoint.last_seen is None or started > endpoint.last_seen
        ):
            endpoint.last_seen = started

    for key, endpoint in grouped.items():
        endpoint.statuses = sorted(statuses[key])
        endpoint.query_params = sorted(qparams[key])
        endpoint.path_params = sorted(pparams[key])

    return sorted(
        grouped.values(), key=lambda e: (e.host, e.template, e.method)
    )
