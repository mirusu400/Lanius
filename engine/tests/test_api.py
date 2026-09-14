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


# --- CA / events (final pass) ---------------------------------------------


def test_ca_info_reports_availability(client) -> None:
    data = client.get("/api/ca").json()
    assert "confdir" in data
    assert set(data["available"]) == {"pem", "cer", "p12"}
    assert data["install_url"] == "http://mitm.it"


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
    assert [m["spec"] for m in modes] == ["regular"]
    assert modes[0]["running"] is True
    assert modes[0]["error"] is None


def test_status_reports_local_capture_readiness(client) -> None:
    """The UI needs to distinguish 'not supported' from 'needs approval',
    because mitmproxy reports a blocked local mode as running."""
    state = client.get("/api/status").json()["local_capture"]
    assert set(state) == {"supported", "approved", "detail"}
    assert isinstance(state["supported"], bool)
    assert isinstance(state["approved"], bool)


def test_dashboard_carries_mode_and_capture_state(client) -> None:
    """The dashboard is where a user would notice a mode being down, so it
    must not need a second call to /api/status to find out."""
    data = client.get("/api/dashboard").json()
    assert [m["spec"] for m in data["modes"]] == ["regular"]
    assert set(data["local_capture"]) == {"supported", "approved", "detail"}
