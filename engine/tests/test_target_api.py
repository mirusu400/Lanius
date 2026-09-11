"""API tests for scope, sitemap and endpoints (M4)."""

from __future__ import annotations

import socket
import time

import pytest
from fastapi.testclient import TestClient
from mitmproxy.test import tflow, tutils

from app.api.server import create_app
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
        db_path=tmp_path / "t.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as c:
        yield c


def seed(client, **kwargs) -> None:
    base = dict(
        id=f"f{time.time_ns()}",
        method="GET",
        scheme="https",
        host="api.test",
        port=443,
        path="/users/1",
        started_at=time.time(),
        status_code=200,
    )
    base.update(kwargs)
    client.app.state.store.upsert(FlowRecord(**base))


# --- scope CRUD -----------------------------------------------------------


def test_scope_starts_empty(client) -> None:
    data = client.get("/api/scope").json()
    assert data["rules"] == []
    assert data["restrict_capture"] is False


def test_add_list_and_delete_a_rule(client) -> None:
    rule = client.post(
        "/api/scope/rules", json={"host": "t.com", "path": "/api/*"}
    ).json()
    assert rule["id"] is not None
    assert client.get("/api/scope").json()["rules"][0]["host"] == "t.com"

    assert client.delete(f"/api/scope/rules/{rule['id']}").status_code == 200
    assert client.get("/api/scope").json()["rules"] == []


def test_add_rule_from_url(client) -> None:
    rule = client.post(
        "/api/scope/from-url", json={"url": "https://api.t.com:8443/v1/users"}
    ).json()
    assert rule["host"] == "api.t.com"
    assert rule["path"] == "/v1/users/*"
    assert rule["port"] == 8443


def test_add_rule_from_bad_url_is_rejected(client) -> None:
    res = client.post("/api/scope/from-url", json={"url": "not-a-url"})
    assert res.status_code == 400


def test_invalid_rule_is_rejected(client) -> None:
    res = client.post("/api/scope/rules", json={"match_type": "fuzzy"})
    assert res.status_code == 400


def test_patch_rule_toggles_enabled(client) -> None:
    rule = client.post("/api/scope/rules", json={"host": "t.com"}).json()
    scope = client.patch(
        f"/api/scope/rules/{rule['id']}", json={"enabled": False}
    ).json()
    assert scope["rules"][0]["enabled"] is False


def test_patch_unknown_rule_404(client) -> None:
    assert client.patch("/api/scope/rules/999", json={"enabled": False}).status_code == 404
    assert client.delete("/api/scope/rules/999").status_code == 404


def test_scope_check_endpoint(client) -> None:
    client.post("/api/scope/rules", json={"host": "t.com", "path": "/api/*"})
    assert client.get("/api/scope/check", params={"url": "https://t.com/api/x"}).json()[
        "in_scope"
    ] is True
    assert client.get("/api/scope/check", params={"url": "https://t.com/z"}).json()[
        "in_scope"
    ] is False
    assert client.get("/api/scope/check", params={"url": "junk"}).status_code == 400


def test_scope_rules_survive_a_restart(tmp_path) -> None:
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "persist.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as first:
        first.post("/api/scope/rules", json={"host": "keeps.com"})

    settings2 = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "persist.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings2)) as second:
        rules = second.get("/api/scope").json()["rules"]
        assert [r["host"] for r in rules] == ["keeps.com"]


# --- capture restriction --------------------------------------------------


def test_capture_restriction_filters_flows(client) -> None:
    client.post("/api/scope/rules", json={"host": "wanted.com"})
    client.patch("/api/scope", json={"restrict_capture": True})

    capture = client.app.state.engine.capture
    inside = tflow.tflow(req=tutils.treq(host="wanted.com"), resp=tutils.tresp())
    outside = tflow.tflow(req=tutils.treq(host="noise.com"), resp=tutils.tresp())
    capture.response(inside)
    capture.response(outside)

    stored = {f["host"] for f in client.get("/api/flows").json()["items"]}
    assert stored == {"wanted.com"}


def test_capture_restriction_off_records_everything(client) -> None:
    client.post("/api/scope/rules", json={"host": "wanted.com"})
    capture = client.app.state.engine.capture
    capture.response(tflow.tflow(req=tutils.treq(host="noise.com"), resp=tutils.tresp()))
    assert client.get("/api/flows").json()["count"] == 1


# --- sitemap / endpoints --------------------------------------------------


def test_sitemap_groups_by_site(client) -> None:
    seed(client, host="a.test", path="/1")
    seed(client, host="a.test", path="/2")
    seed(client, host="b.test", path="/1")
    sites = client.get("/api/sitemap").json()["sites"]
    assert {s["host"] for s in sites} == {"a.test", "b.test"}
    a = next(s for s in sites if s["host"] == "a.test")
    assert a["flows"] == 2
    assert a["in_scope"] is True


def test_sitemap_in_scope_filter(client) -> None:
    seed(client, host="a.test")
    seed(client, host="b.test")
    client.post("/api/scope/rules", json={"host": "a.test"})
    sites = client.get("/api/sitemap", params={"in_scope_only": True}).json()["sites"]
    assert [s["host"] for s in sites] == ["a.test"]


def test_sitemap_paths_for_one_site(client) -> None:
    seed(client, host="a.test", path="/x")
    seed(client, host="a.test", path="/y")
    seed(client, host="b.test", path="/z")
    data = client.get(
        "/api/sitemap/paths", params={"host": "a.test", "scheme": "https"}
    ).json()
    assert {i["path"] for i in data["items"]} == {"/x", "/y"}


def test_endpoints_group_dynamic_paths(client) -> None:
    for i in range(3):
        seed(client, path=f"/users/{i}", query="page=1")
    seed(client, path="/login")

    items = client.get("/api/endpoints").json()["items"]
    templates = {i["template"]: i for i in items}
    assert "/users/{id}" in templates
    assert templates["/users/{id}"]["count"] == 3
    assert templates["/users/{id}"]["query_params"] == ["page"]
    assert "/login" in templates


def test_endpoints_respect_scope_filter(client) -> None:
    seed(client, host="a.test", path="/a")
    seed(client, host="b.test", path="/b")
    client.post("/api/scope/rules", json={"host": "a.test"})
    items = client.get("/api/endpoints", params={"in_scope_only": True}).json()["items"]
    assert {i["host"] for i in items} == {"a.test"}


def test_endpoints_host_filter(client) -> None:
    seed(client, host="a.test", path="/a")
    seed(client, host="b.test", path="/b")
    items = client.get("/api/endpoints", params={"host": "b.test"}).json()["items"]
    assert {i["host"] for i in items} == {"b.test"}


def test_site_is_in_scope_when_any_path_matches(client) -> None:
    """A rule like /users/* must still mark the host as a scope target."""
    seed(client, host="a.test", path="/users/1")
    seed(client, host="a.test", path="/assets/x.js")
    seed(client, host="b.test", path="/other")
    client.post("/api/scope/rules", json={"host": "a.test", "path": "/users/*"})

    sites = {s["host"]: s["in_scope"] for s in client.get("/api/sitemap").json()["sites"]}
    assert sites["a.test"] is True
    assert sites["b.test"] is False


def test_distinct_paths_for_site(client) -> None:
    seed(client, host="a.test", path="/x")
    seed(client, host="a.test", path="/x")
    seed(client, host="a.test", path="/y")
    paths = client.app.state.store.distinct_paths_for_site("https", "a.test", 443)
    assert sorted(paths) == ["/x", "/y"]
