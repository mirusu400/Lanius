"""Intruder tests — attacks run against a real local HTTP server."""

from __future__ import annotations

import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app.addons.intruder import (
    IntruderError,
    apply_payloads,
    count_requests,
    find_positions,
    generate_payload_tuples,
    parse_request_template,
    strip_markers,
)
from app.api.server import create_app
from app.config import Settings

MARK = "\u00a7"


class Target(BaseHTTPRequestHandler):
    """A tiny app with one 'valid' credential, so an attack can find it."""

    protocol_version = "HTTP/1.1"
    hits: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        Target.hits.append(self.path)
        if self.path == "/login?user=admin&pw=letmein":
            body, status = b"welcome admin", 200
        elif self.path.startswith("/login"):
            body, status = b"denied", 403
        else:
            body, status = b"not found", 404
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture(scope="module")
def target():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Target)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


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
        db_path=tmp_path / "i.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as c:
        yield c


# --- positions ------------------------------------------------------------


def test_find_positions() -> None:
    positions = find_positions(f"GET /a?x={MARK}1{MARK}&y={MARK}2{MARK} HTTP/1.1")
    assert [p.value for p in positions] == ["1", "2"]


def test_find_positions_none() -> None:
    assert find_positions("GET / HTTP/1.1") == []


def test_unbalanced_marker_raises() -> None:
    with pytest.raises(IntruderError):
        find_positions(f"GET /a?x={MARK}1 HTTP/1.1")


def test_strip_markers_restores_base_request() -> None:
    template = f"GET /a?x={MARK}base{MARK} HTTP/1.1"
    assert strip_markers(template) == "GET /a?x=base HTTP/1.1"


def test_apply_payloads_substitutes_each_position() -> None:
    template = f"GET /a?x={MARK}1{MARK}&y={MARK}2{MARK} HTTP/1.1"
    assert apply_payloads(template, ["A", "B"]) == "GET /a?x=A&y=B HTTP/1.1"


def test_apply_payloads_none_keeps_base_value() -> None:
    template = f"GET /a?x={MARK}base{MARK}&y={MARK}other{MARK} HTTP/1.1"
    assert apply_payloads(template, ["A", None]) == "GET /a?x=A&y=other HTTP/1.1"


def test_apply_payloads_rejects_wrong_count() -> None:
    with pytest.raises(IntruderError):
        apply_payloads(f"GET /{MARK}a{MARK} HTTP/1.1", ["x", "y"])


# --- attack types ---------------------------------------------------------


def test_sniper_walks_one_position_at_a_time() -> None:
    tuples = list(generate_payload_tuples("sniper", 2, [["a", "b"]]))
    assert len(tuples) == 4
    assert tuples[0][0] == ["a", None]
    assert tuples[2][0] == [None, "a"]
    assert count_requests("sniper", 2, [["a", "b"]]) == 4


def test_battering_ram_uses_one_payload_everywhere() -> None:
    tuples = list(generate_payload_tuples("battering_ram", 3, [["a", "b"]]))
    assert [t[0] for t in tuples] == [["a", "a", "a"], ["b", "b", "b"]]
    assert count_requests("battering_ram", 3, [["a", "b"]]) == 2


def test_pitchfork_zips_sets() -> None:
    tuples = list(
        generate_payload_tuples("pitchfork", 2, [["u1", "u2"], ["p1", "p2", "p3"]])
    )
    assert [t[0] for t in tuples] == [["u1", "p1"], ["u2", "p2"]]
    assert count_requests("pitchfork", 2, [["u1", "u2"], ["p1", "p2", "p3"]]) == 2


def test_cluster_bomb_is_a_cartesian_product() -> None:
    tuples = list(
        generate_payload_tuples("cluster_bomb", 2, [["u1", "u2"], ["p1", "p2"]])
    )
    assert len(tuples) == 4
    assert ["u2", "p1"] in [t[0] for t in tuples]
    assert count_requests("cluster_bomb", 2, [["u1", "u2"], ["p1", "p2"]]) == 4


def test_counts_reject_missing_positions_or_payloads() -> None:
    with pytest.raises(IntruderError):
        count_requests("sniper", 0, [["a"]])
    with pytest.raises(IntruderError):
        count_requests("sniper", 1, [])


def test_multi_position_modes_need_enough_sets() -> None:
    with pytest.raises(IntruderError):
        count_requests("pitchfork", 2, [["a"]])
    with pytest.raises(IntruderError):
        count_requests("cluster_bomb", 2, [["a"]])


# --- request parsing ------------------------------------------------------


def test_parse_request_template() -> None:
    payload = parse_request_template(
        "http://h:1", "POST /login HTTP/1.1\nHost: h\nX: 1\n\nuser=a"
    )
    assert payload["url"] == "http://h:1/login"
    assert payload["method"] == "POST"
    assert payload["headers"] == [["Host", "h"], ["X", "1"]]
    assert payload["body"] == "user=a"


def test_parse_request_template_rejects_garbage() -> None:
    with pytest.raises(IntruderError):
        parse_request_template("http://h", "")
    with pytest.raises(IntruderError):
        parse_request_template("http://h", "GET\n\n")


# --- API + real attacks ---------------------------------------------------


def test_positions_endpoint(client) -> None:
    data = client.post(
        "/api/intruder/positions",
        json={"template": f"GET /a?x={MARK}1{MARK} HTTP/1.1"},
    ).json()
    assert data["count"] == 1
    assert data["preview"] == "GET /a?x=1 HTTP/1.1"


def test_positions_endpoint_rejects_unbalanced(client) -> None:
    res = client.post(
        "/api/intruder/positions", json={"template": f"GET /{MARK}x HTTP/1.1"}
    )
    assert res.status_code == 400


