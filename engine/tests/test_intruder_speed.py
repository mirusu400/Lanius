"""How hard an attack pushes the target, and where payloads come from.

Concurrency was fixed at five with no way to change it, so an attack
either crawled against a delicate target or hammered one that could not
take it. These check the setting is honoured, measured against a server
that reports how many requests overlapped.
"""

from __future__ import annotations

import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app.addons.intruder import MAX_CONCURRENCY, AttackSpeed, IntruderError
from app.api.server import create_app
from app.config import Settings

MARK = "\u00a7"


class Counting(BaseHTTPRequestHandler):
    """Records how many requests were in flight at once."""

    protocol_version = "HTTP/1.1"
    lock = threading.Lock()
    live = 0
    peak = 0

    def do_GET(self) -> None:  # noqa: N802
        with Counting.lock:
            Counting.live += 1
            Counting.peak = max(Counting.peak, Counting.live)
        # Long enough that overlap shows up as overlap, not as a race.
        time.sleep(0.05)
        with Counting.lock:
            Counting.live -= 1
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture()
def target():
    Counting.live = Counting.peak = 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), Counting)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


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


def attack(client, target, payloads, **speed):
    body = {
        "url": target,
        "template": f"GET /p={MARK}x{MARK} HTTP/1.1\r\nHost: t\r\n\r\n",
        "attack_type": "sniper",
        "payload_sets": [payloads],
        **speed,
    }
    started = client.post("/api/intruder/attacks", json=body)
    assert started.status_code == 200, started.text
    attack_id = started.json()["id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        state = client.get(f"/api/intruder/attacks/{attack_id}").json()
        if state["status"] in {"completed", "failed", "stopped"}:
            return state
        time.sleep(0.05)
    raise AssertionError("attack did not finish")


class TestConcurrency:
    def test_one_at_a_time_never_overlaps(self, client, target) -> None:
        """A target that cannot take parallel load has to be respected."""
        attack(client, target, [str(i) for i in range(6)], concurrency=1)
        assert Counting.peak == 1

    def test_higher_concurrency_really_overlaps(self, client, target) -> None:
        attack(client, target, [str(i) for i in range(12)], concurrency=4)
        assert Counting.peak > 1

    def test_never_exceeds_what_was_asked_for(self, client, target) -> None:
        """A setting that is not honoured is worse than none, because it
        is believed."""
        attack(client, target, [str(i) for i in range(20)], concurrency=3)
        assert Counting.peak <= 3

    def test_throttling_does_not_drop_work(self, client, target) -> None:
        state = attack(client, target, [str(i) for i in range(15)], concurrency=2)
        assert state["completed"] == 15
        assert state["status"] == "completed"

    def test_the_speed_is_reported_back(self, client, target) -> None:
        # So the UI can show what an attack actually ran with.
        state = attack(client, target, ["a", "b"], concurrency=2, delay=0)
        assert state["speed"] == {"concurrency": 2, "delay": 0.0}


class TestDelay:
    def test_a_delay_spaces_requests_out(self, client, target) -> None:
        start = time.monotonic()
        attack(client, target, ["a", "b", "c"], concurrency=1, delay=0.1)
        assert time.monotonic() - start >= 0.3

    def test_no_delay_by_default(self, client, target) -> None:
        start = time.monotonic()
        attack(client, target, ["a", "b"], concurrency=2)
        assert time.monotonic() - start < 2.0


class TestRefusals:
    def test_refuses_concurrency_below_one(self, client, target) -> None:
        body = {
            "url": target,
            "template": f"GET /p={MARK}x{MARK} HTTP/1.1\r\nHost: t\r\n\r\n",
            "payload_sets": [["a"]],
            "concurrency": 0,
        }
        assert client.post("/api/intruder/attacks", json=body).status_code == 400

    def test_refuses_concurrency_that_would_be_a_dos(self, client, target) -> None:
        body = {
            "url": target,
            "template": f"GET /p={MARK}x{MARK} HTTP/1.1\r\nHost: t\r\n\r\n",
            "payload_sets": [["a"]],
            "concurrency": MAX_CONCURRENCY + 1,
        }
        assert client.post("/api/intruder/attacks", json=body).status_code == 400


class TestSpeedLimits:
    def test_rejects_a_negative_delay(self) -> None:
        with pytest.raises(IntruderError):
            AttackSpeed(delay=-1)

    def test_rejects_an_absurd_delay(self) -> None:
        # Beyond a minute an attack is better paused than crawling.
        with pytest.raises(IntruderError):
            AttackSpeed(delay=3600)

    def test_defaults_are_gentle(self) -> None:
        """An attack that knocks a service over tells you nothing."""
        speed = AttackSpeed()
        assert speed.concurrency <= 10
        assert speed.delay == 0
