"""Turn a captured request into code someone can run elsewhere.

A request is only useful outside the proxy if it can be reproduced, so
these emit headers and body, not just a URL. The previous curl action
emitted neither, which meant the command it produced did not repeat the
request it came from.

Each generator takes the same shape, so a caller does not need to know
which one it is asking for.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from html import escape
from urllib.parse import parse_qsl, urlsplit

# Headers a client sets for itself. Copying them into generated code
# produces requests that fail in confusing ways: a stale Content-Length,
# or a Host that disagrees with the URL.
_CLIENT_MANAGED = frozenset(
    {
        "connection",
        "content-length",
        "host",
        "transfer-encoding",
        "upgrade",
    }
)

# What counts as a secret. Matched on the header name rather than its
# value, since a token has no reliable shape.
SECRET_HEADERS = frozenset(
    {
        "authorization",
        "cookie",
        "proxy-authorization",
        "set-cookie",
        "x-api-key",
        "x-auth-token",
        "x-csrf-token",
        "x-session-token",
        "x-xsrf-token",
    }
)

# Names inside a cookie header, a query string or a form body whose value
# is worth hiding even when the header itself is not a secret.
_SECRET_FIELD = re.compile(
    r"(pass|pwd|secret|token|session|sess|auth|api[-_]?key|credential|jwt"
    r"|access[-_]?key|refresh|otp|csrf|xsrf|sid)",
    re.IGNORECASE,
)

REDACTED = "[redacted]"


@dataclass(slots=True)
class RequestSpec:
    """A request, in the form every generator needs."""

    method: str
    url: str
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: str = ""

    def usable_headers(self) -> list[tuple[str, str]]:
        return [
            (name, value)
            for name, value in self.headers
            if name.lower() not in _CLIENT_MANAGED
        ]


def redact_value(name: str, value: str) -> str:
    """Hide a header value that carries credentials.

    Authorization keeps its scheme, because "Bearer [redacted]" tells a
    reader what kind of credential it was, which is often the point of
    sharing the request at all.
    """
    lowered = name.lower()
    if lowered not in SECRET_HEADERS:
        return value
    if lowered == "authorization":
        scheme = value.split(" ", 1)[0]
        # Only when it looks like a scheme, not a bare token.
        if scheme and scheme.isalpha() and " " in value:
            return f"{scheme} {REDACTED}"
        return REDACTED
    if lowered in {"cookie", "set-cookie"}:
        return _redact_cookies(value)
    return REDACTED


def _redact_cookies(value: str) -> str:
    """Hide the values of cookies that carry credentials.

    Which cookies a request sends is usually the interesting part, and a
    cookie is not automatically a secret: hiding theme=dark makes the
    output harder to read without protecting anything. Session and token
    cookies are hidden; the rest are left so the request stays legible.
    """
    parts = []
    for pair in value.split(";"):
        stripped = pair.strip()
        if not stripped:
            continue
        if "=" not in stripped:
            parts.append(stripped)
            continue
        name, _, rest = stripped.partition("=")
        if _SECRET_FIELD.search(name) or _looks_like_a_token(rest):
            parts.append(f"{name}={REDACTED}")
        else:
            parts.append(stripped)
    return "; ".join(parts)


# Long opaque strings are credentials often enough to be worth hiding
# even when the name gives nothing away, which is common for session
# cookies named things like "s" or "_id".
_TOKENISH = re.compile(r"^[A-Za-z0-9_\-]{24,}$|^[A-Za-z0-9+/=]{24,}$")


def _looks_like_a_token(value: str) -> bool:
    return bool(_TOKENISH.match(value.strip()))


def redact_query(url: str) -> str:
    """Hide credential-looking values in a query string."""
    parts = urlsplit(url)
    if not parts.query:
        return url
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    if not pairs:
        return url
    rebuilt = "&".join(
        f"{key}={REDACTED if _SECRET_FIELD.search(key) else value}"
        for key, value in pairs
    )
    return parts._replace(query=rebuilt).geturl()


def redact_body(body: str, content_type: str | None) -> str:
    """Hide credential-looking values in a request body.

    Handles the two shapes a login actually arrives in: a form post and a
    JSON object. Anything else is left alone rather than mangled, since a
    half-redacted body is worse than an obviously untouched one.
    """
    if not body:
        return body
    lowered = (content_type or "").lower()

    if "json" in lowered:
        try:
            parsed = json.loads(body)
        except ValueError:
            return body
        return json.dumps(_redact_json(parsed), ensure_ascii=False, indent=2)

    if "x-www-form-urlencoded" in lowered or ("=" in body and "\n" not in body):
        pairs = parse_qsl(body, keep_blank_values=True)
        if not pairs:
            return body
        return "&".join(
            f"{key}={REDACTED if _SECRET_FIELD.search(key) else value}"
            for key, value in pairs
        )

    return body


def _redact_json(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: (
                REDACTED
                if isinstance(key, str) and _SECRET_FIELD.search(key)
                else _redact_json(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    return value


def redacted(spec: RequestSpec) -> RequestSpec:
    """The same request with its credentials removed."""
    content_type = next(
        (v for k, v in spec.headers if k.lower() == "content-type"), None
    )
    return RequestSpec(
        method=spec.method,
        url=redact_query(spec.url),
        headers=[(name, redact_value(name, value)) for name, value in spec.headers],
        body=redact_body(spec.body, content_type),
    )


def as_curl(spec: RequestSpec) -> str:
    lines = [f"curl -X {spec.method.upper()} {_shell_quote(spec.url)}"]
    for name, value in spec.usable_headers():
        lines.append(f"  -H {_shell_quote(f'{name}: {value}')}")
    if spec.body:
        lines.append(f"  --data-raw {_shell_quote(spec.body)}")
    return " \\\n".join(lines)


def as_fetch(spec: RequestSpec) -> str:
    headers = {name: value for name, value in spec.usable_headers()}
    options: dict[str, object] = {"method": spec.method.upper()}
    if headers:
        options["headers"] = headers
    if spec.body:
        options["body"] = spec.body
    # credentials: cookies are sent explicitly above, so 'omit' keeps the
    # browser from adding its own and producing a different request.
    options["credentials"] = "omit"
    return (
        f"await fetch({json.dumps(spec.url)}, "
        f"{json.dumps(options, ensure_ascii=False, indent=2)});"
    )


def as_python_requests(spec: RequestSpec) -> str:
    """Python that reproduces the request, using the body's own shape."""
    lines = ["import requests", ""]
    headers = spec.usable_headers()
    if headers:
        lines.append("headers = {")
        for name, value in headers:
            lines.append(f"    {_py(name)}: {_py(value)},")
        lines.append("}")
        lines.append("")

    content_type = next((v for k, v in spec.headers if k.lower() == "content-type"), "")
    call = [f"response = requests.request(", f"    {_py(spec.method.upper())},", f"    {_py(spec.url)},"]
    if headers:
        call.append("    headers=headers,")

    if spec.body:
        if "json" in (content_type or "").lower():
            try:
                parsed = json.loads(spec.body)
            except ValueError:
                call.append(f"    data={_py(spec.body)},")
            else:
                lines.append(f"payload = {_py_value(parsed)}")
                lines.append("")
                call.append("    json=payload,")
        else:
            call.append(f"    data={_py(spec.body)},")

    call.append(")")
    lines.extend(call)
    lines.append("print(response.status_code)")
    lines.append("print(response.text)")
    return "\n".join(lines)


