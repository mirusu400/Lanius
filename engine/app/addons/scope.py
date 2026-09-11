"""Scope: persisted include/exclude rules restricting capture and tools.

A flow is in scope when it matches at least one enabled include rule and no
enabled exclude rule (Burp semantics). With no include rules everything is in
scope, so a fresh project still records traffic.
"""

from __future__ import annotations

import fnmatch
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

RuleKind = Literal["include", "exclude"]
MatchType = Literal["glob", "regex"]


class ScopeError(Exception):
    """Invalid scope rule (mapped to HTTP 4xx)."""


@dataclass(slots=True)
class ScopeRule:
    """One include/exclude rule.

    ``host`` and ``path`` are matched independently; an empty pattern means
    "any". ``protocol`` may be ``http``, ``https`` or ``any``.
    """

    id: int | None = None
    kind: RuleKind = "include"
    host: str = "*"
    path: str = "*"
    protocol: str = "any"
    port: int | None = None
    match_type: MatchType = "glob"
    enabled: bool = True

    def __post_init__(self) -> None:
        if self.kind not in ("include", "exclude"):
            raise ScopeError(f"invalid rule kind: {self.kind!r}")
        if self.match_type not in ("glob", "regex"):
            raise ScopeError(f"invalid match type: {self.match_type!r}")
        if self.protocol not in ("any", "http", "https"):
            raise ScopeError(f"invalid protocol: {self.protocol!r}")
        if self.match_type == "regex":
            for pattern in (self.host, self.path):
                try:
                    re.compile(pattern)
                except re.error as exc:
                    raise ScopeError(f"invalid regex {pattern!r}: {exc}") from exc

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "host": self.host,
            "path": self.path,
            "protocol": self.protocol,
            "port": self.port,
            "match_type": self.match_type,
            "enabled": self.enabled,
        }

    def matches(self, scheme: str, host: str, port: int | None, path: str) -> bool:
        if self.protocol != "any" and self.protocol != scheme:
            return False
        if self.port is not None and self.port != port:
            return False
        return _match(self.host, host, self.match_type) and _match(
            self.path, path, self.match_type
        )


def _match(pattern: str, value: str, match_type: MatchType) -> bool:
    if pattern in ("", "*"):
        return True
    if match_type == "regex":
        return re.search(pattern, value) is not None
    # Globs are matched case-insensitively; hosts and paths are compared as-is
    # otherwise, and `*` should also span `/` for convenience.
    return fnmatch.fnmatch(value.lower(), pattern.lower())


@dataclass(slots=True)
class Scope:
    """The active rule set."""

    rules: list[ScopeRule] = field(default_factory=list)
    restrict_capture: bool = False

    @property
    def includes(self) -> list[ScopeRule]:
        return [r for r in self.rules if r.kind == "include" and r.enabled]

    @property
    def excludes(self) -> list[ScopeRule]:
        return [r for r in self.rules if r.kind == "exclude" and r.enabled]

    def contains(
        self, scheme: str | None, host: str | None, port: int | None, path: str | None
    ) -> bool:
        scheme = (scheme or "http").lower()
        host = (host or "").lower()
        path = path or "/"
        for rule in self.excludes:
            if rule.matches(scheme, host, port, path):
                return False
        includes = self.includes
        if not includes:
            return True
        return any(rule.matches(scheme, host, port, path) for rule in includes)

    def contains_url(self, url: str) -> bool:
        parts = urlsplit(url)
        if not parts.scheme or not parts.hostname:
            raise ScopeError(f"invalid url: {url!r}")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"
        return self.contains(parts.scheme, parts.hostname, port, path)

    def as_dict(self) -> dict[str, Any]:
        return {
            "rules": [r.as_dict() for r in self.rules],
            "restrict_capture": self.restrict_capture,
        }


def rule_from_url(url: str, kind: RuleKind = "include", prefix: bool = True) -> ScopeRule:
    """Build a rule from a URL, as 'Add to scope' does in the UI."""
    parts = urlsplit(url)
    if not parts.scheme or not parts.hostname:
        raise ScopeError(f"invalid url: {url!r}")
    path = parts.path or "/"
    return ScopeRule(
        kind=kind,
        host=parts.hostname,
        path=f"{path.rstrip('/')}/*" if prefix else path,
        protocol=parts.scheme,
        port=parts.port,
    )


RESTRICT_CAPTURE_KEY = "scope.restrict_capture"


class ScopeManager:
    """Loads/persists scope rules and answers in-scope questions.

    Reads are served from an in-memory snapshot so the mitmproxy event loop
    never touches SQLite (codex.md §9).
    """

    def __init__(self, store: Any, broker: Any = None) -> None:
        self.store = store
        self.broker = broker
        self.scope = Scope()
        self.reload()

    def reload(self) -> Scope:
        rules = [ScopeRule(**row) for row in self.store.list_scope_rules()]
        restrict = self.store.get_setting(RESTRICT_CAPTURE_KEY, "0") == "1"
        self.scope = Scope(rules=rules, restrict_capture=restrict)
        return self.scope

    def _publish(self) -> None:
        if self.broker is not None:
            self.broker.publish("scope.changed", self.scope.as_dict())

    def add_rule(self, **fields: Any) -> ScopeRule:
        rule = ScopeRule(**fields)
        rule.id = self.store.add_scope_rule(rule.as_dict())
        self.reload()
        self._publish()
        return rule

    def update_rule(self, rule_id: int, **changes: Any) -> Scope:
        # Validate before persisting.
        current = next((r for r in self.scope.rules if r.id == rule_id), None)
        if current is None:
            raise ScopeError(f"rule {rule_id} not found")
        merged = {**current.as_dict(), **changes}
        merged.pop("id", None)
        ScopeRule(**merged)
        if not self.store.update_scope_rule(rule_id, changes):
            raise ScopeError(f"rule {rule_id} not found")
        self.reload()
        self._publish()
        return self.scope

    def delete_rule(self, rule_id: int) -> None:
        if not self.store.delete_scope_rule(rule_id):
            raise ScopeError(f"rule {rule_id} not found")
        self.reload()
        self._publish()

    def set_restrict_capture(self, enabled: bool) -> Scope:
        self.store.set_setting(RESTRICT_CAPTURE_KEY, "1" if enabled else "0")
        self.reload()
        self._publish()
        return self.scope

    # --- queries ----------------------------------------------------------
    def contains(
        self, scheme: str | None, host: str | None, port: int | None, path: str | None
    ) -> bool:
        return self.scope.contains(scheme, host, port, path)

    def should_capture(
        self, scheme: str | None, host: str | None, port: int | None, path: str | None
    ) -> bool:
        if not self.scope.restrict_capture:
            return True
        return self.contains(scheme, host, port, path)
