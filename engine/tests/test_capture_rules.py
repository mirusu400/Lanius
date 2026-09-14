"""Capture rules: the list a user edits, and the spec it compiles to."""

from __future__ import annotations

import pytest

from app.capture_rules import rule_to_spec, rules_to_spec, spec_to_rules


def test_an_include_rule_is_its_own_value() -> None:
    assert rule_to_spec("chrome") == "chrome"


def test_an_exclude_rule_is_prefixed() -> None:
    assert rule_to_spec("Slack", "exclude") == "!Slack"


def test_a_path_is_a_rule_like_any_other() -> None:
    """Matching is on substrings of the executable path, so a directory
    captures everything installed under it."""
    assert rule_to_spec("/Applications/") == "/Applications/"


def test_a_rule_cannot_contain_the_separator() -> None:
    """A comma would silently split one rule into two."""
    with pytest.raises(ValueError):
        rule_to_spec("chrome,firefox")


def test_an_empty_rule_is_refused() -> None:
    with pytest.raises(ValueError):
        rule_to_spec("   ")


def test_rules_compile_to_one_spec() -> None:
    spec = rules_to_spec(
        [
            {"value": "chrome", "action": "include", "enabled": True},
            {"value": "/Applications/", "action": "include", "enabled": True},
            {"value": "Slack", "action": "exclude", "enabled": True},
        ]
    )
    assert spec == "chrome,/Applications/,!Slack"


def test_the_compiled_spec_is_one_the_redirector_accepts() -> None:
    """The point of the list is to produce something that actually runs."""
    from mitmproxy_rs.local import LocalRedirector

    spec = rules_to_spec(
        [
            {"value": "chrome", "action": "include", "enabled": True},
            {"value": "Slack", "action": "exclude", "enabled": True},
        ]
    )
    description = LocalRedirector.describe_spec(spec)
    assert "chrome" in description
    assert "Exclude" in description


def test_a_disabled_rule_is_kept_but_not_applied() -> None:
    """Switching a rule off should not lose what the user typed."""
    rules = [
        {"value": "chrome", "action": "include", "enabled": True},
        {"value": "firefox", "action": "include", "enabled": False},
    ]
    assert rules_to_spec(rules) == "chrome"


def test_blank_rules_are_skipped() -> None:
    rules = [
        {"value": "", "action": "include", "enabled": True},
        {"value": "chrome", "action": "include", "enabled": True},
    ]
    assert rules_to_spec(rules) == "chrome"


def test_an_empty_list_compiles_to_an_empty_spec() -> None:
    """Which means capture everything, not capture nothing."""
    assert rules_to_spec([]) == ""


def test_a_spec_reads_back_into_rules() -> None:
    """A spec set by hand, or by an older version, must still be editable."""
    rules = spec_to_rules("chrome,!Slack,/Applications/")
    assert [r["value"] for r in rules] == ["chrome", "Slack", "/Applications/"]
    assert [r["action"] for r in rules] == ["include", "exclude", "include"]


def test_reading_back_survives_untidy_spacing() -> None:
    rules = spec_to_rules(" chrome , ! Slack ")
    assert [r["value"] for r in rules] == ["chrome", "Slack"]


def test_an_absent_spec_reads_back_as_no_rules() -> None:
    assert spec_to_rules(None) == []
    assert spec_to_rules("") == []


def test_rules_survive_a_round_trip() -> None:
    original = [
        {"value": "chrome", "action": "include", "enabled": True},
        {"value": "Slack", "action": "exclude", "enabled": True},
    ]
    assert spec_to_rules(rules_to_spec(original)) == original
