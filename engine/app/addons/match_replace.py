"""Persistent automatic substitutions for proxied HTTP traffic."""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Literal, cast

from mitmproxy import http
from mitmproxy.connection import Client, Server

from .. import charset
from ..db.store import FlowStore
from ..events import EventBroker
from ..request_history import remember_auto_modified, remember_original
from ..response_history import (
    AUTO_MODIFIED as RESPONSE_AUTO_MODIFIED,
    ORIGINAL as RESPONSE_ORIGINAL,
    remember_auto_modified as remember_response_auto_modified,
    remember_original as remember_response_original,
)

Phase = Literal["request", "response"]
Target = Literal["url", "headers", "body", "message"]
SETTING = "match_replace_rules"
logger = logging.getLogger(__name__)


class MatchReplaceError(ValueError):
    """A rule cannot be compiled or has an unsupported shape."""


@dataclass(slots=True)
class MatchReplaceRule:
    id: str
    name: str = ""
    enabled: bool = True
    phase: Phase = "request"
    target: Target = "body"
    match: str = ""
    replace: str = ""
    regex: bool = False
    case_sensitive: bool = True

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "MatchReplaceRule":
        phase = value.get("phase", "request")
        target = value.get("target", "body")
        if phase not in ("request", "response"):
            raise MatchReplaceError(f"unsupported phase: {phase!r}")
        if target not in ("url", "headers", "body", "message"):
            raise MatchReplaceError(f"unsupported target: {target!r}")
        rule = cls(
            id=str(value.get("id") or uuid.uuid4()),
            name=str(value.get("name") or ""),
            enabled=bool(value.get("enabled", True)),
            phase=phase,
            target=target,
            match=str(value.get("match") or ""),
            replace=str(value.get("replace") or ""),
            regex=bool(value.get("regex", False)),
            case_sensitive=bool(value.get("case_sensitive", True)),
        )
        rule.validate()
        return rule

    def validate(self) -> None:
        if not self.match:
            raise MatchReplaceError("match must not be empty")
        if self.phase == "response" and self.target == "url":
            raise MatchReplaceError("URL rules only apply to requests")
        if self.regex:
            try:
                re.compile(self.match, self._flags()).sub(self.replace, "")
            except re.error as exc:
                raise MatchReplaceError(f"invalid regular expression: {exc}") from exc

    def _flags(self) -> int:
        return 0 if self.case_sensitive else re.IGNORECASE

    def substitute(self, value: str) -> str:
        if self.regex:
            return re.sub(self.match, self.replace, value, flags=self._flags())
        if self.case_sensitive:
            return value.replace(self.match, self.replace)
        return re.sub(re.escape(self.match), lambda _m: self.replace, value, flags=re.I)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class MatchReplaceAddon:
    """Applies user rules before interception and capture see a flow."""

    def __init__(self, store: FlowStore, broker: EventBroker) -> None:
        self.store = store
        self.broker = broker
        self.rules: list[MatchReplaceRule] = []
        self.reload()

    def reload(self) -> list[dict[str, Any]]:
        raw = self.store.get_setting(SETTING)
        if not raw:
            self.rules = []
            return []
        try:
            values = json.loads(raw)
            self.rules = [MatchReplaceRule.from_dict(item) for item in values]
        except (json.JSONDecodeError, TypeError, MatchReplaceError):
            self.rules = []
        return self.state()

    def state(self) -> list[dict[str, Any]]:
        return [rule.as_dict() for rule in self.rules]

    def replace_rules(self, values: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rules = [MatchReplaceRule.from_dict(value) for value in values]
        self.rules = rules
        state = self.state()
        self.store.set_setting(SETTING, json.dumps(state, ensure_ascii=False))
        self.broker.publish("match_replace.changed", {"rules": state})
        return state

    def request(self, flow: http.HTTPFlow) -> None:
        remember_original(flow)
        try:
            self._apply(flow, "request")
        finally:
            # Even with no matching rule this is the boundary between the
            # automatic stage and edits made in Intercept/plugins later.
            remember_auto_modified(flow)

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.response is None or not any(
            rule.enabled and rule.phase == "response" for rule in self.rules
        ):
            self._apply(flow, "response")
            return
        remember_response_original(flow)
        try:
            self._apply(flow, "response")
        finally:
            remember_response_auto_modified(flow)
            if flow.metadata.get(RESPONSE_ORIGINAL) == flow.metadata.get(RESPONSE_AUTO_MODIFIED):
                # Most responses do not match a rule. Keep their bodies once.
                flow.metadata.pop(RESPONSE_ORIGINAL, None)
                flow.metadata.pop(RESPONSE_AUTO_MODIFIED, None)

    def _apply(self, flow: http.HTTPFlow, phase: Phase) -> None:
        apply_rules(flow, phase, self.rules)


def apply_rules(
    flow: http.HTTPFlow,
    phase: Phase,
    rules: list[MatchReplaceRule],
    *,
    strict: bool = False,
) -> None:
    """Shared by live traffic and the unsaved-rule preview."""
    for rule in rules:
        if not rule.enabled or rule.phase != phase:
            continue
        if rule.target == "url":
            flow.request.url = rule.substitute(flow.request.pretty_url)
        elif rule.target == "headers":
            message = flow.request if phase == "request" else flow.response
            if message is not None:
                _replace_headers(message.headers, rule)
        elif rule.target == "message":
            message = flow.request if phase == "request" else flow.response
            if message is not None and message.raw_content is not None:
                raw = render_message(message, phase)
                replaced = rule.substitute(raw)
                if replaced != raw:
                    try:
                        updated = parse_message(message, phase, replaced)
                    except (MatchReplaceError, ValueError, UnicodeError, TypeError) as exc:
                        if strict:
                            raise MatchReplaceError(str(exc)) from exc
                        logger.warning("skipping invalid whole-message replacement: %s", exc)
                        continue
                    if phase == "request":
                        assert isinstance(updated, http.Request)
                        flow.request = updated
                    else:
                        assert isinstance(updated, http.Response)
                        flow.response = updated
        else:
            message = flow.request if phase == "request" else flow.response
            if message is not None and message.raw_content is not None:
                # ``content`` is the logical, uncompressed body. Setting it
                # asks mitmproxy to reapply Content-Encoding and fix the
                # length, so a gzip request remains a valid gzip request.
                content = message.get_content(strict=False)
                text = charset.decode_body(
                    message.headers.get("content-type"), content
                )
                replaced = rule.substitute(text)
                if replaced != text:
                    encoded = charset.encode(
                        replaced,
                        charset.charset_of(
                            message.headers.get("content-type"),
                            content,
                        ),
                    )
                    message.content = encoded


def render_message(message: http.Message, phase: Phase) -> str:
    """A readable full HTTP message, with the logical decoded body."""
    if phase == "request":
        assert isinstance(message, http.Request)
        start = f"{message.method} {message.path} {message.http_version}"
    else:
        assert isinstance(message, http.Response)
        start = f"{message.http_version} {message.status_code} {message.reason}".rstrip()
    headers = "\r\n".join(f"{name}: {value}" for name, value in message.headers.items(multi=True))
    content = message.get_content(strict=False) or b""
    body = charset.decode_body(message.headers.get("content-type"), content)
    head = f"{start}\r\n{headers}" if headers else start
    return f"{head}\r\n\r\n{body}"


def parse_message(
    message: http.Message, phase: Phase, raw: str
) -> http.Message:
    """Parse a replacement into a copy, leaving live traffic intact on error."""
    normalized = raw.replace("\r\n", "\n")
    head, separator, body = normalized.partition("\n\n")
    lines = head.split("\n")
    start = lines[0].strip()
    if phase == "request":
        parts = start.split()
        if len(parts) != 3 or not parts[2].startswith("HTTP/"):
            raise MatchReplaceError("invalid request line after replacement")
    else:
        parts = start.split(maxsplit=2)
        if len(parts) < 2 or not parts[0].startswith("HTTP/"):
            raise MatchReplaceError("invalid response status line after replacement")
        try:
            status = int(parts[1])
        except ValueError as exc:
            raise MatchReplaceError("invalid response status after replacement") from exc
        if not 100 <= status <= 999:
            raise MatchReplaceError("invalid response status after replacement")

    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        if not line:
            continue
        name, colon, value = line.partition(":")
        if not colon or not name.strip():
            raise MatchReplaceError("invalid header after replacement")
        headers.append((name.strip(), value.lstrip()))

    updated = message.copy()
    updated.headers.clear()
    for name, value in headers:
        updated.headers.add(name, value)
    if phase == "request":
        assert isinstance(updated, http.Request)
        updated.method = parts[0]
        if parts[1].startswith(("http://", "https://")):
            updated.url = parts[1]
        else:
            updated.path = parts[1]
        updated.http_version = parts[2]
    else:
        assert isinstance(updated, http.Response)
        updated.http_version = parts[0]
        updated.status_code = status
        updated.reason = parts[2] if len(parts) > 2 else ""
    body_text = body if separator else ""
    original_content = message.get_content(strict=False) or b""
    original_encoding = charset.charset_of(
        message.headers.get("content-type"), original_content
    )
    original_text = charset.decode_body(
        message.headers.get("content-type"), original_content
    )
    if body_text == original_text:
        # A header-only change must preserve binary bodies byte for byte.
        body_bytes = original_content
    else:
        if charset.encode(original_text, original_encoding) != original_content:
            raise MatchReplaceError("cannot rewrite a binary body as text")
        body_bytes = charset.encode(
            body_text, charset.charset_of(updated.headers.get("content-type"), None)
        )
    updated.content = body_bytes
    if "content-length" in updated.headers:
        updated.headers["content-length"] = str(len(updated.raw_content or b""))
    return updated


def preview(raw: str, phase: str, values: list[dict[str, Any]]) -> str:
    """Apply unsaved rules to an example without sending or recording it."""
    if phase not in ("request", "response"):
        raise MatchReplaceError(f"unsupported phase: {phase!r}")
    selected = cast(Phase, phase)
    rules = [MatchReplaceRule.from_dict(value) for value in values]
    client = Client(peername=("127.0.0.1", 0), sockname=("127.0.0.1", 0))
    server = Server(address=("preview.local", 80))
    flow = http.HTTPFlow(client, server)
    if selected == "request":
        flow.request = http.Request.make("GET", "http://preview.local/")
        request = parse_message(flow.request, "request", raw)
        assert isinstance(request, http.Request)
        flow.request = request
    else:
        flow.request = http.Request.make("GET", "http://preview.local/")
        flow.response = http.Response.make(200, b"")
        response = parse_message(flow.response, "response", raw)
        assert isinstance(response, http.Response)
        flow.response = response
    message = flow.request if selected == "request" else flow.response
    assert message is not None
    before = render_message(message, selected)
    apply_rules(flow, selected, rules, strict=True)
    message = flow.request if selected == "request" else flow.response
    assert message is not None
    after = render_message(message, selected)
    return raw if before == after else after


def _replace_headers(headers: Any, rule: MatchReplaceRule) -> None:
    original = list(headers.items(multi=True))
    changed = False
    result: list[tuple[str, str]] = []
    for name, value in original:
        line = f"{name}: {value}"
        replaced = rule.substitute(line)
        if replaced != line:
            changed = True
        if not replaced.strip():
            continue
        if ":" in replaced:
            next_name, next_value = replaced.split(":", 1)
            result.append((next_name.strip(), next_value.lstrip()))
        else:
            result.append((name, replaced))
    if changed:
        headers.clear()
        for name, value in result:
            headers.add(name, value)


__all__ = ["MatchReplaceAddon", "MatchReplaceError", "MatchReplaceRule"]
