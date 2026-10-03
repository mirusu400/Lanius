from __future__ import annotations

import gzip

import pytest
from mitmproxy.test import tflow, tutils

from app.addons.match_replace import MatchReplaceAddon, MatchReplaceError, preview
from app.db.store import FlowStore
from app.events import EventBroker
from app.response_history import AUTO_MODIFIED as RESPONSE_AUTO_MODIFIED, ORIGINAL as RESPONSE_ORIGINAL


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
    assert flow.metadata[RESPONSE_ORIGINAL]["body"] == b"token-123"
    assert flow.metadata[RESPONSE_AUTO_MODIFIED]["body"] == b"redacted"


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


def test_entire_request_rewrites_start_line_and_across_header_body(addon) -> None:
    addon.replace_rules(
        [
            {"id": "line", "phase": "request", "target": "message", "match": "GET /old HTTP/1.1", "replace": "POST /new HTTP/1.1"},
            {"id": "body", "phase": "request", "target": "message", "match": "X-Token: old\r\n\r\nsecret", "replace": "X-Token: new\r\n\r\npublic"},
        ]
    )
    flow = tflow.tflow(req=tutils.treq(path=b"/old", content=b"secret"), resp=False)
    flow.request.headers["X-Token"] = "old"
    addon.request(flow)
    assert flow.request.method == "POST"
    assert flow.request.path == "/new"
    assert flow.request.headers["X-Token"] == "new"
    assert flow.request.content == b"public"
    assert flow.request.headers["content-length"] == "6"


def test_entire_response_rewrites_status_and_body(addon) -> None:
    addon.replace_rules(
        [{"id": "whole", "phase": "response", "target": "message", "match": "200 OK", "replace": "404 Missing"},
         {"id": "body", "phase": "response", "target": "message", "match": "before", "replace": "after"}]
    )
    flow = tflow.tflow(resp=tutils.tresp(content=b"before"))
    addon.response(flow)
    assert flow.response.status_code == 404
    assert flow.response.reason == "Missing"
    assert flow.response.content == b"after"


def test_entire_message_skips_invalid_live_change_but_preview_reports_it(addon) -> None:
    rule = {"id": "bad", "phase": "request", "target": "message", "match": "GET /old", "replace": "broken"}
    addon.replace_rules([rule])
    flow = tflow.tflow(req=tutils.treq(path=b"/old", content=b"secret"), resp=False)
    addon.request(flow)
    assert flow.request.method == "GET"
    assert flow.request.path == "/old"
    with pytest.raises(MatchReplaceError, match="invalid request line"):
        preview("GET /old HTTP/1.1\r\nHost: example.com\r\n\r\n", "request", [rule])


def test_preview_uses_unsaved_rules_without_changing_other_phase() -> None:
    raw = "GET /old HTTP/1.1\r\nHost: example.com\r\n\r\nsecret"
    rules = [
        {"phase": "request", "target": "url", "match": "/old", "replace": "/new"},
        {"phase": "request", "target": "message", "match": "secret", "replace": "public"},
        {"phase": "response", "target": "message", "match": "secret", "replace": "wrong"},
    ]
    result = preview(raw, "request", rules)
    assert result.startswith("GET /new HTTP/1.1")
    assert result.endswith("\r\n\r\npublic")
    assert "wrong" not in result


def test_invalid_regex_replacement_is_rejected(addon) -> None:
    with pytest.raises(MatchReplaceError, match="invalid regular expression"):
        addon.replace_rules(
            [{"phase": "request", "target": "message", "match": "plain", "replace": r"\1", "regex": True}]
        )


def test_entire_message_preserves_binary_body_when_only_header_changes(addon) -> None:
    addon.replace_rules(
        [{"phase": "request", "target": "message", "match": "X-Old: one", "replace": "X-New: two"}]
    )
    flow = tflow.tflow(req=tutils.treq(content=b"\xff\x00"), resp=False)
    flow.request.headers["X-Old"] = "one"
    addon.request(flow)
    assert flow.request.headers["X-New"] == "two"
    assert flow.request.content == b"\xff\x00"


def test_entire_message_reencodes_gzip_body(addon) -> None:
    addon.replace_rules(
        [{"phase": "request", "target": "message", "match": "before", "replace": "after"}]
    )
    flow = tflow.tflow(req=tutils.treq(content=gzip.compress(b"before")), resp=False)
    flow.request.headers["Content-Encoding"] = "gzip"
    addon.request(flow)
    assert gzip.decompress(flow.request.raw_content or b"") == b"after"
    assert flow.request.headers["content-length"] == str(len(flow.request.raw_content or b""))
