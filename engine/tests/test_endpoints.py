from __future__ import annotations

from app.addons.endpoints import (
    build_endpoints,
    classify_segment,
    query_params,
    templatize,
)


def flow(path: str, **kwargs) -> dict:
    base = {
        "method": "GET",
        "scheme": "https",
        "host": "api.test",
        "port": 443,
        "path": path,
        "query": None,
        "status_code": 200,
        "started_at": 1.0,
    }
    base.update(kwargs)
    return base


# --- segment classification ----------------------------------------------


def test_classify_numeric_and_uuid() -> None:
    assert classify_segment("42") == "id"
    assert classify_segment("550e8400-e29b-41d4-a716-446655440000") == "uuid"


def test_classify_date_hash_and_token() -> None:
    assert classify_segment("2024-01-31") == "date"
    assert classify_segment("a3f5c9e1b7d2f408") == "hash"
    assert classify_segment("eyJhbGciOiJIUzI1NiwidHlwIjo") == "token"


def test_classify_keeps_real_path_segments() -> None:
    for literal in ["users", "api", "v1", "login", "", "a-b"]:
        assert classify_segment(literal) is None


# --- templating -----------------------------------------------------------


def test_templatize_replaces_ids() -> None:
    template, values = templatize("/users/42/orders/7")
    assert template == "/users/{id}/orders/{id}"
    assert values == ["42", "7"]


def test_templatize_leaves_static_paths_untouched() -> None:
    template, values = templatize("/api/v1/login")
    assert template == "/api/v1/login"
    assert values == []


def test_templatize_handles_root() -> None:
    assert templatize("/")[0] == "/"
    assert templatize("")[0] == "/"


def test_query_params_extracted() -> None:
    assert query_params("page=1&sort=desc") == ["page", "sort"]
    assert query_params(None) == []
    assert query_params("flag") == ["flag"]


# --- grouping -------------------------------------------------------------


def test_flows_with_different_ids_collapse_into_one_endpoint() -> None:
    endpoints = build_endpoints(
        [flow("/users/1"), flow("/users/2"), flow("/users/3")]
    )
    assert len(endpoints) == 1
    assert endpoints[0].template == "/users/{id}"
    assert endpoints[0].count == 3
    assert set(endpoints[0].path_params) == {"1", "2", "3"}


def test_methods_are_grouped_separately() -> None:
    endpoints = build_endpoints(
        [flow("/users/1"), flow("/users/1", method="DELETE")]
    )
    assert {e.method for e in endpoints} == {"GET", "DELETE"}


def test_hosts_are_grouped_separately() -> None:
    endpoints = build_endpoints(
        [flow("/a", host="one.test"), flow("/a", host="two.test")]
    )
    assert len(endpoints) == 2


def test_query_parameters_are_unioned() -> None:
    endpoints = build_endpoints(
        [flow("/search", query="q=a"), flow("/search", query="q=b&page=2")]
    )
    assert endpoints[0].query_params == ["page", "q"]


def test_status_codes_are_collected() -> None:
    endpoints = build_endpoints(
        [flow("/x", status_code=200), flow("/x", status_code=404)]
    )
    assert endpoints[0].statuses == [200, 404]


def test_examples_are_deduplicated_and_capped() -> None:
    endpoints = build_endpoints([flow(f"/users/{i}") for i in range(10)])
    assert len(endpoints[0].as_dict()["examples"]) == 5


def test_last_seen_tracks_the_newest_flow() -> None:
    endpoints = build_endpoints(
        [flow("/x", started_at=10.0), flow("/x", started_at=99.0)]
    )
    assert endpoints[0].last_seen == 99.0


def test_endpoint_key_is_stable_and_unique() -> None:
    endpoints = build_endpoints([flow("/users/1"), flow("/orders/2")])
    keys = [e.key for e in endpoints]
    assert len(set(keys)) == 2
    assert "/orders/{id}" in keys[0] or "/orders/{id}" in keys[1]


def test_build_endpoints_accepts_flow_records() -> None:
    from app.db.store import FlowRecord

    records = [
        FlowRecord(id="a", method="GET", host="h", scheme="https", port=443,
                   path="/items/5", query="x=1", status_code=200, started_at=1.0),
        FlowRecord(id="b", method="GET", host="h", scheme="https", port=443,
                   path="/items/6", status_code=500, started_at=2.0),
    ]
    endpoints = build_endpoints(records)
    assert len(endpoints) == 1
    assert endpoints[0].template == "/items/{id}"
    assert endpoints[0].statuses == [200, 500]
    assert endpoints[0].query_params == ["x"]


def test_empty_input() -> None:
    assert build_endpoints([]) == []
