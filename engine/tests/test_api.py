from __future__ import annotations

import socket
import time

import pytest
from fastapi.testclient import TestClient

from app.api.server import create_app, redact_headers
from app.config import Settings
from app.db.store import FlowRecord


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


def test_list_flows_empty(client) -> None:
    assert client.get("/api/flows").json() == {"items": [], "count": 0}


def test_list_and_filter_flows(client) -> None:
    seed(client, "a", host="a.com")
    seed(client, "b", host="b.com", method="POST")
    items = client.get("/api/flows").json()["items"]
    assert len(items) == 2
    assert client.get("/api/flows?method=POST").json()["items"][0]["id"] == "b"
    assert client.get("/api/flows?host=a.com").json()["count"] == 1


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


def test_redact_headers_none_passthrough() -> None:
    assert redact_headers(None) is None