def test_plan_endpoint_counts_requests(client) -> None:
    data = client.post(
        "/api/intruder/plan",
        json={
            "url": "http://h",
            "template": f"GET /?u={MARK}a{MARK}&p={MARK}b{MARK} HTTP/1.1",
            "attack_type": "cluster_bomb",
            "payload_sets": [["1", "2"], ["x", "y", "z"]],
        },
    ).json()
    assert data["total"] == 6


def test_plan_rejects_unknown_attack_type(client) -> None:
    res = client.post(
        "/api/intruder/plan",
        json={
            "url": "http://h",
            "template": f"GET /{MARK}a{MARK} HTTP/1.1",
            "attack_type": "howitzer",
            "payload_sets": [["1"]],
        },
    )
    assert res.status_code == 400


def wait_for(client, attack_id: str, timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(f"/api/intruder/attacks/{attack_id}").json()
        if data["status"] in ("completed", "failed", "stopped"):
            return data
        time.sleep(0.05)
    raise AssertionError(f"attack {attack_id} did not finish: {data}")


def test_sniper_attack_finds_the_valid_password(client, target) -> None:
    Target.hits.clear()
    template = f"GET /login?user=admin&pw={MARK}guess{MARK} HTTP/1.1\nHost: t\n\n"
    started = client.post(
        "/api/intruder/attacks",
        json={
            "url": target,
            "template": template,
            "attack_type": "sniper",
            "payload_sets": [["wrong1", "letmein", "wrong2"]],
        },
    ).json()

    done = wait_for(client, started["id"])
    assert done["status"] == "completed"
    assert done["completed"] == 3

    by_payload = {r["payloads"][0]: r for r in done["results"]}
    assert by_payload["letmein"]["status_code"] == 200
    assert by_payload["wrong1"]["status_code"] == 403
    assert by_payload["letmein"]["length"] == len(b"welcome admin")
    # every payload really hit the server
    assert len(Target.hits) >= 3


def test_cluster_bomb_attack_sends_every_combination(client, target) -> None:
    template = (
        f"GET /login?user={MARK}u{MARK}&pw={MARK}p{MARK} HTTP/1.1\nHost: t\n\n"
    )
    started = client.post(
        "/api/intruder/attacks",
        json={
            "url": target,
            "template": template,
            "attack_type": "cluster_bomb",
            "payload_sets": [["admin", "guest"], ["letmein", "nope"]],
        },
    ).json()
    done = wait_for(client, started["id"])
    assert done["completed"] == 4
    hits = {tuple(r["payloads"]): r["status_code"] for r in done["results"]}
    assert hits[("admin", "letmein")] == 200
    assert hits[("guest", "letmein")] == 403


def test_results_are_ordered_by_index(client, target) -> None:
    template = f"GET /login?user=admin&pw={MARK}x{MARK} HTTP/1.1\nHost: t\n\n"
    started = client.post(
        "/api/intruder/attacks",
        json={
            "url": target,
            "template": template,
            "payload_sets": [[f"p{i}" for i in range(10)]],
        },
    ).json()
    done = wait_for(client, started["id"])
    assert [r["index"] for r in done["results"]] == list(range(10))


def test_attack_is_listed_and_retrievable(client, target) -> None:
    started = client.post(
        "/api/intruder/attacks",
        json={
            "url": target,
            "template": f"GET /login?pw={MARK}a{MARK} HTTP/1.1\nHost: t\n\n",
            "payload_sets": [["a"]],
        },
    ).json()
    wait_for(client, started["id"])
    listed = client.get("/api/intruder/attacks").json()["items"]
    assert started["id"] in [a["id"] for a in listed]


def test_unknown_attack_404(client) -> None:
    assert client.get("/api/intruder/attacks/nope").status_code == 404
    assert client.post("/api/intruder/attacks/nope/stop").status_code == 404


def test_attack_reports_connection_errors(client) -> None:
    dead = free_port()
    started = client.post(
        "/api/intruder/attacks",
        json={
            "url": f"http://127.0.0.1:{dead}",
            "template": f"GET /{MARK}a{MARK} HTTP/1.1\nHost: t\n\n",
            "payload_sets": [["x", "y"]],
        },
    ).json()
    done = wait_for(client, started["id"])
    assert done["status"] == "completed"
    assert all(r["error"] for r in done["results"])


def test_attack_without_positions_is_rejected(client, target) -> None:
    res = client.post(
        "/api/intruder/attacks",
        json={
            "url": target,
            "template": "GET /login HTTP/1.1\nHost: t\n\n",
            "payload_sets": [["a"]],
        },
    )
    assert res.status_code == 400


def test_oversized_attack_is_rejected(client) -> None:
    res = client.post(
        "/api/intruder/plan",
        json={
            "url": "http://h",
            "template": f"GET /?a={MARK}1{MARK}&b={MARK}2{MARK} HTTP/1.1",
            "attack_type": "cluster_bomb",
            "payload_sets": [[str(i) for i in range(1000)]] * 2,
        },
    )
    assert res.status_code == 400
    assert "limit" in res.json()["detail"]


def test_attack_results_are_recorded_as_flows(client, target) -> None:
    started = client.post(
        "/api/intruder/attacks",
        json={
            "url": target,
            "template": f"GET /login?pw={MARK}a{MARK} HTTP/1.1\nHost: t\n\n",
            "payload_sets": [["traceable"]],
        },
    ).json()
    done = wait_for(client, started["id"])
    flow_id = done["results"][0]["flow_id"]
    stored = client.get(f"/api/flows/{flow_id}").json()
    assert stored["source"] == "repeater"
    assert "traceable" in (stored["query"] or "")
