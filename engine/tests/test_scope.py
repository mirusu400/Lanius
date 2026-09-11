from __future__ import annotations

import pytest

from app.addons.scope import (
    Scope,
    ScopeError,
    ScopeManager,
    ScopeRule,
    rule_from_url,
)
from app.db.store import FlowStore


def rule(**kwargs) -> ScopeRule:
    return ScopeRule(**kwargs)


# --- matching semantics ---------------------------------------------------


def test_empty_scope_includes_everything() -> None:
    assert Scope().contains("https", "anything.com", 443, "/x") is True


def test_include_rule_limits_to_matching_hosts() -> None:
    scope = Scope(rules=[rule(host="target.com")])
    assert scope.contains("https", "target.com", 443, "/") is True
    assert scope.contains("https", "other.com", 443, "/") is False


def test_glob_host_wildcards() -> None:
    scope = Scope(rules=[rule(host="*.target.com")])
    assert scope.contains("https", "api.target.com", 443, "/") is True
    assert scope.contains("https", "target.com", 443, "/") is False


def test_path_glob_limits_scope() -> None:
    scope = Scope(rules=[rule(host="t.com", path="/api/*")])
    assert scope.contains("https", "t.com", 443, "/api/users") is True
    assert scope.contains("https", "t.com", 443, "/static/a.js") is False


def test_exclude_beats_include() -> None:
    scope = Scope(
        rules=[
            rule(host="t.com"),
            rule(kind="exclude", host="t.com", path="/logout*"),
        ]
    )
    assert scope.contains("https", "t.com", 443, "/api") is True
    assert scope.contains("https", "t.com", 443, "/logout") is False


def test_exclude_only_still_allows_the_rest() -> None:
    scope = Scope(rules=[rule(kind="exclude", host="ads.com")])
    assert scope.contains("https", "ads.com", 443, "/") is False
    assert scope.contains("https", "app.com", 443, "/") is True


def test_disabled_rules_are_ignored() -> None:
    scope = Scope(rules=[rule(host="t.com", enabled=False)])
    assert scope.contains("https", "other.com", 443, "/") is True


def test_protocol_and_port_constraints() -> None:
    scope = Scope(rules=[rule(host="t.com", protocol="https", port=8443)])
    assert scope.contains("https", "t.com", 8443, "/") is True
    assert scope.contains("http", "t.com", 8443, "/") is False
    assert scope.contains("https", "t.com", 443, "/") is False


def test_regex_matching() -> None:
    scope = Scope(
        rules=[rule(host=r"^(api|www)\.t\.com$", path=r"/v\d+/", match_type="regex")]
    )
    assert scope.contains("https", "api.t.com", 443, "/v2/users") is True
    assert scope.contains("https", "cdn.t.com", 443, "/v2/users") is False
    assert scope.contains("https", "api.t.com", 443, "/beta/users") is False


def test_host_matching_is_case_insensitive() -> None:
    scope = Scope(rules=[rule(host="Target.COM")])
    assert scope.contains("https", "target.com", 443, "/") is True


def test_invalid_rules_are_rejected() -> None:
    with pytest.raises(ScopeError):
        ScopeRule(kind="maybe")
    with pytest.raises(ScopeError):
        ScopeRule(match_type="fuzzy")
    with pytest.raises(ScopeError):
        ScopeRule(protocol="ftp")
    with pytest.raises(ScopeError):
        ScopeRule(host="(unclosed", match_type="regex")


def test_contains_url() -> None:
    scope = Scope(rules=[rule(host="t.com", path="/api/*")])
    assert scope.contains_url("https://t.com/api/x?y=1") is True
    assert scope.contains_url("https://t.com/other") is False
    with pytest.raises(ScopeError):
        scope.contains_url("nonsense")


def test_rule_from_url_builds_a_prefix_rule() -> None:
    built = rule_from_url("https://api.t.com:8443/v1/users")
    assert built.host == "api.t.com"
    assert built.path == "/v1/users/*"
    assert built.protocol == "https"
    assert built.port == 8443

    exact = rule_from_url("https://t.com/only", prefix=False)
    assert exact.path == "/only"


# --- manager persistence --------------------------------------------------


@pytest.fixture()
def manager(tmp_path):
    store = FlowStore(tmp_path / "s.sqlite")
    yield ScopeManager(store)
    store.close()


def test_manager_starts_empty(manager) -> None:
    assert manager.scope.rules == []
    assert manager.contains("https", "any.com", 443, "/") is True


def test_manager_persists_rules(tmp_path) -> None:
    store = FlowStore(tmp_path / "p.sqlite")
    manager = ScopeManager(store)
    manager.add_rule(host="t.com", path="/api/*")
    store.close()

    reopened = FlowStore(tmp_path / "p.sqlite")
    restored = ScopeManager(reopened)
    assert len(restored.scope.rules) == 1
    assert restored.contains("https", "t.com", 443, "/api/x") is True
    assert restored.contains("https", "t.com", 443, "/x") is False
    reopened.close()


def test_manager_update_and_delete(manager) -> None:
    added = manager.add_rule(host="t.com")
    assert manager.contains("https", "other.com", 443, "/") is False

    manager.update_rule(added.id, enabled=False)
    assert manager.contains("https", "other.com", 443, "/") is True

    manager.delete_rule(added.id)
    assert manager.scope.rules == []


def test_manager_rejects_unknown_rule_ids(manager) -> None:
    with pytest.raises(ScopeError):
        manager.update_rule(999, enabled=False)
    with pytest.raises(ScopeError):
        manager.delete_rule(999)


def test_manager_validates_updates_before_saving(manager) -> None:
    added = manager.add_rule(host="t.com")
    with pytest.raises(ScopeError):
        manager.update_rule(added.id, match_type="fuzzy")
    # unchanged
    assert manager.scope.rules[0].match_type == "glob"


def test_restrict_capture_is_persisted(tmp_path) -> None:
    store = FlowStore(tmp_path / "c.sqlite")
    ScopeManager(store).set_restrict_capture(True)
    store.close()

    reopened = FlowStore(tmp_path / "c.sqlite")
    manager = ScopeManager(reopened)
    assert manager.scope.restrict_capture is True
    reopened.close()


def test_should_capture_respects_restriction(manager) -> None:
    manager.add_rule(host="t.com")
    assert manager.should_capture("https", "other.com", 443, "/") is True
    manager.set_restrict_capture(True)
    assert manager.should_capture("https", "other.com", 443, "/") is False
    assert manager.should_capture("https", "t.com", 443, "/") is True


def test_manager_publishes_changes(tmp_path) -> None:
    from app.events import EventBroker

    store = FlowStore(tmp_path / "b.sqlite")
    broker = EventBroker()
    queue = broker.subscribe()
    manager = ScopeManager(store, broker)
    manager.add_rule(host="t.com")
    event = queue.get_nowait()
    assert event["type"] == "scope.changed"
    assert event["data"]["rules"][0]["host"] == "t.com"
    store.close()
