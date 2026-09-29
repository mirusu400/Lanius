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
    res = client.post("/api/scope/from-url", json={"url": "bad host"})
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


def test_sitemap_paths_are_paged_and_can_target_a_folder(client) -> None:
    for path in ("/api/a", "/api/b", "/other"):
        seed(client, host="a.test", path=path)
    page = client.get("/api/sitemap/paths", params={
        "host": "a.test", "scheme": "https", "port": 443,
        "path_prefix": "/api", "limit": 1, "offset": 1,
    }).json()
    assert page["count"] == 2
    assert len(page["items"]) == 1
    assert page["items"][0]["path"] == "/api/b"


def test_sitemap_discovers_folders_outside_the_first_flow_page(client) -> None:
    for i in range(205):
        seed(client, host="a.test", path=f"/aaa/{i:03d}")
    seed(client, host="a.test", path="/zzz/old")
    first = client.get("/api/sitemap/paths", params={
        "host": "a.test", "scheme": "https", "port": 443,
    }).json()
    assert all(not row["path"].startswith("/zzz") for row in first["items"])
    folders = client.get("/api/sitemap/folders", params={
        "host": "a.test", "scheme": "https", "port": 443, "limit": 1,
    }).json()
    assert folders == {"items": ["/aaa"], "has_more": True}
    next_page = client.get("/api/sitemap/folders", params={
        "host": "a.test", "scheme": "https", "port": 443,
        "limit": 1, "offset": 1,
    }).json()
    assert next_page == {"items": ["/zzz"], "has_more": False}
    child = client.get("/api/sitemap/folders", params={
        "host": "a.test", "scheme": "https", "port": 443,
        "path_prefix": "/zzz",
    }).json()
    assert child["items"] == ["/zzz/old"]


def test_sitemap_folder_names_do_not_hide_dotted_or_dashed_siblings(client) -> None:
    for path in ("/api", "/api-v2", "/api.json", "/api/child"):
        seed(client, host="a.test", path=path)
    folders = client.get("/api/sitemap/folders", params={
        "host": "a.test", "scheme": "https", "port": 443,
    }).json()
    assert folders["items"] == ["/api", "/api-v2", "/api.json"]


def test_sitemap_scope_applies_to_requests_and_discovered_folders(client) -> None:
    for path in ("/allow/a", "/allow/b", "/deny/c"):
        seed(client, host="a.test", path=path)
    client.post("/api/scope/rules", json={
        "host": "a.test", "path": "/allow/*", "kind": "include",
    })
    page = client.get("/api/sitemap/paths", params={
        "host": "a.test", "scheme": "https", "port": 443,
        "in_scope_only": True, "limit": 1, "offset": 1,
    }).json()
    assert page["count"] == 2
    assert [item["path"] for item in page["items"]] == ["/allow/b"]
    folders = client.get("/api/sitemap/folders", params={
        "host": "a.test", "scheme": "https", "port": 443,
        "in_scope_only": True,
    }).json()
    assert folders["items"] == ["/allow"]


def test_sitemap_site_list_does_not_load_all_flows(client, monkeypatch) -> None:
    seed(client, host="a.test", path="/one")

    def fail() -> None:
        raise AssertionError("site list loaded every flow")

    monkeypatch.setattr(client.app.state.store, "paths_by_site", fail)
    response = client.get("/api/sitemap")
    assert response.status_code == 200
    assert response.json()["sites"][0]["flows"] == 1


def test_legacy_combined_sitemap_refuses_a_large_capture(client, monkeypatch) -> None:
    monkeypatch.setattr(client.app.state.store, "count", lambda: 50_001)
    response = client.get("/api/sitemap?with_paths=true")
    assert response.status_code == 413


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


def test_endpoints_include_old_flows_and_page_groups(client) -> None:
    seed(client, path="/legacy", started_at=1)
    for i in range(5001):
        seed(client, path="/new", started_at=100 + i)
    first = client.get("/api/endpoints", params={"limit": 1}).json()
    second = client.get("/api/endpoints", params={"limit": 1, "offset": 1}).json()
    assert first["count"] == second["count"] == 2
    groups = first["items"] + second["items"]
    assert {group["template"]: group["count"] for group in groups} == {
        "/legacy": 1, "/new": 5001,
    }
    requests = client.get("/api/endpoints/flows", params={
        "scheme": "https", "host": "api.test", "port": 443,
        "method": "GET", "template": "/new", "limit": 1, "offset": 5000,
    }).json()
    assert requests["count"] == 5001
    assert len(requests["items"]) == 1


def test_endpoints_respect_scope_filter(client) -> None:
    seed(client, host="a.test", path="/a")
    seed(client, host="b.test", path="/b")
    client.post("/api/scope/rules", json={"host": "a.test"})
    items = client.get("/api/endpoints", params={"in_scope_only": True}).json()["items"]
    assert {i["host"] for i in items} == {"a.test"}


def test_endpoint_detail_scope_filters_every_path_in_the_template(client) -> None:
    seed(client, host="api.test", path="/users/1")
    seed(client, host="api.test", path="/users/2")
    client.post("/api/scope/rules", json={
        "host": "api.test", "path": "/users/1", "kind": "include",
    })
    groups = client.get("/api/endpoints", params={"in_scope_only": True}).json()
    assert groups["items"][0]["count"] == 1
    details = client.get("/api/endpoints/flows", params={
        "scheme": "https", "host": "api.test", "port": 443,
        "method": "GET", "template": "/users/{id}",
        "in_scope_only": True,
    }).json()
    assert details["count"] == 1
    assert [item["path"] for item in details["items"]] == ["/users/1"]


def test_host_scope_keeps_non_slash_requests_out_of_endpoint_groups(client) -> None:
    seed(client, host="api.test", path="/ok")
    seed(client, host="api.test", path="*")
    client.post("/api/scope/rules", json={
        "host": "api.test", "path": "/*", "kind": "include",
    })
    groups = client.get("/api/endpoints", params={"in_scope_only": True}).json()
    assert [group["template"] for group in groups["items"]] == ["/ok"]


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
