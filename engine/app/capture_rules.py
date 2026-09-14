"""Capture rules: a list the user edits, compiled to one intercept spec.

The redirector takes a single comma-separated string, which is awkward to
edit by hand once there is more than one entry. These helpers let the UI
hold a list of rules and turn it into that string.

Matching is on substrings of the executable path, so "chrome" catches
Google Chrome and "/Applications/" catches everything installed there.
"""

from __future__ import annotations

from typing import Any, Literal

RuleAction = Literal["include", "exclude"]


def rule_to_spec(value: str, action: RuleAction = "include") -> str:
    """One rule as the redirector spells it."""
    value = value.strip()
    if not value:
        raise ValueError("a rule needs a value")
    if "," in value:
        # The spec separator, so it would silently split into two rules.
        raise ValueError("a rule cannot contain a comma")
    return f"!{value}" if action == "exclude" else value


def rules_to_spec(rules: list[dict[str, Any]]) -> str:
    """The whole list as one intercept spec.

    Disabled rules are kept in the list but left out of the spec, so a
    user can switch one off without losing what they typed.
    """
    parts = [
        rule_to_spec(str(rule.get("value", "")), rule.get("action", "include"))
        for rule in rules
        if rule.get("enabled", True) and str(rule.get("value", "")).strip()
    ]
    return ",".join(parts)


def spec_to_rules(spec: str | None) -> list[dict[str, Any]]:
    """Read a spec back into a list, so a hand-written one still edits."""
    if not spec:
        return []
    rules: list[dict[str, Any]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        exclude = part.startswith("!")
        rules.append(
            {
                "value": part[1:].strip() if exclude else part,
                "action": "exclude" if exclude else "include",
                "enabled": True,
            }
        )
    return rules
