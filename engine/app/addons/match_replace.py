"""Persistent automatic substitutions for proxied HTTP traffic."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Literal

from mitmproxy import http

from .. import charset
from ..db.store import FlowStore
from ..events import EventBroker
from ..request_history import remember_auto_modified, remember_original

Phase = Literal["request", "response"]
Target = Literal["url", "headers", "body"]
SETTING = "match_replace_rules"


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
        if target not in ("url", "headers", "body"):
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
                re.compile(self.match, self._flags())
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
        self._apply(flow, "response")

    def _apply(self, flow: http.HTTPFlow, phase: Phase) -> None:
        for rule in self.rules:
            if not rule.enabled or rule.phase != phase:
                continue
            if rule.target == "url":
                flow.request.url = rule.substitute(flow.request.pretty_url)
            elif rule.target == "headers":
                message = flow.request if phase == "request" else flow.response
                if message is not None:
                    _replace_headers(message.headers, rule)
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
                        raw = charset.encode(
                            replaced,
                            charset.charset_of(
                                message.headers.get("content-type"),
                                content,
                            ),
                        )
                        message.content = raw


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
