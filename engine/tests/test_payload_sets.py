"""Saved payload sets, and fetching wordlists.

A wordlist used to be pasted into every attack. These check it can be
kept by name and reused, and that fetching one is bounded and honest.
"""

from __future__ import annotations

import socket

import pytest
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.config import Settings
from app.db.payloads import MAX_PAYLOADS, parse_payloads
from app import wordlists

MARK = "\u00a7"


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
        db_path=tmp_path / "p.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as c:
        yield c


class TestParsing:
    def test_one_payload_per_line(self) -> None:
        assert parse_payloads("a\nb\nc") == ["a", "b", "c"]

    def test_drops_blank_lines(self) -> None:
        """They come from how a file ends, not from anything anyone meant
        to send."""
        assert parse_payloads("a\n\nb\n\n") == ["a", "b"]

    def test_keeps_whitespace_inside_a_payload(self) -> None:
        # A payload may be testing exactly that.
        assert parse_payloads("  spaced  \nx") == ["  spaced  ", "x"]

    def test_handles_windows_line_endings(self) -> None:
        assert parse_payloads("a\r\nb\r\n") == ["a", "b"]


class TestStoring:
    def test_saves_and_lists_a_set(self, client) -> None:
        saved = client.post(
            "/api/payload-sets", json={"name": "ids", "payloads": "1\n2\n3"}
        )
        assert saved.status_code == 200
        assert saved.json()["count"] == 3
        items = client.get("/api/payload-sets").json()["items"]
        assert [i["name"] for i in items] == ["ids"]

    def test_the_list_does_not_carry_every_payload(self, client) -> None:
        """A picker needs a name and a size; sending 30,000 entries to
        draw a list is waste."""
        client.post(
            "/api/payload-sets",
            json={"name": "big", "payloads": "\n".join(str(i) for i in range(5000))},
        )
        items = client.get("/api/payload-sets").json()["items"]
        assert "payloads" not in items[0]
        assert items[0]["count"] == 5000

    def test_fetching_one_gives_the_payloads(self, client) -> None:
        set_id = client.post(
            "/api/payload-sets", json={"name": "s", "payloads": "a\nb"}
        ).json()["id"]
        assert client.get(f"/api/payload-sets/{set_id}").json()["payloads"] == ["a", "b"]

    def test_saving_the_same_name_replaces_it(self, client) -> None:
        """Re-importing a wordlist should update it, not leave two sets
        called the same thing."""
        first = client.post(
            "/api/payload-sets", json={"name": "dup", "payloads": "a"}
        ).json()
        second = client.post(
            "/api/payload-sets", json={"name": "dup", "payloads": "a\nb"}
        ).json()
        assert first["id"] == second["id"]
        assert second["count"] == 2
        assert len(client.get("/api/payload-sets").json()["items"]) == 1

    def test_deletes_a_set(self, client) -> None:
        set_id = client.post(
            "/api/payload-sets", json={"name": "gone", "payloads": "a"}
        ).json()["id"]
        assert client.delete(f"/api/payload-sets/{set_id}").status_code == 200
        assert client.get("/api/payload-sets").json()["items"] == []

    def test_refuses_an_empty_set(self, client) -> None:
        r = client.post("/api/payload-sets", json={"name": "empty", "payloads": ""})
        assert r.status_code == 400

    def test_refuses_a_nameless_set(self, client) -> None:
        r = client.post("/api/payload-sets", json={"name": "  ", "payloads": "a"})
        assert r.status_code == 400

    def test_refuses_a_set_too_large_to_belong_in_a_project(self, client) -> None:
        # rockyou is 14 million lines and belongs in a file, not a row.
        body = "\n".join(str(i) for i in range(MAX_PAYLOADS + 1))
        r = client.post("/api/payload-sets", json={"name": "huge", "payloads": body})
        assert r.status_code == 400

    def test_missing_set_is_a_404(self, client) -> None:
        assert client.get("/api/payload-sets/nope").status_code == 404


class TestUsingASetInAnAttack:
    def test_an_attack_can_name_a_saved_set(self, client) -> None:
        """The point of saving one: not posting a wordlist every time."""
        set_id = client.post(
            "/api/payload-sets", json={"name": "w", "payloads": "a\nb\nc"}
        ).json()["id"]
        planned = client.post(
            "/api/intruder/attacks",
            json={
                "url": "http://127.0.0.1:1",
                "template": f"GET /{MARK}x{MARK} HTTP/1.1\r\nHost: t\r\n\r\n",
                "payload_sets": [],
                "payload_set_ids": [set_id],
            },
        )
        assert planned.status_code == 200
        assert planned.json()["total"] == 3

    def test_naming_a_set_that_is_gone_is_a_404(self, client) -> None:
        r = client.post(
            "/api/intruder/attacks",
            json={
                "url": "http://127.0.0.1:1",
                "template": f"GET /{MARK}x{MARK} HTTP/1.1\r\nHost: t\r\n\r\n",
                "payload_set_ids": ["missing"],
            },
        )
        assert r.status_code == 404


class TestWordlistCatalogue:
    def test_lists_what_can_be_fetched(self, client) -> None:
        data = client.get("/api/wordlists").json()
        assert len(data["items"]) > 0
        assert all(i["url"].startswith("https://") for i in data["items"])

    def test_the_source_is_pinned_to_a_tag(self, client) -> None:
        """A wordlist that changes under a saved set makes results from
        different days incomparable."""
        data = client.get("/api/wordlists").json()
        assert data["ref"] != "master"
        assert all(data["ref"] in i["url"] for i in data["items"])

    def test_the_catalogue_is_fixed_not_a_directory_listing(self) -> None:
        # So this cannot be turned into fetching arbitrary repository
        # paths.
        with pytest.raises(wordlists.WordlistError):
            wordlists.find("../../../etc/passwd")

    def test_every_entry_has_a_size_estimate(self, client) -> None:
        # So the size is known before anything is downloaded.
        for item in client.get("/api/wordlists").json()["items"]:
            assert item["approx_lines"] > 0

    def test_importing_an_unknown_list_is_refused(self, client) -> None:
        r = client.post("/api/wordlists/import", json={"list_id": "nope"})
        assert r.status_code == 502
