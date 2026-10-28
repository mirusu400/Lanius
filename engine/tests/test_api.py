from __future__ import annotations

import socket
import time
import gzip
import json
import sqlite3
from urllib.parse import quote

from unittest import mock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.server import FLOW_BODY_PREVIEW_BYTES, create_app, redact_headers
from app.config import Settings
from app.db.store import FlowRecord
from app.lockdown import PROJECT_SETTING, SCOPE_EGRESS_SETTING
from app.tls_trust import TRUSTED_CA_SETTING
from .test_database_import import make_backup


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "test.sqlite",
        confdir=tmp_path / "mitm",
    )
    # Local capture depends on host privileges on Windows/Linux. API tests
    # exercise configuration semantics, not the CI runner's privilege level.
    with (
        mock.patch("app.proxy._local_redirector_unavailable_reason", return_value=None),
        mock.patch("app.proxy.LOCAL_CAPTURE_SETTLE_SECONDS", 0),
    ):
        app = create_app(settings)
        with TestClient(app) as c:
            yield c


def seed(client, flow_id: str, **kwargs) -> None:
    base = dict(
        id=flow_id,
        method="GET",
        host="example.com",
        path="/a",
        started_at=time.time(),
        status_code=200,
        request_headers=[("Cookie", "session=secret"), ("Accept", "*/*")],
        response_headers=[("Set-Cookie", "a=b"), ("Content-Type", "text/html")],
        response_body=b"body",
    )
    base.update(kwargs)
    client.app.state.store.upsert(FlowRecord(**base))


def test_status_reports_running_proxy(client) -> None:
    data = client.get("/api/status").json()
    assert data["proxy"]["running"] is True
    assert data["flows"] == 0
    assert data["capture_writer"]["dropped"] == 0
    assert data["capture_writer"]["queue_capacity"] > 0


def test_list_flows_empty(client) -> None:
    assert client.get("/api/flows").json() == {
        "items": [], "count": 0, "has_more": False,
        "anchor": 0, "next_cursor": None,
    }


def test_text_response_preview_includes_syntax_metadata(client) -> None:
    seed(client, "script", path="/assets/app.js", response_headers=[("Content-Type", "text/plain")],
         response_body=b"const value = 1;")
    assert client.get("/api/flows/script/response-preview").json() == {
        "kind": "text", "text": "const value = 1;", "mime": "text/plain", "path": "/assets/app.js",
    }


def test_flow_body_charsets_can_be_overridden_independently(client) -> None:
    request_text = "요청 본문"
    response_text = "日本語の応答"
    seed(
        client,
        "legacy",
        request_headers=[("Content-Type", "text/plain")],
        request_body=request_text.encode("utf-16-le"),
        response_headers=[("Content-Type", "text/html")],
        response_body=response_text.encode("shift_jis"),
    )

    data = client.get(
        "/api/flows/legacy?request_charset=utf-16-le&response_charset=shift_jis"
    ).json()
    assert data["request_body"] == request_text
    assert data["response_body"] == response_text
    assert data["request_charset"] == "utf-16-le"
    assert data["response_charset"] == "shift_jis"


def test_flow_detail_repairs_double_encoded_utf8_response_only_when_requested(client) -> None:
    text = "<title>한국동서발전</title>"
    double_encoded = text.encode("utf-8").decode("latin-1").encode("utf-8")
    seed(
        client,
        "double-utf8",
        request_headers=[("Content-Type", "text/html; charset=utf-8")],
        request_body=double_encoded,
        response_headers=[("Content-Type", "text/html; charset=utf-8")],
        response_body=double_encoded,
    )

    data = client.get("/api/flows/double-utf8").json()
    assert data["response_body"] != text
    assert data["response_body_mojibake_detected"] is True
    assert data["response_body_mojibake_repaired"] is False
    # Requests are editable and must not be silently rewritten on Replay.
    assert data["request_body"] != text

    repaired = client.get(
        "/api/flows/double-utf8?repair_response_mojibake=true"
    ).json()
    assert repaired["response_body"] == text
    assert repaired["response_body_mojibake_repaired"] is True

    preview = client.get(
        "/api/flows/double-utf8/response-preview?repair_mojibake=true"
    ).json()
    assert preview == {"kind": "html", "text": text}


def test_flow_detail_replaces_only_the_invalid_utf8_sequence(client) -> None:
    raw = b"<p>" + "한글".encode("utf-8") + b"</p>\xff"
    seed(
        client,
        "mixed-utf8",
        response_headers=[("Content-Type", "text/html; charset=utf-8")],
        response_body=raw,
    )

    data = client.get("/api/flows/mixed-utf8").json()
    assert data["response_body"] == "<p>한글</p>�"
    assert data["response_body_decode_had_errors"] is True


def test_flow_detail_reads_bounded_body_chunks_and_keeps_total_size(client) -> None:
    body = b"a" * FLOW_BODY_PREVIEW_BYTES + b"second chunk"
    seed(
        client,
        "large-text",
        response_headers=[("Content-Type", "text/plain; charset=utf-8")],
        response_body=body,
        response_size=len(body),
    )

    detail = client.get("/api/flows/large-text").json()
    assert detail["response_body"] == "a" * FLOW_BODY_PREVIEW_BYTES
    assert detail["response_body_captured_size"] == len(body)
    assert detail["response_body_preview_size"] == FLOW_BODY_PREVIEW_BYTES
    assert detail["response_body_truncated"] is True
    assert detail["response_body_chunkable"] is True

    chunk = client.get(
        f"/api/flows/large-text/body/response/preview?offset={FLOW_BODY_PREVIEW_BYTES}"
    ).json()
    assert chunk == {
        "text": "second chunk",
        "charset": "utf-8",
        "offset": FLOW_BODY_PREVIEW_BYTES,
        "next_offset": len(body),
        "total_bytes": len(body),
        "truncated": False,
    }


def test_body_chunk_endpoint_distinguishes_no_response_from_an_empty_body(client) -> None:
    seed(client, "no-response", response_headers=None, response_body=None)
    seed(client, "empty-response", response_headers=[], response_body=b"")

    assert client.get("/api/flows/no-response/body/response/preview").status_code == 404
    empty = client.get("/api/flows/empty-response/body/response/preview")
    assert empty.status_code == 200
    assert empty.json()["text"] == ""