def as_csrf_html(spec: RequestSpec) -> str:
    """A page that makes a browser send this request.

    Only the shapes a form can actually produce. A cross-site form cannot
    set arbitrary headers, so a request that depends on one (a JSON
    content type, a bearer token, a custom header) cannot be forged this
    way, and saying so is more use than emitting a page that silently
    sends something different.
    """
    method = spec.method.upper()
    blockers = _csrf_blockers(spec, method)
    if blockers:
        reasons = "\n".join(f"  - {reason}" for reason in blockers)
        return (
            "<!-- This request cannot be forged with a cross-site form:\n"
            f"{reasons}\n"
            "  A form can only send GET or POST, and only with\n"
            "  application/x-www-form-urlencoded, multipart/form-data or\n"
            "  text/plain. Custom headers are not attainable cross-site. -->\n"
        )

    fields = parse_qsl(spec.body, keep_blank_values=True) if spec.body else []
    if method == "GET":
        fields = parse_qsl(urlsplit(spec.url).query, keep_blank_values=True)
    action = spec.url.split("?", 1)[0] if method == "GET" else spec.url

    inputs = "\n".join(
        f'      <input type="hidden" name="{escape(name, quote=True)}" '
        f'value="{escape(value, quote=True)}">'
        for name, value in fields
    )
    parts = [
        "<!doctype html>",
        "<html>",
        "  <body>",
        "    <!-- Proof of concept: submits on load, as an attacker page would.",
        "         The browser attaches the victim's cookies by itself. -->",
        f'    <form id="csrf" method="{method}" '
        f'action="{escape(action, quote=True)}">',
    ]
    if inputs:
        parts.append(inputs)
    parts.extend(
        [
            "    </form>",
            "    <script>document.getElementById('csrf').submit();</script>",
            "  </body>",
            "</html>",
        ]
    )
    return "\n".join(parts) + "\n"


