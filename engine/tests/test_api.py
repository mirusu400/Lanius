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


def test_clearing_custom_ciphers_restores_the_profile(client) -> None:
    client.post("/api/tls", json={"profile": "chrome", "ciphers": "AES256-SHA"})
    body = client.post("/api/tls", json={"profile": "chrome", "ciphers": ""}).json()
    assert body["custom_ciphers"] is None
    assert "TLS_AES_128_GCM_SHA256" in body["ciphers"]


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
    assert client.get("/api/workspace/repeater").json()["value"] is None


def test_workspace_round_trips(client) -> None:
    """Repeater and Decoder tabs lived only in the browser, so closing
    Lanius threw away whatever you had open."""
    tabs = [{"id": "r1", "title": "login"}]
    client.put("/api/workspace/repeater", json={"value": tabs})
    assert client.get("/api/workspace/repeater").json()["value"] == tabs


def test_workspace_rejects_a_payload_with_no_value(client) -> None:
    assert client.put("/api/workspace/x", json={}).status_code == 422


def test_export_describes_itself(client) -> None:
    data = client.get("/api/project/export").json()
    assert data["format"] == "lanius-project"
    assert data["version"] == 1
    assert "scope" in data and "workspace" in data


def test_export_can_leave_out_the_capture(client) -> None:
    """A long capture dwarfs everything else, and sharing a scope plus a
    set of Repeater requests is the common case."""
    assert "flows" not in client.get(
        "/api/project/export?include_flows=false"
    ).json()


def test_import_restores_scope_workspace_and_flows(client) -> None:
    seed(client, "f1", host="imported.example")
    client.put("/api/workspace/repeater", json={"value": [{"id": "r1"}]})
    client.post("/api/scope/rules", json={"kind": "include", "host": "a.example"})
    exported = client.get("/api/project/export").json()

    client.delete("/api/flows")
    client.put("/api/workspace/repeater", json={"value": []})

    result = client.post("/api/project/import", json=exported).json()
    assert result["ok"] is True
    assert client.get("/api/workspace/repeater").json()["value"] == [{"id": "r1"}]
    assert client.get("/api/flows").json()["count"] == 1


def test_imported_scope_takes_effect_immediately(client) -> None:
    """The scope is held in memory once loaded, so an import that only
    wrote the database would leave the rules doing nothing."""
    client.post("/api/scope/rules", json={"kind": "include", "host": "scoped.example"})
    exported = client.get("/api/project/export?include_flows=false").json()

    client.post("/api/project/import", json=exported)

    rules = client.get("/api/scope").json()["rules"]
    assert [r["host"] for r in rules] == ["scoped.example"]


def test_import_refuses_a_document_that_is_not_a_project(client) -> None:
    assert client.post("/api/project/import", json={"format": "junk"}).status_code == 422


def test_import_refuses_a_future_version(client) -> None:
    """Better to say so than to half-read it."""
    assert (
        client.post(
            "/api/project/import", json={"format": "lanius-project", "version": 99}
        ).status_code
        == 422
    )


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
    blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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


def test_the_api_survives_a_proxy_port_that_is_already_taken(tmp_path) -> None:
    """The failure the released build showed: another tool holding the port
    took the whole app down, so the UI could not even offer a new one."""
    blocker = socket.socket()
    blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
        "https://tauri.localhost",  # Windows
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
        "https://tauri.localhost.evil.test",
        "http://127.0.0.1.evil.test",
    ):
        response = client.get("/api/status", headers={"Origin": origin})
        assert response.headers.get("access-control-allow-origin") is None, (
            f"{origin} must not be allowed to read the engine"
        )