def test_flow_preview_and_chunks_split_on_character_boundaries(client) -> None:
    # 3-byte characters: the 256 KiB boundary falls inside one of them.
    body = ("가" * 200_000).encode("utf-8")
    seed(
        client,
        "korean",
        response_headers=[("Content-Type", "text/plain; charset=utf-8")],
        response_body=body,
    )

    detail = client.get("/api/flows/korean").json()
    assert detail["response_charset"] == "utf-8"
    preview_size = detail["response_body_preview_size"]
    assert preview_size % 3 == 0 and preview_size <= FLOW_BODY_PREVIEW_BYTES
    assert detail["response_body"] == "가" * (preview_size // 3)

    text = detail["response_body"]
    offset = preview_size
    while True:
        chunk = client.get(
            f"/api/flows/korean/body/response/preview?offset={offset}"
        ).json()
        text += chunk["text"]
        offset = chunk["next_offset"]
        if not chunk["truncated"]:
            break
    assert text == "가" * 200_000


def test_flow_preview_shows_prefix_of_large_compressed_body(client) -> None:
    decoded = b'{"a":1}' * 100_000
    seed(
        client,
        "gzip-large",
        response_headers=[
            ("Content-Type", "application/json"),
            ("Content-Encoding", "gzip"),
        ],
        response_body=gzip.compress(decoded),
    )

    detail = client.get("/api/flows/gzip-large").json()
    assert detail["response_body_decoded"] is True
    assert detail["response_decode_error"] is None
    assert detail["response_body"] == decoded[:FLOW_BODY_PREVIEW_BYTES].decode()
    assert detail["response_body_truncated"] is True
    assert detail["response_body_chunkable"] is False


def test_flow_preview_reports_corrupt_compressed_body(client) -> None:
    seed(
        client,
        "gzip-corrupt",
        response_headers=[("Content-Type", "text/plain"), ("Content-Encoding", "gzip")],
        response_body=b"\x1f\x8bnot gzip",
    )

    response = client.get("/api/flows/gzip-corrupt")
    assert response.status_code == 200
    assert response.json()["response_decode_error"]


def test_replay_request_endpoint_does_not_use_full_flow_reader(client) -> None:
    seed(
        client,
        "request-only",
        request_body=b"x=1",
        response_body=b"response that must not be selected",
    )
    with mock.patch.object(
        client.app.state.store, "get", side_effect=AssertionError("full reader used")
    ):
        detail = client.get(
            "/api/flows/request-only/replay-request?reveal=true"
        ).json()
    assert detail["request_body"] == "x=1"
    assert detail["response_body"] is None
    assert ["Cookie", "session=secret"] in detail["request_headers"]


def test_replay_request_rejects_encoded_body_that_exceeds_editor_budget(client) -> None:
    compressed = gzip.compress(b"x" * (17 * 1024 * 1024))
    seed(
        client,
        "compressed-request",
        request_headers=[
            ("Content-Type", "text/plain"),
            ("Content-Encoding", "gzip"),
        ],
        request_body=compressed,
    )

    response = client.get("/api/flows/compressed-request/replay-request")

    assert response.status_code == 413
    assert "cannot be opened safely" in response.json()["detail"]


def test_flow_body_charset_rejects_non_text_codecs(client) -> None:
    seed(client, "legacy")
    response = client.get("/api/flows/legacy?response_charset=base64_codec")
    assert response.status_code == 422
    assert response.json()["detail"] == "unsupported charset"


def test_response_preview_uses_the_selected_charset(client) -> None:
    text = "<p>日本語の応答</p>"
    seed(
        client,
        "legacy-preview",
        response_headers=[("Content-Type", "text/html")],
        response_body=text.encode("shift_jis"),
    )

    preview = client.get(
        "/api/flows/legacy-preview/response-preview?charset=shift_jis"
    ).json()
    assert preview == {"kind": "html", "text": text}


def test_list_and_filter_flows(client) -> None:
    seed(client, "a", host="a.com")
    seed(client, "b", host="b.com", method="POST")
    items = client.get("/api/flows").json()["items"]
    assert len(items) == 2
    assert client.get("/api/flows?method=POST").json()["items"][0]["id"] == "b"
    assert client.get("/api/flows?host=a.com").json()["count"] == 1
    assert [item["request_number"] for item in items] == [2, 1]


def test_history_annotations_survive_capture_and_project_roundtrip(client) -> None:
    seed(client, "marked", started_at=2)
    seed(client, "plain", started_at=1)
    plain = client.get("/api/flows/plain")
    assert plain.status_code == 200
    assert plain.json()["bookmarked"] is False
    assert plain.json()["annotation_color"] is None
    response = client.patch(
        "/api/flows/marked/annotation",
        json={"bookmarked": True, "annotation_color": "blue"},
    )
    assert response.status_code == 200
    assert response.json() == {"id": "marked", "bookmarked": True, "annotation_color": "blue"}
    assert [flow["id"] for flow in client.get(
        "/api/flows?bookmarked_only=true&annotation_color=blue"
    ).json()["items"]] == ["marked"]

    # A late response writes the capture row again; it must leave user marks intact.
    seed(client, "marked", started_at=2, status_code=404)
    marked = client.get("/api/flows/marked").json()
    assert (marked["bookmarked"], marked["annotation_color"], marked["status_code"]) == (
        True, "blue", 404
    )
    exported = client.get("/api/project/export").json()
    assert next(flow for flow in exported["flows"] if flow["id"] == "marked")["annotation_color"] == "blue"

    assert client.post("/api/project/import", json=exported).status_code == 200
    assert client.get("/api/flows?bookmarked_only=true").json()["items"][0]["id"] == "marked"
    assert client.patch("/api/flows/marked/annotation", json={"annotation_color": None}).json() == {
        "id": "marked", "bookmarked": True, "annotation_color": None
    }
    assert client.patch("/api/flows/marked/annotation", json={"bookmarked": False}).status_code == 200
    assert client.get("/api/flows?bookmarked_only=true").json()["items"] == []
    assert client.app.state.store.all_annotations() == {}


def test_history_annotation_validation_and_delete_cleanup(client) -> None:
    seed(client, "marked")
    for payload in ({"bookmarked": "yes"}, {"annotation_color": "pink"}, {}, {"unknown": 1}):
        assert client.patch("/api/flows/marked/annotation", json=payload).status_code == 422
    assert client.patch("/api/flows/missing/annotation", json={"bookmarked": True}).status_code == 404
    bookmarked = client.patch(
        "/api/flows/marked/annotation", json={"bookmarked": True}
    )
    assert bookmarked.json()["annotation_color"] == "yellow"
    client.app.state.store.delete(["marked"])
    assert client.app.state.store.all_annotations() == {}


def test_history_sort_applies_before_pagination(client) -> None:
    seed(client, "c", host="c.test", started_at=1, response_size=30)
    seed(client, "a", host="a.test", started_at=2, response_size=10)
    seed(client, "b", host="b.test", started_at=3, response_size=20)
    first = client.get("/api/flows?sort_by=host&sort_desc=false&limit=2").json()
    assert [item["id"] for item in first["items"]] == ["a", "b"]
    assert first["has_more"] is True
    assert first["next_cursor"] is None
    second = client.get(
        f"/api/flows?sort_by=host&sort_desc=false&limit=2&offset=2&anchor={first['anchor']}"
    ).json()
    assert [item["id"] for item in second["items"]] == ["c"]
    assert [item["id"] for item in client.get(
        "/api/flows?sort_by=response_size&sort_desc=true"
    ).json()["items"]] == ["c", "b", "a"]
    for column in ("started_at", "method", "host", "url", "status_code",
                   "modified", "response_size", "duration_ms"):
        assert client.get(f"/api/flows?sort_by={column}&sort_desc=false").status_code == 200
    assert client.get("/api/flows?sort_by=unknown").status_code == 422


@pytest.mark.parametrize("descending", [False, True])
def test_request_number_sort_uses_displayed_numbers_before_pagination(client, descending) -> None:
    # Number, insertion order and timestamps deliberately disagree. Older
    # projects may still have NULL numbers, displayed using their rowid.
    seed(client, "high", request_number=30, started_at=1)
    seed(client, "legacy", started_at=3)
    seed(client, "middle", request_number=10, started_at=2)
    with client.app.state.store._conn:
        client.app.state.store._conn.execute("UPDATE flows SET request_number = NULL WHERE id = 'legacy'")
    query = f"sort_by=request_number&sort_desc={str(descending).lower()}&limit=2&search=body"
    first_response = client.get(f"/api/flows?{query}")
    assert first_response.status_code == 200
    first = first_response.json()
    expected = [30, 10, 2] if descending else [2, 10, 30]
    assert [item["request_number"] for item in first["items"]] == expected[:2]
    assert first["has_more"] is True
    assert first["next_cursor"] is None
    second = client.get(f"/api/flows?{query}&offset=2&anchor={first['anchor']}").json()
    assert [item["request_number"] for item in second["items"]] == expected[2:]
    assert second["has_more"] is False


def test_full_text_search_anchor_and_raw_body_endpoint(client) -> None:
    seed(client, "old", started_at=1, path="/other", request_body=b"\xffneedle-tail")
    seed(client, "next", started_at=2, path="/other", response_headers=[("X-Trace", "search-header")])
    page = client.get("/api/flows?limit=1").json()
    assert [item["id"] for item in page["items"]] == ["next"]
    seed(client, "new", started_at=3)
    older = client.get(f"/api/flows?limit=1&offset=1&anchor={page['anchor']}").json()
    assert [item["id"] for item in older["items"]] == ["old"]
    assert client.get("/api/flows?search=search-header").json()["items"][0]["id"] == "next"
    client.app.state.store.delete(["next"])
    cursor_page = client.get(
        f"/api/flows?limit=1&anchor={page['anchor']}&cursor={quote(page['next_cursor'])}"
    ).json()
    assert [item["id"] for item in cursor_page["items"]] == ["old"]
    assert client.get("/api/flows?search=needle-tail").json()["items"][0]["id"] == "old"
    assert client.get("/api/flows/old/body/request").content == b"\xffneedle-tail"
    bounded = client.get("/api/flows/old/body/request?offset=1&limit=6")
    assert bounded.status_code == 206
    assert bounded.content == b"needle"
    assert bounded.headers["x-lanius-body-total"] == str(len(b"\xffneedle-tail"))
    assert client.get("/api/flows?cursor=invalid").status_code == 422


def test_flow_list_preserves_boolean_summary_fields(client) -> None:
    seed(client, "modified", auto_modified=True, modified=True)
    item = client.get("/api/flows").json()["items"][0]
    assert item["auto_modified"] is True
    assert item["modified"] is True


def test_get_flow_redacts_sensitive_headers_by_default(client) -> None:
    seed(client, "a")
    data = client.get("/api/flows/a").json()
    assert ["Cookie", "<redacted>"] in data["request_headers"]
    assert ["Accept", "*/*"] in data["request_headers"]
    assert ["Set-Cookie", "<redacted>"] in data["response_headers"]


def test_get_flow_reveal_opt_in(client) -> None:
    seed(client, "a")
    data = client.get("/api/flows/a?reveal=true").json()
    assert ["Cookie", "session=secret"] in data["request_headers"]


def test_get_missing_flow_404(client) -> None:
    assert client.get("/api/flows/nope").status_code == 404


def test_clear_flows(client) -> None:
    seed(client, "a")
    assert client.delete("/api/flows").json() == {"ok": True}
    assert client.get("/api/status").json()["flows"] == 0


def test_websocket_receives_hello_and_events(client) -> None:
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "hello"
        client.app.state.broker.publish("flow.request", {"id": "x"})
        event = ws.receive_json()
        assert event["type"] == "flow.request"
        assert event["data"]["id"] == "x"


def test_websocket_refuses_a_foreign_browser_origin(client) -> None:
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(
            "/ws", headers={"Origin": "https://evil.test"}
        ):
            pass
    assert refused.value.code == 1008


def test_desktop_api_and_websocket_require_the_session_token(tmp_path) -> None:
    token = "0123456789abcdef" * 4
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        api_token=token,
        data_dir=tmp_path,
        db_path=tmp_path / "test.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as protected:
        refused = protected.get("/api/status")
        assert refused.status_code == 401
        assert refused.headers["www-authenticate"] == "Bearer"
        assert (
            protected.get(
                "/api/status", headers={"Authorization": "Bearer wrong"}
            ).status_code
            == 401
        )
        assert (
            protected.get(
                "/api/status", headers={"Authorization": f"Bearer {token}"}
            ).status_code
            == 200
        )

        with pytest.raises(WebSocketDisconnect) as missing_token:
            with protected.websocket_connect(
                "/ws", headers={"Origin": "tauri://localhost"}
            ):
                pass
        assert missing_token.value.code == 1008

        with protected.websocket_connect(
            "/ws",
            headers={"Origin": "tauri://localhost"},
            subprotocols=["lanius", f"lanius-auth-{token}"],
        ) as ws:
            assert ws.accepted_subprotocol == "lanius"
            assert ws.receive_json()["type"] == "hello"

        assert protected.get("/api/ca/pem").status_code == 401
        # Sandboxed plugin files are URL-loaded static resources and carry no
        # project/capture data, so this narrow path remains reachable.
        assert protected.get("/api/plugin-ui/missing/index.html").status_code != 401
        assert protected.post("/api/plugin-ui/missing/index.html").status_code == 401


def test_redact_headers_none_passthrough() -> None:
    assert redact_headers(None) is None


# --- intercept (M2) -------------------------------------------------------


def test_intercept_defaults_off(client) -> None:
    data = client.get("/api/intercept").json()
    assert data["rules"]["enabled"] is False
    assert data["paused"] == []


def test_patch_intercept_rules(client) -> None:
    rules = client.patch(
        "/api/intercept",
        json={"enabled": True, "intercept_responses": True, "host_filter": "a.com"},
    ).json()
    assert rules["enabled"] is True
    assert rules["intercept_responses"] is True
    assert rules["host_filter"] == "a.com"
    assert client.get("/api/status").json()["intercept"]["enabled"] is True


def test_partial_patch_keeps_other_rules(client) -> None:
    client.patch("/api/intercept", json={"enabled": True, "host_filter": "a.com"})
    rules = client.patch("/api/intercept", json={"enabled": False}).json()
    assert rules["host_filter"] == "a.com"


def test_forward_unknown_flow_conflicts(client) -> None:
    assert client.post("/api/intercept/nope/forward").status_code == 409
    assert client.post("/api/intercept/nope/drop").status_code == 409


def test_forward_paused_flow_via_api(client) -> None:
    from mitmproxy.test import tflow, tutils

    client.patch("/api/intercept", json={"enabled": True})
    addon = client.app.state.engine.intercept
    flow = tflow.tflow(req=tutils.treq(host="example.com"), resp=False)
    addon.request(flow)

    listed = client.get("/api/intercept").json()["paused"]
    assert listed[0]["id"] == flow.id

    res = client.post(
        f"/api/intercept/{flow.id}/forward", json={"method": "PUT"}
    )
    assert res.status_code == 200
    assert flow.request.method == "PUT"
    assert not flow.intercepted


def test_forward_all(client) -> None:
    from mitmproxy.test import tflow, tutils

    client.patch("/api/intercept", json={"enabled": True})
    addon = client.app.state.engine.intercept
    for _ in range(3):
        addon.request(tflow.tflow(req=tutils.treq(host="example.com"), resp=False))
    assert client.post("/api/intercept/forward-all").json() == {"forwarded": 3}


def test_match_replace_rules_api(client) -> None:
    payload = {
        "rules": [
            {
                "id": "mask",
                "name": "mask token",
                "phase": "request",
                "target": "headers",
                "match": "Bearer secret",
                "replace": "Bearer changed",
            }
        ]
    }
    saved = client.put("/api/match-replace", json=payload)
    assert saved.status_code == 200
    assert client.get("/api/match-replace").json()["rules"][0]["id"] == "mask"


def test_match_replace_defaults_to_disabled_browser_emulation_presets(client) -> None:
    rules = client.get("/api/match-replace").json()["rules"]
    assert [rule["name"] for rule in rules] == [
        "Emulate Android",
        "Emulate Firefox",
        "Emulate Safari",
    ]
    assert all(rule["enabled"] is False for rule in rules)


def test_match_replace_rejects_invalid_regex(client) -> None:
    response = client.put(
        "/api/match-replace",
        json={
            "rules": [
                {
                    "id": "bad",
                    "phase": "request",
                    "target": "body",
                    "match": "[",
                    "replace": "",
                    "regex": True,
                }
            ]
        },
    )
    assert response.status_code == 422


def test_match_replace_preview_uses_unsaved_whole_message_rules(client) -> None:
    response = client.post(
        "/api/match-replace/preview",
        json={
            "phase": "response",
            "raw": "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nold",
            "rules": [
                {"phase": "response", "target": "message", "match": "200 OK", "replace": "404 Missing"},
                {"phase": "response", "target": "message", "match": "old", "replace": "new"},
            ],
        },
    )
    assert response.status_code == 200
    assert response.json()["raw"].startswith("HTTP/1.1 404 Missing")
    assert response.json()["raw"].endswith("\r\n\r\nnew")
    assert [rule["name"] for rule in client.get("/api/match-replace").json()["rules"]] == [
        "Emulate Android",
        "Emulate Firefox",
        "Emulate Safari",
    ]


def test_body_display_defaults_on_and_can_be_disabled(client) -> None:
    assert client.get("/api/body-display").json() == {"auto_decompress": True}
    assert client.patch(
        "/api/body-display", json={"auto_decompress": False}
    ).json() == {"auto_decompress": False}
    assert client.get("/api/body-display").json() == {"auto_decompress": False}


def test_media_storage_setting_and_omitted_body_details(client):
    assert client.get("/api/capture-storage").json() == {"media_body_limit_mb": 5}
    assert client.patch("/api/capture-storage", json={"media_body_limit_mb": 1}).json() == {"media_body_limit_mb": 1}
    seed(client, "media", response_mime="image/png", response_headers=[("Content-Type", "image/png")], response_body=b"x" * (1024 * 1024))
    data = client.get("/api/flows/media").json()
    assert data["response_body"] == "" and data["response_body_omitted"] is True
    assert data["response_size"] == 1024 * 1024
    assert client.get("/api/flows/media/response-preview").json() == {"kind": "unavailable", "reason": "media_body_omitted"}
    assert client.get("/api/flows/media/body/response").status_code == 404
    assert client.get("/api/project/export").json()["settings"]["media_body_limit_mb"] == "1"


@pytest.mark.parametrize("limit", [-1, 1025, 0.5, True, "5"])
def test_media_storage_rejects_invalid_limits(client, limit):
    assert client.patch("/api/capture-storage", json={"media_body_limit_mb": limit}).status_code == 422
    assert client.get("/api/capture-storage").json()["media_body_limit_mb"] == 5


def test_get_flow_automatically_decompresses_body(client) -> None:
    seed(
        client,
        "gzip",
        request_headers=[
            ("Content-Type", "application/json"),
            ("Content-Encoding", "gzip"),
        ],
        request_body=gzip.compress(b'{"ok":true}'),
    )
    data = client.get("/api/flows/gzip").json()
    assert data["request_body"] == '{"ok":true}'
    assert data["request_body_decoded"] is True


def test_websocket_proxy_api_defaults_and_rules(client) -> None:
    state = client.get("/api/websockets").json()
    assert state["messages"] == []
    assert state["rules"]["enabled"] is False
    rules = client.patch(
        "/api/websockets/intercept",
        json={"enabled": True, "server_messages": False},
    ).json()
    assert rules["enabled"] is True
    assert rules["server_messages"] is False


def test_websocket_actions_report_stale_targets(client) -> None:
    assert client.post(
        "/api/websockets/missing/forward", json={"content": "x"}
    ).status_code == 409
    assert client.post("/api/websockets/missing/drop").status_code == 409
    assert client.post(
        "/api/websockets/repeat",
        json={"connection_id": "missing", "content": "x"},
    ).status_code == 409


# --- CA / events (final pass) ---------------------------------------------


def test_ca_info_reports_availability(client) -> None:
    data = client.get("/api/ca").json()
    assert "confdir" in data
    assert set(data["available"]) == {"pem", "cer", "p12"}
    assert data["install_url"] == "http://mitm.it"
    assert data["system_trust"]["status"] in {"trusted", "not_trusted", "unknown", "unsupported", "invalid"}


def test_ca_info_includes_local_system_trust_diagnostics(client, monkeypatch) -> None:
    from app import ca_trust

    expected = {"platform": "Windows", "status": "trusted", "fingerprint_sha256": "AB" * 32}
    paths = []

    def inspect(path):
        paths.append(path)
        return expected

    monkeypatch.setattr(ca_trust, "system_trust", inspect)
    assert client.get("/api/ca").json()["system_trust"] == expected
    assert paths == [client.app.state.settings.confdir]


def test_ca_download_unknown_format(client) -> None:
    assert client.get("/api/ca/jpeg").status_code == 404


def test_ca_download_serves_the_certificate(client) -> None:
    confdir = client.app.state.settings.confdir
    confdir.mkdir(parents=True, exist_ok=True)
    (confdir / "mitmproxy-ca-cert.pem").write_text("-----BEGIN CERTIFICATE-----")
    res = client.get("/api/ca/pem")
    assert res.status_code == 200
    assert "BEGIN CERTIFICATE" in res.text


def test_ca_private_key_is_not_exposed(client) -> None:
    """The CA private key must never be downloadable (codex.md §10)."""
    confdir = client.app.state.settings.confdir
    confdir.mkdir(parents=True, exist_ok=True)
    (confdir / "mitmproxy-ca.pem").write_text("PRIVATE KEY")
    # Only the three public cert formats are routable.
    assert client.get("/api/ca/mitmproxy-ca.pem").status_code == 404
    for fmt in ("pem", "cer", "p12"):
        res = client.get(f"/api/ca/{fmt}")
        assert "PRIVATE KEY" not in res.text


def test_events_endpoint_records_notable_events(client) -> None:
    client.patch("/api/intercept", json={"enabled": True})
    items = client.get("/api/events").json()["items"]
    assert any("intercept.rules" in i["message"] for i in items)


def test_events_endpoint_skips_per_flow_noise(client) -> None:
    client.app.state.broker.publish("flow.request", {"id": "x"})
    items = client.get("/api/events").json()["items"]
    assert not any("flow.request" in i["message"] for i in items)


def test_events_are_newest_first(client) -> None:
    client.patch("/api/intercept", json={"enabled": True})
    client.delete("/api/flows")
    items = client.get("/api/events").json()["items"]
    assert "flows.cleared" in items[0]["message"]


# --- dashboard --------------------------------------------------------------


def test_dashboard_is_empty_before_any_traffic(client) -> None:
    data = client.get("/api/dashboard").json()
    assert data["flows"] == 0
    assert data["project_bytes"] > 0
    assert data["top_hosts"] == []
    assert data["proxy"]["running"] is True


def test_dashboard_aggregates_captured_flows(client) -> None:
    seed(client, "a", host="a.com", status_code=200, duration_ms=5.0)
    seed(client, "b", host="a.com", status_code=500, duration_ms=50.0)
    seed(client, "c", host="b.com", status_code=404, duration_ms=1.0)

    data = client.get("/api/dashboard").json()

    assert data["flows"] == 3
    assert data["hosts"] == 2
    assert data["status_groups"] == {"2xx": 1, "4xx": 1, "5xx": 1}
    assert data["top_hosts"][0]["host"] == "a.com"


def test_dashboard_includes_engine_state(client) -> None:
    """The tab shows proxy and intercept state, so one request must cover it."""
    data = client.get("/api/dashboard").json()
    assert data["proxy"]["port"] > 0
    assert data["intercept_enabled"] is False
    assert data["paused"] == 0
    assert data["version"]


def test_dashboard_top_limit_is_bounded(client) -> None:
    assert client.get("/api/dashboard?top=0").status_code == 422
    assert client.get("/api/dashboard?top=51").status_code == 422
    assert client.get("/api/dashboard?top=5").status_code == 200


def test_dashboard_window_must_be_positive(client) -> None:
    assert client.get("/api/dashboard?window=0").status_code == 422
    assert client.get("/api/dashboard?window=60").status_code == 200


def test_status_exposes_per_mode_state(client) -> None:
    """A mode can fail while the engine stays up, so the UI needs to see
    each one rather than a single healthy/unhealthy flag."""
    modes = client.get("/api/status").json()["modes"]
    # The port is named on the mode so the list stays switchable at runtime.
    assert [m["spec"].split("@")[0] for m in modes] == ["regular"]
    assert modes[0]["running"] is True
    assert modes[0]["error"] is None


def test_status_reports_local_capture_readiness(client) -> None:
    """The UI needs to distinguish 'not supported' from 'needs approval',
    because mitmproxy reports a blocked local mode as running."""
    state = client.get("/api/status").json()["local_capture"]
    assert set(state) == {"supported", "approved", "detail", "spec"}
    assert isinstance(state["supported"], bool)
    assert isinstance(state["approved"], bool)


def test_dashboard_carries_mode_and_capture_state(client) -> None:
    """The dashboard is where a user would notice a mode being down, so it
    must not need a second call to /api/status to find out."""
    data = client.get("/api/dashboard").json()
    assert [m["spec"].split("@")[0] for m in data["modes"]] == ["regular"]
    assert set(data["local_capture"]) == {"supported", "approved", "detail", "spec"}


# --- local capture control ---------------------------------------------------


def test_local_capture_is_off_by_default(client) -> None:
    assert client.get("/api/status").json()["local_capture"]["spec"] is None


def test_unavailable_local_capture_is_rejected_without_persisting(client, monkeypatch) -> None:
    """A missing privilege must not poison the next engine startup with a
    mode that cannot run on this machine."""
    from app import proxy as proxy_module

    monkeypatch.setattr(
        proxy_module,
        "local_capture_state",
        lambda **_kwargs: {
            "supported": False,
            "approved": False,
            "detail": "administrator privileges are required",
        },
    )

    response = client.post("/api/capture/local", json={"spec": "curl"})
    assert response.status_code == 422
    assert "administrator privileges" in response.json()["detail"]
    assert client.app.state.engine.local_capture_spec() is None


def test_enabling_local_capture_persists_the_spec(client) -> None:
    """Switching it on must survive, so the setting is stored rather than
    living only in the running mitmproxy options."""
    body = client.post("/api/capture/local", json={"spec": "curl"}).json()
    assert body["spec"] == "curl"
    assert client.get("/api/status").json()["local_capture"]["spec"] == "curl"


def test_disabling_local_capture_clears_the_spec(client) -> None:
    """null switches it off. An empty string does not: that means on with
    no filter, which is a different thing."""
    client.post("/api/capture/local", json={"spec": "curl"})
    body = client.post("/api/capture/local", json={"spec": None}).json()
    assert body["spec"] is None
    assert client.get("/api/status").json()["local_capture"]["spec"] is None


def test_an_empty_spec_captures_every_process(client) -> None:
    body = client.post("/api/capture/local", json={"spec": ""}).json()
    assert body["spec"] == "", "off is null, not empty"
    assert client.get("/api/status").json()["local_capture"]["spec"] == ""


def test_an_invalid_spec_is_rejected(client) -> None:
    """A bad spec would otherwise take the proxy down when mitmproxy
    reconfigures, so it is validated before being stored."""
    assert client.post("/api/capture/local", json={"spec": 42}).status_code == 422
    assert client.get("/api/status").json()["local_capture"]["spec"] is None


def test_local_capture_reports_readiness_with_the_spec(client) -> None:
    body = client.post("/api/capture/local", json={"spec": "!Slack"}).json()
    assert body["spec"] == "!Slack"
    assert set(body) == {
        "spec",
        "supported",
        "approved",
        "detail",
        "restart_required",
    }


def test_capture_change_reports_whether_a_restart_is_needed(client) -> None:
    """The OS redirector is a process-wide singleton, so a change cannot
    always be applied to a running engine. Saying 'done' would be a lie."""
    body = client.post("/api/capture/local", json={"spec": "curl"}).json()
    assert "restart_required" in body
    assert isinstance(body["restart_required"], bool)


def test_a_spec_mitmproxy_rejects_returns_422(client) -> None:
    """Not just the wrong type: a string mitmproxy cannot parse must be
    refused too, or it would be stored and break the next startup."""
    assert client.post("/api/capture/local", json={"spec": ",,,"}).status_code == 422
    assert client.get("/api/status").json()["local_capture"]["spec"] is None


# --- upstream TLS profile ----------------------------------------------------


def test_tls_defaults_to_mitmproxys_own_handshake(client) -> None:
    data = client.get("/api/tls").json()
    assert data["profile"] == "default"
    assert data["ciphers"] is None
    assert [p["id"] for p in data["available"]][0] == "default"
    assert data["selected_ciphers"]
    assert data["supported_ciphers"]
    assert data["tls13_ciphers"]
    supported = {cipher["name"] for cipher in data["supported_ciphers"]}
    assert set(data["selected_ciphers"]) <= supported


def test_selecting_a_browser_profile_changes_the_ciphers(client) -> None:
    body = client.post("/api/tls", json={"profile": "chrome"}).json()
    assert body["profile"] == "chrome"
    assert body["ciphers"] and "TLS_AES_128_GCM_SHA256" in body["ciphers"]
    assert client.get("/api/tls").json()["profile"] == "chrome"


def test_custom_ciphers_override_the_profile(client) -> None:
    body = client.post(
        "/api/tls", json={"profile": "chrome", "ciphers": "ECDHE-RSA-AES128-GCM-SHA256"}
    ).json()
    assert body["ciphers"] == "ECDHE-RSA-AES128-GCM-SHA256"
    assert body["custom_ciphers"] == "ECDHE-RSA-AES128-GCM-SHA256"
    assert body["selected_ciphers"] == ["ECDHE-RSA-AES128-GCM-SHA256"]


def test_clearing_custom_ciphers_restores_the_profile(client) -> None:
    client.post("/api/tls", json={"profile": "chrome", "ciphers": "AES256-SHA"})
    body = client.post("/api/tls", json={"profile": "chrome", "ciphers": ""}).json()
    assert body["custom_ciphers"] is None
    assert "TLS_AES_128_GCM_SHA256" in body["ciphers"]


def test_tls12_profile_reports_no_fixed_tls13_suites(client) -> None:
    body = client.post("/api/tls", json={"profile": "tls12"}).json()
    assert body["tls13_ciphers"] == []


def test_an_unusable_cipher_list_is_refused(client) -> None:
    """Storing one would make every upstream request fail with a 502."""
    assert (
        client.post(
            "/api/tls", json={"profile": "chrome", "ciphers": "NOT-A-CIPHER"}
        ).status_code
        == 422
    )
    assert client.get("/api/tls").json()["custom_ciphers"] is None


def test_an_unknown_profile_is_refused(client) -> None:
    assert client.post("/api/tls", json={"profile": "netscape"}).status_code == 422


def test_tls_profile_survives_a_restart(client, tmp_path) -> None:
    """The setting is stored, not just held in the running options."""
    client.post("/api/tls", json={"profile": "firefox"})
    store = client.app.state.store
    assert store.get_setting("tls_profile") == "firefox"


def test_processes_can_be_listed_for_picking(client) -> None:
    """Rules match substrings of the executable path, so picking from a
    list beats typing a name and hoping."""
    data = client.get("/api/processes").json()
    assert data["count"] == len(data["items"])
    if data["items"]:
        first = data["items"][0]
        assert set(first) == {"name", "path", "visible", "system"}


def test_the_full_process_list_is_larger_than_the_visible_one(client) -> None:
    visible = client.get("/api/processes?visible_only=true").json()["count"]
    every = client.get("/api/processes?visible_only=false").json()["count"]
    assert every >= visible


# --- workspace autosave and project export/import -----------------------------


def test_workspace_starts_empty(client) -> None:
    assert client.get("/api/workspace/replay").json()["value"] is None


def test_workspace_round_trips(client) -> None:
    """Replay and Decoder tabs lived only in the browser, so closing
    Lanius threw away whatever you had open."""
    tabs = [{"id": "r1", "title": "login"}]
    client.put("/api/workspace/replay", json={"value": tabs})
    assert client.get("/api/workspace/replay").json()["value"] == tabs


def test_workspace_rejects_a_payload_with_no_value(client) -> None:
    assert client.put("/api/workspace/x", json={}).status_code == 422


def test_export_describes_itself(client) -> None:
    data = client.get("/api/project/export").json()
    assert data["format"] == "lanius-project"
    assert data["version"] == 1
    assert "scope" in data and "workspace" in data


def test_listener_collection_survives_project_export_and_import(client) -> None:
    added = client.post(
        "/api/listeners", json={"host": "127.0.0.1", "port": free_port()}
    ).json()
    second_id = added["listeners"][1]["id"]
    client.post(f"/api/listeners/{second_id}/primary")
    exported = client.get("/api/project/export").json()

    assert client.delete(f"/api/listeners/{second_id}").status_code == 200
    assert len(client.get("/api/listeners").json()["listeners"]) == 1
    assert client.post("/api/project/import", json=exported).status_code == 200

    restored = client.get("/api/listeners").json()
    assert len(restored["listeners"]) == 2
    assert restored["primary_id"] == second_id
    assert all(listener["running"] for listener in restored["listeners"])


def test_local_source_ip_survives_project_export_and_import(client) -> None:
    seed(client, "source-audit", local_source_ip="192.0.2.12")
    exported = client.get("/api/project/export").json()
    assert exported["flows"][0]["local_source_ip"] == "192.0.2.12"
    client.delete("/api/flows")
    assert client.post("/api/project/import", json=exported).status_code == 200
    assert client.get("/api/flows/source-audit").json()["local_source_ip"] == "192.0.2.12"


def test_sqlite_backup_contains_raw_history_and_websockets(client, tmp_path) -> None:
    seed(client, "raw", request_body=b"\xff\x00whole-body")
    client.app.state.store.append_websocket_message({
        "id": "ws1", "connection_id": "c", "host": "example.com", "path": "/ws",
        "from_client": True, "is_text": False, "timestamp": 1.0,
        "injected": False, "dropped": False, "paused": False,
    }, b"\xff\x01frame")
    response = client.get("/api/project/backup")
    assert response.status_code == 200
    saved = tmp_path / "saved.sqlite"
    saved.write_bytes(response.content)
    with sqlite3.connect(saved) as conn:
        assert conn.execute("SELECT request_body FROM flows WHERE id='raw'").fetchone()[0] == b"\xff\x00whole-body"
        assert conn.execute("SELECT content FROM websocket_messages WHERE id='ws1'").fetchone()[0] == b"\xff\x01frame"
    assert client.get("/api/websockets/messages/ws1/raw").content == b"\xff\x01frame"
    assert client.get("/api/websockets/messages?limit=1").json()["items"][0]["id"] == "ws1"
    assert client.delete("/api/websockets").status_code == 200
    assert client.get("/api/websockets/messages").json()["items"] == []


def test_project_settings_export_leaves_out_the_capture(client) -> None:
    """A settings file carries scope and Replay work without HTTP history."""
    assert "flows" not in client.get(
        "/api/project/export?include_flows=false"
    ).json()


def test_project_settings_import_preserves_capture_and_applies_workspace(client) -> None:
    seed(client, "kept-before-settings")
    client.put(
        "/api/workspace/replay",
        json={"value": [{"id": "settings-replay", "text": "saved request"}]},
    )
    client.post(
        "/api/scope/rules",
        json={"kind": "include", "host": "settings.example"},
    )
    settings = client.get("/api/project/export?include_flows=false").json()

    seed(client, "kept-after-settings")
    client.put("/api/workspace/replay", json={"value": [{"id": "old"}]})
    result = client.post(
        "/api/project/import?settings_only=true", json=settings
    )

    assert result.status_code == 200, result.text
    assert result.json()["flows"] == 0
    assert client.app.state.store.get("kept-before-settings") is not None
    assert client.app.state.store.get("kept-after-settings") is not None
    assert client.get("/api/workspace/replay").json()["value"] == [
        {"id": "settings-replay", "text": "saved request"}
    ]
    assert "settings.example" in {
        rule["host"] for rule in client.get("/api/scope").json()["rules"]
    }


def test_project_settings_import_rejects_capture_and_database_files(client) -> None:
    seed(client, "must-not-import")
    project = client.get("/api/project/export").json()
    response = client.post(
        "/api/project/import?settings_only=true", json=project
    )
    assert response.status_code == 422
    assert "captured requests" in response.json()["detail"]

    backup = client.get("/api/project/backup")
    response = client.post(
        "/api/project/import?settings_only=true",
        content=backup.content,
        headers={"Content-Type": "application/x-sqlite3"},
    )
    assert response.status_code == 422
    assert "JSON settings export" in response.json()["detail"]


def test_burp_settings_import_maps_supported_settings_and_keeps_lanius_data(client) -> None:
    seed(client, "kept-during-burp-import")
    client.put("/api/workspace/replay", json={"value": [{"id": "keep-me"}]})
    client.post("/api/scope/rules", json={"kind": "include", "host": "old.example"})

    burp = {
        "target": {
            "scope": {
                "advanced_mode": False,
                "include": [{
                    "enabled": True,
                    "host": r"example\.com",
                    "file": r"\/api\/.*",
                    "protocol": "https",
                }],
                "exclude": [{
                    "enabled": True,
                    "host": r"static\.example\.com",
                    "protocol": "any",
                }],
            }
        },
        "proxy": {
            "match_replace_rules": [{
                "comment": "Imported header",
                "enabled": True,
                "is_simple_match": False,
                "rule_type": "request_header",
                "string_match": "^X-Old:.*$",
                "string_replace": "X-New: yes",
            }],
            "request_listeners": [{
                "listen_mode": "loopback_only",
                "listener_port": 18888,
                "running": True,
            }],
            "miscellaneous": {
                "disable_out_of_scope_logging_to_history_and_site_map": True,
            },
        },
        "project_options": {
            "http": {"http2": {"enable_http2": False}},
            "connections": {
                "socks_proxy": {"use_proxy": False},
                "upstream_proxy": {"servers": [{"destination_host": "internal.example"}]},
            },
            # These are deliberately present to prove that the converter does
            # not import secrets or trust decisions.
            "ssl": {"client_certificates": [{"password": "do-not-import"}]},
            "sessions": {"macros": [{"name": "do-not-run"}]},
        },
    }

    response = client.post("/api/project/import?settings_only=true", json=burp)

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["source"] == "burp"
    assert result["scope"] == 2
    assert result["match_replace"] == 1
    assert result["listeners"] == 1
    assert result["skipped"] == 1
    assert client.app.state.store.get("kept-during-burp-import") is not None
    assert client.get("/api/workspace/replay").json()["value"] == [{"id": "keep-me"}]
    scope = client.get("/api/scope").json()
    assert scope["restrict_capture"] is True
    assert {(rule["kind"], rule["host"], rule["path"]) for rule in scope["rules"]} == {
        ("include", r"example\.com", r"\/api\/.*"),
        ("exclude", r"static\.example\.com", ".*"),
    }
    rules = client.get("/api/match-replace").json()["rules"]
    assert rules == [{
        "id": "burp-1",
        "name": "Imported header",
        "enabled": True,
        "phase": "request",
        "target": "headers",
        "match": "^X-Old:.*$",
        "replace": "X-New: yes",
        "regex": True,
        "case_sensitive": True,
    }]
    assert client.get("/api/http-protocol").json()["mode"] == "http1.1"
    listener = client.get("/api/listeners").json()["listeners"][0]
    assert (listener["host"], listener["port"]) == ("127.0.0.1", 18888)
    exported = client.get("/api/project/export?include_flows=false").json()
    assert "do-not-import" not in json.dumps(exported)
    assert "do-not-run" not in json.dumps(exported)


def test_burp_empty_scope_maps_to_nothing_in_scope(client) -> None:
    response = client.post(
        "/api/project/import?settings_only=true",
        json={"target": {"scope": {"include": [], "exclude": []}}},
    )
    assert response.status_code == 200, response.text
    rules = client.get("/api/scope").json()["rules"]
    assert len(rules) == 1
    assert rules[0]["host"] == r"(?!)"
    assert client.get("/api/scope/check?url=https://example.com/").json()["in_scope"] is False


def test_import_restores_scope_workspace_and_flows(client) -> None:
    seed(client, "f1", host="imported.example")
    client.put("/api/workspace/replay", json={"value": [{"id": "r1"}]})
    client.post("/api/scope/rules", json={"kind": "include", "host": "a.example"})
    exported = client.get("/api/project/export").json()

    client.delete("/api/flows")
    client.put("/api/workspace/replay", json={"value": []})

    result = client.post("/api/project/import", json=exported).json()
    assert result["ok"] is True
    assert client.get("/api/workspace/replay").json()["value"] == [{"id": "r1"}]
    assert client.get("/api/flows").json()["count"] == 1


def test_imported_scope_takes_effect_immediately(client) -> None:
    """The scope is held in memory once loaded, so an import that only
    wrote the database would leave the rules doing nothing."""
    client.post("/api/scope/rules", json={"kind": "include", "host": "scoped.example"})
    exported = client.get("/api/project/export?include_flows=false").json()

    client.post("/api/project/import", json=exported)

    rules = client.get("/api/scope").json()["rules"]
    assert [r["host"] for r in rules] == [
        "*.googleapis.com",
        "*.google.com",
        "*.gvt1.com",
        "scoped.example",
    ]


def test_import_refuses_a_document_that_is_not_a_project(client) -> None:
    assert client.post("/api/project/import", json={"format": "junk"}).status_code == 422


def test_import_accepts_a_raw_json_file_and_rejects_broken_json(client) -> None:
    payload = {"format": "lanius-project", "version": 1, "scope": []}
    result = client.post(
        "/api/project/import",
        content=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    assert result.status_code == 200
    assert result.json()["ok"] is True
    assert client.post(
        "/api/project/import", content=b"{broken",
        headers={"Content-Type": "application/json"},
    ).status_code == 422


def test_import_refuses_a_future_version(client) -> None:
    """Better to say so than to half-read it."""
    assert (
        client.post(
            "/api/project/import", json={"format": "lanius-project", "version": 99}
        ).status_code
        == 422
    )


def test_import_sqlite_restores_complete_capture_and_reloads_live_scope(client, tmp_path) -> None:
    source_path = tmp_path / "source" / "backup.sqlite"
    source = make_backup(source_path)
    source.add_scope_rule({"kind": "include", "host": "imported.test", "path": "*",
                           "protocol": "any", "port": None, "match_type": "glob", "enabled": True})
    source.close()
    seed(client, "old")
    engine = client.app.state.engine
    with mock.patch.object(engine, "stop", wraps=engine.stop) as stop:
        result = client.post("/api/project/import", content=source_path.read_bytes(),
                             headers={"Content-Type": "application/x-sqlite3"})
    assert result.status_code == 200, result.text
    assert result.json()["flows"] == 1
    assert result.json()["websockets"] == 1
    assert result.json()["warnings"] == []
    assert stop.await_count == 1
    assert engine.running
    store = client.app.state.store
    assert store.get("old") is None
    assert store.get_body_bytes("raw", "request") == b"\xff\x00request"
    assert store.get_body_bytes("raw", "response") == b"\xfe\x00response"
    assert client.get("/api/websockets/messages/ws/raw").content == b"\xff\x01frame"
    assert client.get("/api/flows?bookmarked_only=true").json()["items"][0]["id"] == "raw"
    assert client.get("/api/workspace/decoder").json()["value"][0]["input"] == "saved payload"
    assert [rule["host"] for rule in client.get("/api/scope").json()["rules"]] == [
        "*.googleapis.com",
        "*.google.com",
        "*.gvt1.com",
        "imported.test",
    ]


@pytest.mark.parametrize("data", [b"SQLite format 3\x00truncated", None])
def test_import_rejects_invalid_sqlite_without_stopping_or_replacing_current_project(client, tmp_path, data) -> None:
    if data is None:
        path = tmp_path / "unrelated.sqlite"
        with sqlite3.connect(path) as conn:
            conn.execute("CREATE TABLE other(value TEXT)")
        data = path.read_bytes()
    seed(client, "keep")
    engine = client.app.state.engine
    with mock.patch.object(engine, "stop", wraps=engine.stop) as stop:
        result = client.post("/api/project/import", content=data)
    assert result.status_code == 422
    assert stop.await_count == 0
    assert client.app.state.store.get("keep") is not None
    assert engine.running


@pytest.mark.parametrize("already_locked", [False, True])
def test_sqlite_import_applies_lockdown_before_restore_and_preserves_trust(client, tmp_path, already_locked) -> None:
    path = tmp_path / "source" / "backup.sqlite"
    source = make_backup(path)
    source.set_setting(TRUSTED_CA_SETTING, "unapproved imported CA")
    source.set_setting(PROJECT_SETTING, "0" if already_locked else "1")
    source.set_setting(SCOPE_EGRESS_SETTING, "0" if already_locked else "1")
    source.close()
    approved_ca = (client.app.state.engine.settings.confdir / "mitmproxy-ca-cert.pem").read_text() if already_locked else None
    if already_locked:
        client.put("/api/lockdown/scope-egress", json={"enabled": True})
        client.put("/api/lockdown/project", json={"enabled": True})
        client.app.state.store.set_setting(TRUSTED_CA_SETTING, approved_ca)
    store = client.app.state.store
    restore = store.restore_database

    def guarded_restore(*args, **kwargs):
        assert client.app.state.lockdown.enabled
        assert client.app.state.engine.plugins.suspended
        restore(*args, **kwargs)

    with mock.patch.object(store, "restore_database", side_effect=guarded_restore):
        result = client.post("/api/project/import", content=path.read_bytes())
    assert result.status_code == 200, result.text
    state = client.get("/api/lockdown").json()
    assert state["project_enabled"] and state["scope_egress_effective"]
    assert store.get_setting(TRUSTED_CA_SETTING) == approved_ca
    assert client.app.state.engine.master.options.connection_strategy == "lazy"


def test_sqlite_import_returns_committed_data_and_warning_when_proxy_restart_fails(client, tmp_path) -> None:
    path = tmp_path / "source" / "backup.sqlite"
    make_backup(path).close()
    with mock.patch.object(client.app.state.engine, "start", side_effect=RuntimeError("port occupied")):
        result = client.post("/api/project/import", content=path.read_bytes())
    assert result.status_code == 200
    assert "port occupied" in result.json()["warnings"][0]
    assert client.app.state.store.get("raw") is not None
    assert not client.app.state.engine.running


def test_sqlite_import_keeps_proxy_stopped_when_scope_reload_fails(client, tmp_path) -> None:
    path = tmp_path / "source" / "backup.sqlite"
    make_backup(path).close()
    engine = client.app.state.engine
    with mock.patch.object(engine.scope, "reload", side_effect=RuntimeError("invalid scope")):
        result = client.post("/api/project/import", content=path.read_bytes())
    assert result.status_code == 200
    assert "remains stopped" in result.json()["warnings"][0]
    assert client.app.state.store.get("raw") is not None
    assert not engine.running


def test_listener_reports_where_the_proxy_listens(client) -> None:
    body = client.get("/api/listener").json()
    assert body["running"] is True
    assert body["host"] == "127.0.0.1"
    assert body["exposed"] is False
    assert body["error"] is None
    # The UI offers these two without the user having to know an address.
    hosts = [entry["host"] for entry in body["addresses"]]
    assert "127.0.0.1" in hosts
    assert "0.0.0.0" in hosts  # noqa: S104


def test_listener_can_be_moved_to_another_port(client) -> None:
    target = free_port()
    body = client.post("/api/listener", json={"port": target}).json()
    assert body["port"] == target
    assert body["running"] is True
    assert client.get("/api/status").json()["proxy"]["port"] == target


def test_listener_rejects_a_port_in_use_without_losing_the_proxy(client) -> None:
    before = client.get("/api/listener").json()["port"]
    blocker = socket.socket()
    # Deliberately without SO_REUSEADDR: with it, Windows allows a second
    # bind to a listening port, so the port would not really be busy.
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    taken = blocker.getsockname()[1]
    try:
        response = client.post("/api/listener", json={"port": taken})
        assert response.status_code == 409
        assert str(taken) in response.json()["detail"]
        # Still serving on the original port.
        assert client.get("/api/listener").json()["port"] == before
        assert client.get("/api/status").json()["proxy"]["running"] is True
    finally:
        blocker.close()


def test_listener_rejects_nonsense(client) -> None:
    assert client.post("/api/listener", json={"port": "abc"}).status_code == 422
    assert client.post("/api/listener", json={"port": 0}).status_code == 409
    assert client.post("/api/listener", json={"host": ""}).status_code == 409


def test_multiple_listener_crud_and_primary_selection(client) -> None:
    initial = client.get("/api/listeners").json()
    assert len(initial["listeners"]) == 1
    original_id = initial["primary_id"]

    second_port = free_port()
    added = client.post(
        "/api/listeners", json={"host": "127.0.0.1", "port": second_port}
    )
    assert added.status_code == 200
    second = added.json()["listeners"][1]
    assert second["port"] == second_port
    assert second["running"] is True

    moved_port = free_port()
    moved = client.patch(
        f"/api/listeners/{second['id']}", json={"port": moved_port}
    )
    assert moved.status_code == 200
    assert moved.json()["listeners"][1]["port"] == moved_port

    primary = client.post(f"/api/listeners/{second['id']}/primary")
    assert primary.status_code == 200
    assert primary.json()["primary_id"] == second["id"]
    assert client.get("/api/listener").json()["port"] == moved_port
    assert client.get("/api/status").json()["proxy"]["listener_count"] == 2

    removed = client.delete(f"/api/listeners/{original_id}")
    assert removed.status_code == 200
    assert len(removed.json()["listeners"]) == 1
    assert client.delete(f"/api/listeners/{second['id']}").status_code == 409


def test_busy_add_does_not_change_listener_collection(client) -> None:
    before = client.get("/api/listeners").json()
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    try:
        response = client.post(
            "/api/listeners",
            json={"host": "127.0.0.1", "port": blocker.getsockname()[1]},
        )
        assert response.status_code == 409
        after = client.get("/api/listeners").json()
        assert after["listeners"] == before["listeners"]
    finally:
        blocker.close()


def test_upstream_route_can_be_set_and_cleared(client) -> None:
    assert client.get("/api/upstream").json() == {"enabled": False, "hops": [], "url": None}
    configured = client.post(
        "/api/upstream", json={"url": "http://127.0.0.1:18081"}
    )
    assert configured.status_code == 200
    assert configured.json() == {
        "enabled": True,
        "hops": ["http://127.0.0.1:18081"],
        "url": "http://127.0.0.1:18081",
    }
    assert client.get("/api/upstream").json() == configured.json()
    assert client.post("/api/upstream", json={"url": None}).json() == {
        "enabled": False,
        "hops": [],
        "url": None,
    }


def test_upstream_rejects_invalid_addresses_without_changing_route(client) -> None:
    for url in ("ftp://127.0.0.1:1080", "http://user:pass@proxy:8080"):
        assert client.post("/api/upstream", json={"url": url}).status_code == 422
    listener_port = client.get("/api/listener").json()["port"]
    assert client.post(
        "/api/upstream", json={"url": f"http://127.0.0.1:{listener_port}"}
    ).status_code == 422
    assert client.get("/api/upstream").json() == {"enabled": False, "hops": [], "url": None}


def test_the_api_survives_a_proxy_port_that_is_already_taken(tmp_path) -> None:
    """The failure the released build showed: another tool holding the port
    took the whole app down, so the UI could not even offer a new one."""
    blocker = socket.socket()
    # Deliberately without SO_REUSEADDR: with it, Windows allows a second
    # bind to a listening port, so the port would not really be busy.
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    taken = blocker.getsockname()[1]
    try:
        settings = Settings(
            proxy_port=taken,
            api_port=free_port(),
            data_dir=tmp_path,
            db_path=tmp_path / "test.sqlite",
            confdir=tmp_path / "mitm",
        )
        with TestClient(create_app(settings)) as client:
            status = client.get("/api/status").json()
            assert status["proxy"]["running"] is False
            assert str(taken) in status["proxy"]["error"]

            # And the way out works: move to a free port from the API alone.
            moved = client.post("/api/listener", json={"port": free_port()})
            assert moved.status_code == 200
            assert moved.json()["running"] is True
            assert client.get("/api/status").json()["proxy"]["running"] is True
    finally:
        blocker.close()


def test_the_desktop_window_is_allowed_by_cors(client) -> None:
    """The shipped app talks to the engine from a tauri:// origin, not from
    a localhost URL. Without it every panel showed 'Load failed' while the
    server was answering 200, because the webview refused the response.

    This went unnoticed because the browser dev server runs on a localhost
    port, which was allowed, so testing there could not see it.
    """
    for origin in (
        "tauri://localhost",  # macOS and Linux
        "http://tauri.localhost",  # Windows WebView2 default
        "https://tauri.localhost",  # custom secure protocol
        "http://127.0.0.1:5173",  # the dev server
        "http://localhost:5173",
    ):
        response = client.get("/api/status", headers={"Origin": origin})
        assert response.status_code == 200
        assert response.headers.get("access-control-allow-origin") == origin, (
            f"{origin} is not allowed, so the UI cannot read the response"
        )


def test_cors_still_refuses_a_remote_origin(client) -> None:
    """Widening the rule must not open the engine to a web page."""
    for origin in (
        "http://evil.test",
        "http://tauri.localhost.evil.test",
        "https://tauri.localhost.evil.test",
        "http://127.0.0.1.evil.test",
        "http://localhost:5174",
    ):
        response = client.get("/api/status", headers={"Origin": origin})
        assert response.headers.get("access-control-allow-origin") is None, (
            f"{origin} must not be allowed to read the engine"
        )


def test_mcp_reports_where_to_connect_and_what_it_offers(client) -> None:
    body = client.get("/api/mcp").json()
    assert body["available"] is True
    assert body["enabled"] is True
    # Not just any /mcp string: the transport mounts its own path beneath
    # ours, so the URL a client needs is doubled. Advertising the wrong one
    # means every agent fails to connect, which a substring check missed.
    assert body["url"].endswith("/mcp/mcp")
    posted = client.post(
        "/mcp/mcp",
        headers={"Accept": "text/event-stream, application/json"},
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
    )
    assert posted.status_code != 404, "the advertised URL is not mounted"
    # The tool list is read from the server, so it cannot drift from what
    # an agent is actually given.
    names = [tool["name"] for tool in body["tools"]]
    assert "list_flows" in names
    assert "list_egress_ip_history" in names
    assert "send_request" in names
    # Tools that act, rather than look, are flagged so the UI can say so.
    writes = {tool["name"] for tool in body["tools"] if tool["writes"]}
    assert "send_request" in writes
    assert "list_flows" not in writes
    assert "list_egress_ip_history" not in writes


def test_turning_mcp_off_actually_refuses_agents(client) -> None:
    """An off switch that only greys out a checkbox would be worse than
    none: the point is to stop an agent reaching the proxy."""
    before = client.post("/mcp/", headers={"Accept": "text/event-stream"})
    assert before.status_code != 403

    assert client.post("/api/mcp", json={"enabled": False}).json()["enabled"] is False

    blocked = client.post("/mcp/", headers={"Accept": "text/event-stream"})
    assert blocked.status_code == 403
    assert "Settings" in blocked.json()["detail"]

    # And back on again.
    assert client.post("/api/mcp", json={"enabled": True}).json()["enabled"] is True
    assert client.post("/mcp/", headers={"Accept": "text/event-stream"}).status_code != 403


def test_mcp_toggle_rejects_nonsense(client) -> None:
    assert client.post("/api/mcp", json={"enabled": "yes"}).status_code == 422
    assert client.post("/api/mcp", json={}).status_code == 422


def test_browser_state_describes_what_is_available(client) -> None:
    body = client.get("/api/browser").json()
    assert "available" in body
    assert body["profile"].endswith("browser-profile")


def test_opening_a_browser_uses_the_current_listener(client) -> None:
    """The port is movable, so the browser must follow it rather than
    assume 8080."""
    from app import browser as browser_module

    target = free_port()
    client.post("/api/listener", json={"port": target})

    with mock.patch.object(browser_module, "find_browser") as find:
        find.return_value = browser_module.Browser("Google Chrome", "/fake/chrome")
        with mock.patch.object(browser_module, "_spawn", return_value=99) as spawn:
            response = client.post("/api/browser", json={"url": "https://example.com/"})

    assert response.status_code == 200
    assert response.json()["pid"] == 99
    args = spawn.call_args[0][0]
    assert f"--proxy-server=http://127.0.0.1:{target}" in args


def test_opening_a_browser_without_one_installed_explains(client) -> None:
    from app import browser as browser_module

    with mock.patch.object(browser_module, "find_browser", return_value=None):
        response = client.post("/api/browser", json={})
    assert response.status_code == 409
    assert "Chrome" in response.json()["detail"]


def test_the_browser_profile_can_be_thrown_away(client) -> None:
    from app import browser as browser_module

    settings = client.app.state.settings
    profile = browser_module.profile_dir(settings.data_dir)
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "Cookies").write_text("session")

    assert client.delete("/api/browser/profile").json()["cleared"] is True
    assert not profile.exists()
    assert client.delete("/api/browser/profile").json()["cleared"] is False


# --- code generation ------------------------------------------------------


def test_codegen_from_a_stored_flow_uses_its_real_headers(client) -> None:
    """The point of rendering server-side: the summary a table holds has
    no headers or body, so code built from it would not reproduce the
    request."""
    seed(
        client,
        "f1",
        method="POST",
        request_headers=[("Cookie", "session=secret"), ("X-Trace", "1")],
        request_body=b"a=1",
    )
    text = client.post("/api/codegen", json={"kind": "curl", "flow_id": "f1"}).json()[
        "text"
    ]
    assert "Cookie: session=secret" in text
    assert "X-Trace: 1" in text
    assert "a=1" in text


def test_codegen_rebuilds_the_url_from_a_stored_flow(client) -> None:
    """A record keeps the parts, not the URL. Reading a 'url' field that
    is not there produced a curl command that requested nothing."""
    seed(client, "f2", host="example.com", path="/a", scheme="https", port=443)
    text = client.post("/api/codegen", json={"kind": "curl", "flow_id": "f2"}).json()[
        "text"
    ]
    assert "https://example.com/a" in text


def test_codegen_keeps_the_query_string(client) -> None:
    seed(client, "f3", host="example.com", path="/s", query="q=1&r=2")
    text = client.post("/api/codegen", json={"kind": "curl", "flow_id": "f3"}).json()[
        "text"
    ]
    assert "?q=1&r=2" in text


def test_codegen_leaves_off_a_default_port(client) -> None:
    seed(client, "f4", host="example.com", path="/a", scheme="https", port=443)
    text = client.post("/api/codegen", json={"kind": "curl", "flow_id": "f4"}).json()[
        "text"
    ]
    assert ":443" not in text


def test_codegen_keeps_a_nonstandard_port(client) -> None:
    seed(client, "f5", host="example.com", path="/a", scheme="http", port=8080)
    text = client.post("/api/codegen", json={"kind": "curl", "flow_id": "f5"}).json()[
        "text"
    ]
    assert "example.com:8080" in text


def test_codegen_from_an_unsaved_request(client) -> None:
    """Replay and Fuzzer send the request being edited, which has no id."""
    response = client.post(
        "/api/codegen",
        json={
            "kind": "python",
            "url": "https://x.test/a",
            "method": "PUT",
            "headers": [["X-A", "1"]],
            "body": "hi",
        },
    )
    text = response.json()["text"]
    assert '"PUT"' in text
    assert '"X-A": "1"' in text


def test_codegen_rejects_an_unknown_format(client) -> None:
    response = client.post(
        "/api/codegen", json={"kind": "perl", "url": "https://x.test/"}
    )
    assert response.status_code == 400


def test_codegen_needs_something_to_render(client) -> None:
    assert client.post("/api/codegen", json={"kind": "curl"}).status_code == 400


def test_codegen_on_a_missing_flow_is_a_404(client) -> None:
    response = client.post("/api/codegen", json={"kind": "curl", "flow_id": "nope"})
    assert response.status_code == 404


def test_codegen_formats_are_listed_for_the_menu(client) -> None:
    formats = client.get("/api/codegen/formats").json()["formats"]
    kinds = {f["kind"] for f in formats}
    assert {"curl", "fetch", "python", "csrf"} <= kinds
    assert all(f["source"] == "builtin" for f in formats)


def test_opening_a_csrf_poc_refuses_an_unforgeable_request(client) -> None:
    """A blank page would look like the tool failing rather than the
    request being impossible to forge from another site."""
    response = client.post(
        "/api/codegen/csrf/open",
        json={
            "kind": "csrf",
            "url": "https://api.test/x",
            "method": "POST",
            "headers": [["Content-Type", "application/json"]],
            "body": "{}",
        },
    )
    assert response.status_code == 409
    assert "cannot be forged" in response.json()["detail"]


def test_opening_a_csrf_poc_writes_the_page(client, monkeypatch) -> None:
    """The page has to exist on disk before a browser can be sent to it."""
    from app import browser

    opened: dict[str, object] = {}

    def fake_launch(**kwargs):
        opened.update(kwargs)
        return {"browser": "test"}

    monkeypatch.setattr(browser, "launch", fake_launch)
    response = client.post(
        "/api/codegen/csrf/open",
        json={
            "kind": "csrf",
            "url": "https://bank.test/transfer",
            "method": "POST",
            "headers": [["Content-Type", "application/x-www-form-urlencoded"]],
            "body": "to=attacker",
        },
    )
    assert response.status_code == 200
    from pathlib import Path

    written = Path(response.json()["path"])
    assert 'value="attacker"' in written.read_text(encoding="utf-8")
    # Opened through the proxy, so the forged request lands in the history.
    assert str(opened["url"]).startswith("file://")


def test_sitemap_can_include_paths(client) -> None:
    """The site map tree needs every host's paths. Fetching them one host
    at a time meant a request and a query per host, which took seconds on
    a real capture and grew with every new host."""
    seed(client, "s1", host="a.com", path="/one")
    seed(client, "s2", host="a.com", path="/two")
    seed(client, "s3", host="b.com", path="/x")
    sites = client.get("/api/sitemap?with_paths=true").json()["sites"]
    by_host = {s["host"]: s for s in sites}
    assert {p["path"] for p in by_host["a.com"]["path_items"]} == {"/one", "/two"}
    assert {p["path"] for p in by_host["b.com"]["path_items"]} == {"/x"}


def test_sitemap_leaves_paths_out_by_default(client) -> None:
    """Callers that only want the host list should not pay for the rest."""
    seed(client, "s1", host="a.com", path="/one")
    sites = client.get("/api/sitemap").json()["sites"]
    assert "path_items" not in sites[0]


def test_sitemap_paths_match_the_per_site_endpoint(client) -> None:
    """The two have to agree, or the tree changes shape depending on
    which one produced it."""
    seed(client, "s1", host="a.com", path="/one", method="GET", scheme="https", port=443)
    seed(client, "s2", host="a.com", path="/two", method="POST", scheme="https", port=443)
    combined = client.get("/api/sitemap?with_paths=true").json()["sites"][0]
    single = client.get("/api/sitemap/paths?host=a.com&scheme=https&port=443")
    assert single.json()["items"] == combined["path_items"]


def test_sitemap_is_one_query_regardless_of_host_count(client) -> None:
    """A site with no recorded paths still appears, rather than being
    dropped because the grouped lookup had no row for it."""
    seed(client, "s1", host="a.com", path="/one")
    seed(client, "s2", host="b.com", path=None)
    hosts = {
        s["host"] for s in client.get("/api/sitemap?with_paths=true").json()["sites"]
    }
    assert hosts == {"a.com", "b.com"}


# --- build information -----------------------------------------------------


def test_about_reports_the_version(client) -> None:
    data = client.get("/api/about").json()
    assert data["version"]


def test_about_identifies_the_build_not_just_the_version(client) -> None:
    """Every nightly this month says 0.1.0, so the version alone does not
    tell anyone which build they are running."""
    data = client.get("/api/about").json()
    assert "commit" in data
    assert "release" in data


def test_about_shortens_the_commit_for_pasting(client) -> None:
    data = client.get("/api/about").json()
    if data["commit"]:
        assert data["commit_short"] == data["commit"][:7]


def test_about_does_not_claim_to_be_a_release_without_one(client) -> None:
    """A build from a checkout is not the last release that happened to
    be tagged."""
    data = client.get("/api/about").json()
    expected = "release" if data["release"] else "development"
    assert data["source"] == expected


def test_updates_reports_what_github_published(client) -> None:
    """The check is a fact and a link, never an install."""
    from app import updates

    updates.reset_cache()
    releases = [
        {
            "tag_name": "nightly",
            "name": "Nightly 20260928 (f2b2e22)",
            "target_commitish": "f2b2e22b1fddabc0d3bd32c4abd5b0a813dcef62",
            "html_url": "https://example.invalid/nightly",
            "prerelease": True,
        }
    ]
    with mock.patch.object(
        updates, "_fetch_releases", mock.AsyncMock(return_value=releases)
    ), mock.patch.object(updates, "_compare", mock.AsyncMock(return_value="ahead")):
        data = client.get("/api/updates?channel=nightly").json()
    assert data["latest"]["commit_short"] == "f2b2e22"
    assert "update_available" in data
    assert data["download_url"]
    updates.reset_cache()


def test_updates_refuses_a_channel_it_does_not_have(client) -> None:
    assert client.get("/api/updates?channel=beta").status_code == 400


def test_updates_says_why_it_could_not_ask(client) -> None:
    """Offline is the common case, and the reason belongs on screen."""
    from app import updates

    updates.reset_cache()
    with mock.patch.object(
        updates,
        "_fetch_releases",
        mock.AsyncMock(side_effect=updates.UpdateError("could not reach GitHub")),
    ):
        response = client.get("/api/updates")
    assert response.status_code == 502
    assert "GitHub" in response.json()["detail"]
    updates.reset_cache()


def test_export_streams_flows_across_batches_in_history_order(client) -> None:
    for index in range(5):
        seed(client, f"flow-{index}", started_at=index + 1, path=f"/{index}")
    with mock.patch("app.api.server.EXPORT_BATCH_SIZE", 2):
        response = client.get("/api/project/export")
    assert response.status_code == 200
    exported = response.json()
    assert [flow["id"] for flow in exported["flows"]] == [f"flow-{index}" for index in range(4, -1, -1)]
    assert exported["format"] == "lanius-project"


def test_export_without_flows_is_plain_json(client) -> None:
    seed(client, "only")
    exported = client.get("/api/project/export?include_flows=false").json()
    assert "flows" not in exported
    assert exported["format"] == "lanius-project"


def test_export_of_empty_project_has_empty_flow_list(client) -> None:
    assert client.get("/api/project/export").json()["flows"] == []