def _csrf_blockers(spec: RequestSpec, method: str) -> list[str]:
    reasons: list[str] = []
    if method not in {"GET", "POST"}:
        reasons.append(f"{method} cannot be sent by an HTML form")
    for name, _value in spec.headers:
        lowered = name.lower()
        if lowered in _CLIENT_MANAGED or lowered == "cookie":
            continue
        if lowered == "content-type":
            continue
        if lowered in {"accept", "accept-language", "user-agent", "referer", "origin"}:
            continue
        reasons.append(f"the request depends on the {name} header")
    content_type = next(
        (v for k, v in spec.headers if k.lower() == "content-type"), ""
    ).lower()
    if method == "POST" and content_type and not any(
        allowed in content_type
        for allowed in (
            "application/x-www-form-urlencoded",
            "multipart/form-data",
            "text/plain",
        )
    ):
        reasons.append(f"a form cannot send {content_type.split(';')[0]}")
    return reasons


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def _py(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _py_value(value: object) -> str:
    """A Python literal. json is close enough apart from the three words
    it spells differently."""
    text = json.dumps(value, ensure_ascii=False, indent=4)
    return re.sub(
        r"\b(true|false|null)\b",
        lambda m: {"true": "True", "false": "False", "null": "None"}[m.group(0)],
        text,
    )


GENERATORS: dict[str, Callable[[RequestSpec], str]] = {
    "curl": as_curl,
    "fetch": as_fetch,
    "python": as_python_requests,
    "csrf": as_csrf_html,
}

# Formats contributed by plugins, kept apart from the built-ins so a
# plugin cannot quietly replace curl with something else, and so
# unloading a plugin takes its formats with it.
_PLUGIN_FORMATS: dict[str, tuple[str, str, Callable[[RequestSpec], str]]] = {}


def register_format(
    owner: str, kind: str, label: str, generator: Callable[[RequestSpec], str]
) -> None:
    """Let a plugin add a format to the right-click menu.

    A plugin declares ``codegen_formats`` and gets an entry in the menu
    of every panel, with no UI code of its own.
    """
    if kind in GENERATORS:
        raise ValueError(f"{kind!r} is a built-in format")
    _PLUGIN_FORMATS[kind] = (owner, label, generator)


def unregister_owner(owner: str) -> None:
    """Drop the formats a plugin contributed, when it is unloaded."""
    for kind in [k for k, (o, _, _) in _PLUGIN_FORMATS.items() if o == owner]:
        del _PLUGIN_FORMATS[kind]


def available_formats() -> list[dict[str, str]]:
    """Every format the menus can offer, built in and contributed."""
    builtin = [
        {"kind": kind, "label": label, "source": "builtin"}
        for kind, label in (
            ("curl", "curl"),
            ("fetch", "fetch"),
            ("python", "Python requests"),
            ("csrf", "CSRF proof of concept"),
        )
    ]
    contributed = [
        {"kind": kind, "label": label, "source": owner}
        for kind, (owner, label, _) in sorted(_PLUGIN_FORMATS.items())
    ]
    return builtin + contributed


def generate(kind: str, spec: RequestSpec) -> str:
    """Render a request as the named format."""
    generator = GENERATORS.get(kind)
    if generator is None:
        contributed = _PLUGIN_FORMATS.get(kind)
        if contributed is None:
            raise ValueError(f"unknown format: {kind!r}")
        generator = contributed[2]
    return generator(spec)


__all__ = [
    "GENERATORS",
    "SECRET_HEADERS",
    "REDACTED",
    "RequestSpec",
    "as_csrf_html",
    "as_curl",
    "available_formats",
    "as_fetch",
    "as_python_requests",
    "generate",
    "redact_body",
    "redact_query",
    "redact_value",
    "redacted",
    "register_format",
    "unregister_owner",
]
