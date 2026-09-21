from __future__ import annotations

import pytest
from mitmproxy.test import tflow, tutils

from app.addons.match_replace import MatchReplaceAddon, MatchReplaceError
from app.db.store import FlowStore
from app.events import EventBroker


@pytest.fixture()
def addon(tmp_path) -> MatchReplaceAddon:
    return MatchReplaceAddon(FlowStore(tmp_path / "test.sqlite"), EventBroker())


def test_replaces_request_url_header_and_body(addon) -> None:
    addon.replace_rules(
        [
            {"id": "url", "phase": "request", "target": "url", "match": "/old", "replace": "/new"},
            {"id": "header", "phase": "request", "target": "headers", "match": "X-Old: one", "replace": "X-New: two"},
            {"id": "body", "phase": "request", "target": "body", "match": "secret", "replace": "public"},
        ]
    )
    flow = tflow.tflow(req=tutils.treq(path=b"/old", content=b"secret"), resp=False)
    flow.request.headers["X-Old"] = "one"
    addon.request(flow)
    assert flow.request.path == "/new"
    assert flow.request.headers["X-New"] == "two"
    assert "X-Old" not in flow.request.headers
    assert flow.request.content == b"public"


def test_response_regex_can_be_case_insensitive(addon) -> None:
    addon.replace_rules(
        [{"id": "r", "phase": "response", "target": "body", "match": "TOKEN-[0-9]+", "replace": "redacted", "regex": True, "case_sensitive": False}]
    )
    flow = tflow.tflow(resp=tutils.tresp(content=b"token-123"))
    addon.response(flow)
    assert flow.response.content == b"redacted"


def test_rules_persist(addon) -> None:
    addon.replace_rules(
        [{"id": "one", "name": "saved", "phase": "request", "target": "body", "match": "a", "replace": "b"}]
    )
    loaded = MatchReplaceAddon(addon.store, EventBroker())
    assert loaded.state()[0]["name"] == "saved"


def test_invalid_regex_is_rejected(addon) -> None:
    with pytest.raises(MatchReplaceError):
        addon.replace_rules(
            [{"id": "bad", "phase": "request", "target": "body", "match": "[", "replace": "", "regex": True}]
        )
