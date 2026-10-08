"""Replay tests: these send real requests to a local HTTP server."""

from __future__ import annotations

import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from fastapi.testclient import TestClient

from app.addons.replay import ReplayError, build_flow
from app.api.server import create_app
from app.config import Settings
from app.media_storage import MIB


class Echo(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _respond(self) -> None:
        if self.path == "/media":
            payload = b"x" * (5 * MIB)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length) if length else b""
        payload = (
            f"{self.command} {self.path}\n"
            f"x-probe={self.headers.get('X-Probe')}\n"
            f"body={body.decode()}"
        ).encode()
        self.send_response(200 if self.path != "/missing" else 404)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Server", "echo")
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _respond
    do_POST = _respond
    do_PUT = _respond

    def log_message(self, *args: object) -> None:  # silence
        pass


@pytest.fixture(scope="module")
def echo_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
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
        db_path=tmp_path / "r.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as c:
        yield c


# --- build_flow -----------------------------------------------------------


def test_build_flow_parses_url() -> None:
    flow = build_flow(url="https://example.com:8443/a/b?x=1", method="post")
    assert flow.request.method == "POST"
    assert flow.request.pretty_host == "example.com"
    assert flow.request.port == 8443
    assert flow.request.path == "/a/b?x=1"
    assert flow.request.scheme == "https"


def test_build_flow_defaults_host_header() -> None:
    flow = build_flow(url="http://example.com/")
    assert flow.request.headers["host"] == "example.com"


def test_build_flow_keeps_explicit_headers_and_body() -> None:
    flow = build_flow(
        url="http://example.com/",
        method="POST",
        headers=[["X-Probe", "1"], ["Host", "spoofed.com"]],
        body="hello",
    )
    assert flow.request.headers["X-Probe"] == "1"
    assert flow.request.headers["Host"] == "spoofed.com"
    assert flow.request.content == b"hello"


def test_build_flow_rejects_bad_urls() -> None:
    for bad in ["", "ftp://a.com/", "not-a-url", "http:///nohost"]:
        with pytest.raises(ReplayError):
            build_flow(url=bad)


# --- real sends -----------------------------------------------------------


def test_large_media_is_forwarded_in_full_but_storage_obeys_live_limit(client, echo_server) -> None:
    engine = client.app.state.engine
    proxy = f"http://127.0.0.1:{engine.settings.proxy_port}"
    response = httpx.get(f"{echo_server}/media", proxy=proxy, trust_env=False)
    assert response.status_code == 200 and response.content == b"x" * (5 * MIB)
    deadline = time.monotonic() + 2
    saved = None
    while time.monotonic() < deadline:
        rows = engine.store.list()
        if rows and rows[0].completed_at is not None:
            saved = rows[0]
            break
        time.sleep(0.01)
    assert saved is not None and saved.response_body_omitted
    assert saved.response_body == b"" and saved.response_size == 5 * MIB
    client.patch("/api/capture-storage", json={"media_body_limit_mb": 6})
    replayed = client.post("/api/replay/send", json={"url": f"{echo_server}/media"}).json()
    assert replayed["body_omitted"] is False
    assert engine.store.get_body_bytes(replayed["id"], "response") == response.content


def test_replay_reports_omitted_media_without_returning_body_for_autosave(client, echo_server) -> None:
    response = client.post("/api/replay/send", json={"url": f"{echo_server}/media"})
    assert response.status_code == 200
    replayed = response.json()
    assert replayed["body_omitted"] is True and replayed["body"] == ""
    assert replayed["size"] == 5 * MIB
    assert replayed["headers"] and replayed["status_code"] == 200
    assert client.app.state.engine.store.get(replayed["id"]).response_body_omitted


def test_send_reaches_a_real_server(client, echo_server) -> None:
    res = client.post(
        "/api/replay/send",
        json={"url": f"{echo_server}/hello", "headers": [["X-Probe", "42"]]},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status_code"] == 200
    assert "GET /hello" in data["body"]
    assert "x-probe=42" in data["body"]
    assert data["duration_ms"] is not None


def test_send_post_body(client, echo_server) -> None:
    data = client.post(
        "/api/replay/send",
        json={"url": f"{echo_server}/p", "method": "POST", "body": "a=1"},
    ).json()
    assert "POST /p" in data["body"]
    assert "body=a=1" in data["body"]


def test_send_preserves_non_200_status(client, echo_server) -> None:
    data = client.post(
        "/api/replay/send", json={"url": f"{echo_server}/missing"}
    ).json()
    assert data["status_code"] == 404


def test_sent_request_is_recorded_in_history(client, echo_server) -> None:
    sent = client.post(
        "/api/replay/send", json={"url": f"{echo_server}/recorded"}
    ).json()
    stored = client.get(f"/api/flows/{sent['id']}").json()
    assert stored["source"] == "replay"
    assert stored["path"] == "/recorded"
    assert stored["status_code"] == 200
    assert stored["local_source_ip"] == "127.0.0.1"


def test_send_rejects_invalid_url(client) -> None:
    res = client.post("/api/replay/send", json={"url": "nope"})
    assert res.status_code == 400


def test_send_reports_connection_errors(client) -> None:
    dead = free_port()
    data = client.post(
        "/api/replay/send", json={"url": f"http://127.0.0.1:{dead}/"}
    ).json()
    assert data["status_code"] is None
    assert data["error"]


def test_repeated_sends_are_independent(client, echo_server) -> None:
    first = client.post(
        "/api/replay/send", json={"url": f"{echo_server}/one"}
    ).json()
    second = client.post(
        "/api/replay/send", json={"url": f"{echo_server}/two"}
    ).json()
    assert first["id"] != second["id"]
    assert "/one" in first["body"]
    assert "/two" in second["body"]


def test_build_flow_rejects_malformed_header_entry() -> None:
    with pytest.raises(ReplayError):
        build_flow(url="http://example.com/", headers=[["only-one"]])


def test_content_length_is_set_for_bodies(client, echo_server) -> None:
    data = client.post(
        "/api/replay/send",
        json={"url": f"{echo_server}/cl", "method": "POST", "body": "12345"},
    ).json()
    assert "body=12345" in data["body"]
