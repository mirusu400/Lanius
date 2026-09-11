"""Raw TCP capture and Decoder/Comparer API tests (M6)."""

from __future__ import annotations

import socket

import pytest
from fastapi.testclient import TestClient
from mitmproxy.test import tflow

from app.addons.capture import CaptureAddon, tcp_flow_to_record
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowStore
from app.events import EventBroker


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
        db_path=tmp_path / "m6.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as c:
        yield c


# --- raw TCP --------------------------------------------------------------


def make_tcp_flow():
    flow = tflow.ttcpflow()
    return flow


def test_tcp_flow_to_record_splits_directions() -> None:
    flow = make_tcp_flow()
    record = tcp_flow_to_record(flow)
    assert record.type == "tcp"
    assert record.method == "TCP"
    client_bytes = b"".join(m.content for m in flow.messages if m.from_client)
    server_bytes = b"".join(m.content for m in flow.messages if not m.from_client)
    assert record.request_body == client_bytes
    assert record.response_body == server_bytes
    assert record.request_size == len(client_bytes)


def test_tcp_record_has_no_http_status() -> None:
    record = tcp_flow_to_record(make_tcp_flow())
    assert record.status_code is None
    assert record.scheme == "tcp"


def test_tcp_record_counts_messages() -> None:
    flow = make_tcp_flow()
    record = tcp_flow_to_record(flow)
    assert record.comment == f"{len(flow.messages)} messages"


def test_capture_persists_tcp_flows() -> None:
    store = FlowStore()
    addon = CaptureAddon(store, EventBroker())
    flow = make_tcp_flow()
    addon.tcp_message(flow)
    saved = store.get(flow.id)
    assert saved is not None
    assert saved.type == "tcp"
    store.close()


def test_capture_publishes_tcp_events() -> None:
    broker = EventBroker()
    queue = broker.subscribe()
    addon = CaptureAddon(FlowStore(), broker)
    flow = make_tcp_flow()
    addon.tcp_start(flow)
    addon.tcp_message(flow)
    addon.tcp_end(flow)
    assert [queue.get_nowait()["type"] for _ in range(3)] == [
        "tcp.start",
        "tcp.message",
        "tcp.end",
    ]


def test_tcp_flows_appear_in_history(client) -> None:
    flow = make_tcp_flow()
    client.app.state.engine.capture.tcp_message(flow)
    items = client.get("/api/flows").json()["items"]
    assert items[0]["type"] == "tcp"
    assert items[0]["method"] == "TCP"


def test_tcp_error_is_recorded() -> None:
    store = FlowStore()
    addon = CaptureAddon(store, EventBroker())
    flow = tflow.ttcpflow(err=True)
    addon.tcp_error(flow)
    saved = store.get(flow.id)
    assert saved is not None and saved.error
    store.close()


def test_tcp_respects_scope_capture_restriction(client) -> None:
    client.post("/api/scope/rules", json={"host": "nothing-matches.invalid"})
    client.patch("/api/scope", json={"restrict_capture": True})
    client.app.state.engine.capture.tcp_message(make_tcp_flow())
    assert client.get("/api/flows").json()["count"] == 0


# --- decoder API ----------------------------------------------------------


def test_codecs_endpoint(client) -> None:
    data = client.get("/api/codecs").json()
    assert "base64" in data["codecs"]
    assert "sha256" in data["hashes"]


def test_decode_chain_endpoint(client) -> None:
    data = client.post(
        "/api/decode",
        json={
            "value": "aGVsbG8lMjB3b3JsZA==",
            "steps": [
                {"codec": "base64", "direction": "decode"},
                {"codec": "url", "direction": "decode"},
            ],
        },
    ).json()
    assert data["output"] == "hello world"
    assert len(data["steps"]) == 2


def test_decode_with_no_steps_echoes_input(client) -> None:
    data = client.post("/api/decode", json={"value": "abc"}).json()
    assert data["output"] == "abc"


def test_decode_rejects_bad_input(client) -> None:
    res = client.post(
        "/api/decode",
        json={"value": "!!!", "steps": [{"codec": "gzip", "direction": "decode"}]},
    )
    assert res.status_code == 400


def test_decode_rejects_unknown_codec(client) -> None:
    res = client.post(
        "/api/decode",
        json={"value": "x", "steps": [{"codec": "enigma", "direction": "decode"}]},
    )
    assert res.status_code == 400


# --- comparer API ---------------------------------------------------------


def test_compare_endpoint_word_mode(client) -> None:
    data = client.post(
        "/api/compare", json={"left": "a b c", "right": "a x c"}
    ).json()
    assert data["identical"] is False
    assert data["added"] == 1
    assert data["mode"] == "word"


def test_compare_endpoint_byte_mode(client) -> None:
    data = client.post(
        "/api/compare", json={"left": "abc", "right": "abd", "mode": "byte"}
    ).json()
    assert data["unchanged"] == 2


def test_compare_endpoint_rejects_bad_mode(client) -> None:
    res = client.post(
        "/api/compare", json={"left": "a", "right": "b", "mode": "nope"}
    )
    assert res.status_code == 400
