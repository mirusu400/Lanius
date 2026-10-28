"""Convert an allowlisted subset of Burp configuration JSON to Lanius.

Burp configuration files are intentionally treated as an external format.  A
configuration can contain credentials, client certificates, extension state,
scheduled tasks, and tool-specific automation.  None of those values cross
this boundary: only settings with a direct Lanius equivalent are converted.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .addons.match_replace import (
    PRESETS_VERSION,
    PRESETS_VERSION_SETTING,
    SETTING as MATCH_REPLACE_SETTING,
    MatchReplaceError,
    MatchReplaceRule,
)
from .addons.scope import RESTRICT_CAPTURE_KEY, ScopeError, ScopeRule
from .http_protocol import SETTING as HTTP_MODE_SETTING


BURP_ROOT_KEYS = frozenset(
    {"logger", "project_options", "proxy", "repeater", "sequencer", "target"}
)


@dataclass(slots=True)
class BurpImportPlan:
    """Validated changes to apply atomically to the current project."""

    scope: list[dict[str, Any]] | None = None
    settings: dict[str, str] = field(default_factory=dict)
    match_replace: int = 0
    listeners: int = 0
    skipped: int = 0
    warnings: list[str] = field(default_factory=list)


def is_burp_settings(value: Any) -> bool:
    """Whether a JSON object has the shape of a Burp settings export."""

    if not isinstance(value, dict) or value.get("format") == "lanius-project":
        return False
    found = BURP_ROOT_KEYS.intersection(value)
    return bool(found) and all(isinstance(value.get(key), dict) for key in found)


def convert_burp_settings(value: dict[str, Any]) -> BurpImportPlan:
    """Build a Lanius import plan without retaining unsupported Burp data."""

    if not is_burp_settings(value):
        raise ValueError("not a Burp settings file")

    plan = BurpImportPlan()
    touched = False

    target = _mapping(value.get("target"))
    if "scope" in target:
        touched = True
        plan.scope = _scope_rules(target.get("scope"), plan)

    proxy = _mapping(value.get("proxy"))
    if "match_replace_rules" in proxy:
        touched = True
        rules = _match_replace_rules(proxy.get("match_replace_rules"), plan)
        plan.match_replace = len(rules)
        plan.settings[MATCH_REPLACE_SETTING] = json.dumps(
            rules, ensure_ascii=False, separators=(",", ":")
        )
        plan.settings[PRESETS_VERSION_SETTING] = PRESETS_VERSION

    if "request_listeners" in proxy:
        touched = True
        listeners = _listeners(proxy.get("request_listeners"), plan)
        if listeners:
            primary = listeners[0]
            plan.listeners = len(listeners)
            plan.settings.update(
                {
                    "listen_host": primary["host"],
                    "listen_port": str(primary["port"]),
                    "proxy_listeners": json.dumps(
                        {
                            "version": 1,
                            "primary_id": primary["id"],
                            "listeners": listeners,
                        },
                        separators=(",", ":"),
                    ),
                }
            )

    miscellaneous = _mapping(proxy.get("miscellaneous"))
    capture_key = "disable_out_of_scope_logging_to_history_and_site_map"
    if isinstance(miscellaneous.get(capture_key), bool):
        touched = True
        plan.settings[RESTRICT_CAPTURE_KEY] = "1" if miscellaneous[capture_key] else "0"

    project_options = _mapping(value.get("project_options"))
    http = _mapping(project_options.get("http"))
    http2 = _mapping(http.get("http2"))
    use_http_10 = miscellaneous.get("use_http_10_in_requests_to_server")
    enable_http2 = http2.get("enable_http2")
    if use_http_10 is True:
        touched = True
        plan.settings[HTTP_MODE_SETTING] = "http1.0"
    elif isinstance(enable_http2, bool):
        touched = True
        # Burp's enabled mode negotiates h2 when available, which is Lanius's
        # Auto behavior.  Disabled Burp HTTP/2 maps to a forced HTTP/1.1 route.
        plan.settings[HTTP_MODE_SETTING] = "auto" if enable_http2 else "http1.1"

    connections = _mapping(project_options.get("connections"))
    socks = _mapping(connections.get("socks_proxy"))
    if isinstance(socks.get("use_proxy"), bool):
        touched = True
        _convert_socks(socks, plan)

    upstream = _mapping(connections.get("upstream_proxy"))
    servers = upstream.get("servers")
    if isinstance(servers, list) and servers:
        # Burp routes these by destination and can attach several credential
        # schemes.  Flattening them into Lanius's global chain would send
        # unrelated traffic to the wrong place.
        plan.skipped += len(servers)

    if not touched:
        raise ValueError("the Burp file contains no supported project settings")
    return plan


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _scope_rules(value: Any, plan: BurpImportPlan) -> list[dict[str, Any]]:
    block = _mapping(value)
    out: list[dict[str, Any]] = []
    include_count = 0
    for kind in ("include", "exclude"):
        entries = block.get(kind, [])
        if not isinstance(entries, list):
            plan.skipped += 1
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                plan.skipped += 1
                continue
            protocol = entry.get("protocol", "any")
            if protocol not in ("any", "http", "https"):
                plan.skipped += 1
                continue
            port = entry.get("port")
            if isinstance(port, bool) or (port is not None and not isinstance(port, int)):
                plan.skipped += 1
                continue
            try:
                rule = ScopeRule(
                    kind=kind,  # type: ignore[arg-type]
                    host=str(entry.get("host") or ".*"),
                    path=str(entry.get("file") or ".*"),
                    protocol=protocol,
                    port=port,
                    match_type="regex",
                    enabled=bool(entry.get("enabled", True)),
                )
            except ScopeError:
                plan.skipped += 1
                continue
            out.append(rule.as_dict())
            if kind == "include" and rule.enabled:
                include_count += 1

    # Burp's empty inclusion list means nothing is in target scope, whereas
    # Lanius intentionally treats no include rules as everything in scope.
    # A visible never-match rule preserves the imported meaning.
    if include_count == 0:
        out.insert(
            0,
            ScopeRule(
                kind="include",
                host=r"(?!)",
                path=r".*",
                protocol="any",
                match_type="regex",
                enabled=True,
            ).as_dict(),
        )
    return out


_MATCH_TARGETS: dict[str, tuple[str, str]] = {
    "request_header": ("request", "headers"),
    "response_header": ("response", "headers"),
    "request_body": ("request", "body"),
    "response_body": ("response", "body"),
    "request_first_line": ("request", "message"),
    "response_first_line": ("response", "message"),
    "request_line": ("request", "message"),
    "response_line": ("response", "message"),
}


def _match_replace_rules(value: Any, plan: BurpImportPlan) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        plan.skipped += 1
        return []
    out: list[dict[str, Any]] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, dict):
            plan.skipped += 1
            continue
        mapped = _MATCH_TARGETS.get(str(entry.get("rule_type") or ""))
        match = entry.get("string_match")
        if mapped is None or not isinstance(match, str) or not match:
            # Burp also supports blank matches that add headers.  Lanius's
            # substitution rules require an actual match and must not invent
            # a subtly different behavior during import.
            plan.skipped += 1
            continue
        phase, target = mapped
        regex = not bool(entry.get("is_simple_match", False))
        replacement = str(entry.get("string_replace") or "")
        if regex:
            replacement = _burp_regex_replacement(replacement)
        try:
            rule = MatchReplaceRule.from_dict(
                {
                    "id": f"burp-{index + 1}",
                    "name": str(entry.get("comment") or f"Burp rule {index + 1}"),
                    "enabled": bool(entry.get("enabled", True)),
                    "phase": phase,
                    "target": target,
                    "match": match,
                    "replace": replacement,
                    "regex": regex,
                    "case_sensitive": True,
                }
            )
        except MatchReplaceError:
            plan.skipped += 1
            continue
        out.append(rule.as_dict())
    return out


def _burp_regex_replacement(value: str) -> str:
    """Translate Java-style ``$1`` groups to Python ``re.sub`` syntax."""

    out: list[str] = []
    index = 0
    while index < len(value):
        character = value[index]
        if character == "\\":
            if index + 1 < len(value):
                literal = value[index + 1]
                # Only a backslash is special when emitted literally in a
                # Python replacement string. Java's \$ becomes a plain $.
                out.append("\\\\" if literal == "\\" else literal)
                index += 2
                continue
            out.append("\\\\")
        elif character == "$":
            cursor = index + 1
            while cursor < len(value) and value[cursor].isdigit():
                cursor += 1
            if cursor > index + 1:
                out.append(f"\\g<{value[index + 1:cursor]}>")
                index = cursor
                continue
            if cursor < len(value) and value[cursor] == "{":
                end = value.find("}", cursor + 1)
                if end != -1:
                    name = value[cursor + 1:end]
                    if name and all(part.isalnum() or part == "_" for part in name):
                        out.append(f"\\g<{name}>")
                        index = end + 1
                        continue
            out.append("$")
        else:
            out.append(character)
        index += 1
    return "".join(out)


def _listeners(value: Any, plan: BurpImportPlan) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        plan.skipped += 1
        return []
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for entry in value:
        if not isinstance(entry, dict) or not bool(entry.get("running", True)):
            continue
        port = entry.get("listener_port")
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            plan.skipped += 1
            continue
        mode = entry.get("listen_mode")
        if mode == "loopback_only":
            host = "127.0.0.1"
        elif mode == "all_interfaces":
            host = "0.0.0.0"
        elif mode == "specific_address":
            specific = next(
                (
                    entry.get(key)
                    for key in ("listen_specific_address", "listen_address", "listener_address")
                    if isinstance(entry.get(key), str) and entry.get(key)
                ),
                None,
            )
            if not isinstance(specific, str):
                plan.skipped += 1
                continue
            host = specific
        else:
            plan.skipped += 1
            continue
        identity = (host, port)
        if identity in seen:
            continue
        seen.add(identity)
        out.append({"id": f"burp-{len(out) + 1}", "host": host, "port": port})
    return out


def _convert_socks(value: dict[str, Any], plan: BurpImportPlan) -> None:
    if not value.get("use_proxy"):
        plan.settings["upstream_proxy_hops"] = "[]"
        return
    if value.get("username") or value.get("password"):
        plan.skipped += 1
        plan.warnings.append("SOCKS credentials were not imported")
        return
    host = value.get("host")
    port = value.get("port")
    if (
        not isinstance(host, str)
        or not host.strip()
        or any(character.isspace() for character in host)
        or isinstance(port, bool)
        or not isinstance(port, int)
        or not 1 <= port <= 65535
    ):
        plan.skipped += 1
        return
    address = host.strip()
    if ":" in address and not address.startswith("["):
        address = f"[{address}]"
    plan.settings["upstream_proxy_hops"] = json.dumps([f"socks5://{address}:{port}"])


__all__ = ["BurpImportPlan", "convert_burp_settings", "is_burp_settings"]
