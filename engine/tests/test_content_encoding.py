from __future__ import annotations

import gzip

from mitmproxy.test import tflow, tutils

from app.addons.capture import flow_to_record
from app.addons.intercept import apply_edits, paused_payload
from app.addons.match_replace import MatchReplaceAddon
from app.addons.repeater import build_flow, render_raw
from app.db.store import FlowRecord, FlowStore
from app.events import EventBroker


def test_flow_detail_decompresses_content_encoding_only_when_enabled() -> None:
    compressed = gzip.compress(b'{"hello":"world"}')
    record = FlowRecord(
        id="gzip",
        request_headers=[
            ("Content-Type", "application/json"),
            ("Content-Encoding", "gzip"),
        ],
        request_body=compressed,
    )

    decoded = record.detail(auto_decompress=True)
    raw = record.detail(auto_decompress=False)

    assert decoded["request_body"] == '{"hello":"world"}'
    assert decoded["request_body_decoded"] is True
    assert decoded["request_content_encoding"] == "gzip"
    assert raw["request_body"] != decoded["request_body"]
    assert raw["request_body_decoded"] is False


def test_match_replace_edits_compressed_body_and_keeps_it_compressed() -> None:
    store = FlowStore()
    addon = MatchReplaceAddon(store, EventBroker())
    addon.replace_rules(
        [
            {
                "id": "body",
                "phase": "request",
                "target": "body",
                "match": "before",
                "replace": "after",
            }
        ]
    )
    flow = tflow.tflow(req=tutils.treq(content=gzip.compress(b"before")), resp=False)
    flow.request.headers["Content-Encoding"] = "gzip"

    addon.request(flow)

    assert gzip.decompress(flow.request.raw_content or b"") == b"after"
    record = flow_to_record(flow)
    assert record.auto_modified is True
    assert record.modified is True
    variants = record.detail(auto_decompress=True)["request_variants"]
    assert variants["original"]["body"] == "before"
    assert variants["auto_modified"]["body"] == "after"
    assert variants["modified"]["body"] == "after"
    store.close()


def test_intercept_displays_and_reencodes_compressed_body() -> None:
    flow = tflow.tflow(req=tutils.treq(content=gzip.compress(b"before")), resp=False)
    flow.request.headers["Content-Encoding"] = "gzip"

    payload = paused_payload(flow, "request", auto_decompress=True)
    assert payload["request_body"] == "before"

    apply_edits(
        flow,
        "request",
        {"request_body": "after"},
        body_is_decoded=True,
    )
    assert gzip.decompress(flow.request.raw_content or b"") == b"after"


def test_repeater_encodes_request_and_decodes_response() -> None:
    flow = build_flow(
        url="https://example.com/",
        method="POST",
        headers=[
            ["Content-Type", "text/plain"],
            ["Content-Encoding", "gzip"],
        ],
        body="hello",
        encode_content_body=True,
    )
    assert gzip.decompress(flow.request.raw_content or b"") == b"hello"

    record = FlowRecord(
        id="response",
        response_headers=[
            ("Content-Type", "text/plain"),
            ("Content-Encoding", "gzip"),
        ],
        response_body=gzip.compress(b"world"),
    )
    rendered = render_raw(record, auto_decompress=True)
    assert rendered["body"] == "world"
    assert rendered["body_decoded"] is True
