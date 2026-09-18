"""Deleting captured requests.

The history only had "clear everything". A capture is mostly noise, and
the reason to remove some of it is disk: this database is 86MB of mostly
images. So deleting has to actually shrink the file, not just hide rows.
"""

from __future__ import annotations

import socket
import time

import pytest
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowRecord, FlowStore


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
        db_path=tmp_path / "f.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as c:
        seed(c)
        yield c


def add(client, **kwargs) -> None:
    base = dict(
        id=kwargs.pop("id"),
        method="GET",
        scheme="https",
        host="a.test",
        port=443,
        path="/index.html",
        started_at=time.time(),
        status_code=200,
    )
    base.update(kwargs)
    client.app.state.store.upsert(FlowRecord(**base))


def seed(client) -> None:
    add(client, id="1", path="/api/v1/users")
    add(client, id="2", path="/api/v1/login", method="POST")
    add(client, id="3", path="/api/v2/things")
    add(client, id="4", path="/static/logo.png")
    # Same prefix as a word, which a naive LIKE would swallow.
    add(client, id="5", path="/apidocs")
    add(client, id="6", host="b.test", path="/api/v1/users")
    add(client, id="7", host="a.test", port=8443, path="/api/v1/users")


def ids(client) -> set[str]:
    return {i["id"] for i in client.get("/api/flows?limit=500").json()["items"]}


class TestById:
    def test_removes_one(self, client) -> None:
        assert client.post("/api/flows/delete", json={"ids": ["1"]}).json() == {
            "deleted": 1
        }
        assert "1" not in ids(client)

    def test_removes_several_at_once(self, client) -> None:
        # A selection is several rows; one request per row would be a
        # burst of writes and a partial result if one failed.
        response = client.post("/api/flows/delete", json={"ids": ["1", "2", "3"]})
        assert response.json()["deleted"] == 3
        assert {"1", "2", "3"}.isdisjoint(ids(client))

    def test_leaves_everything_else(self, client) -> None:
        before = ids(client)
        client.post("/api/flows/delete", json={"ids": ["1"]})
        assert ids(client) == before - {"1"}

    def test_an_unknown_id_deletes_nothing(self, client) -> None:
        assert client.post("/api/flows/delete", json={"ids": ["nope"]}).json() == {
            "deleted": 0
        }

    def test_the_flow_is_really_gone(self, client) -> None:
        client.post("/api/flows/delete", json={"ids": ["1"]})
        assert client.get("/api/flows/1").status_code == 404


class TestByHost:
    def test_removes_a_whole_host(self, client) -> None:
        response = client.post("/api/flows/delete", json={"host": "b.test"})
        assert response.json()["deleted"] == 1
        assert "6" not in ids(client)

    def test_keeps_other_hosts(self, client) -> None:
        client.post("/api/flows/delete", json={"host": "b.test"})
        assert {"1", "2", "3", "4", "5", "7"} <= ids(client)

    def test_a_port_distinguishes_two_sites(self, client) -> None:
        # The site map shows a:443 and a:8443 as separate sites, so
        # deleting one must not take the other.
        client.post("/api/flows/delete", json={"host": "a.test", "port": 8443})
        assert "7" not in ids(client)
        assert "1" in ids(client)


class TestByPath:
    def test_removes_a_subtree(self, client) -> None:
        response = client.post(
            "/api/flows/delete",
            json={"host": "a.test", "port": 443, "path_prefix": "/api/v1"},
        )
        assert response.json()["deleted"] == 2
        assert {"1", "2"}.isdisjoint(ids(client))

    def test_a_subtree_without_a_port_spans_both_sites(self, client) -> None:
        # a.test:443 and a.test:8443 are two sites in the map, so the UI
        # sends the port; without one the host is taken as a whole.
        response = client.post(
            "/api/flows/delete", json={"host": "a.test", "path_prefix": "/api/v1"}
        )
        assert response.json()["deleted"] == 3
        assert "7" not in ids(client)

    def test_keeps_a_sibling_branch(self, client) -> None:
        client.post(
            "/api/flows/delete", json={"host": "a.test", "path_prefix": "/api/v1"}
        )
        assert "3" in ids(client)

    def test_does_not_take_a_path_that_merely_starts_the_same(self, client) -> None:
        # "/api" is a folder, so it covers "/api/v1/users" but not
        # "/apidocs", which is a different page entirely.
        client.post("/api/flows/delete", json={"host": "a.test", "path_prefix": "/api"})
        assert "5" in ids(client)
        assert {"1", "2", "3"}.isdisjoint(ids(client))

    def test_takes_the_folder_itself(self, client) -> None:
        add(client, id="8", path="/api")
        client.post("/api/flows/delete", json={"host": "a.test", "path_prefix": "/api"})
        assert "8" not in ids(client)

    def test_a_path_is_scoped_to_its_host(self, client) -> None:
        client.post(
            "/api/flows/delete", json={"host": "a.test", "path_prefix": "/api/v1"}
        )
        assert "6" in ids(client)

    def test_a_wildcard_in_a_captured_path_is_literal(self, client) -> None:
        # LIKE reads _ and % as wildcards. A path containing one must not
        # start matching its neighbours.
        add(client, id="9", path="/a_b/x")
        add(client, id="10", path="/axb/y")
        client.post("/api/flows/delete", json={"host": "a.test", "path_prefix": "/a_b"})
        assert "9" not in ids(client)
        assert "10" in ids(client)


class TestRefusals:
    def test_an_empty_body_is_refused(self, client) -> None:
        # Otherwise an empty filter reads as "match everything", and a UI
        # bug would silently wipe the capture.
        assert client.post("/api/flows/delete", json={}).status_code == 400

    def test_and_nothing_is_deleted(self, client) -> None:
        before = ids(client)
        client.post("/api/flows/delete", json={})
        assert ids(client) == before

    def test_the_store_refuses_an_empty_prefix_too(self, tmp_path) -> None:
        # The guard belongs in the store as well: it is reachable from
        # plugins and the MCP server, not only from this endpoint.
        store = FlowStore(tmp_path / "s.sqlite")
        store.upsert(
            FlowRecord(id="x", method="GET", host="a.test", started_at=time.time())
        )
        assert store.delete_by_prefix() == 0
        assert store.get("x") is not None


class TestDiskSpace:
    def test_the_file_shrinks(self, tmp_path) -> None:
        """The point of deleting. sqlite keeps freed pages for reuse, so
        without a vacuum the file stays exactly as large and nothing is
        actually saved."""
        db = tmp_path / "big.sqlite"
        store = FlowStore(db)
        blob = b"x" * 200_000
        for i in range(40):
            store.upsert(
                FlowRecord(
                    id=str(i),
                    method="GET",
                    host="a.test",
                    path=f"/f{i}.png",
                    started_at=time.time(),
                    response_body=blob,
                )
            )
        before = db.stat().st_size
        assert before > 4_000_000

        store.delete([str(i) for i in range(40)])
        store.reclaim_space()
        after = db.stat().st_size
        assert after < before / 4
