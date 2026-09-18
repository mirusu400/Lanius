"""Filtering the history.

The history could be narrowed by one host, one method and one status
code, which is not how anyone actually looks for something: a capture is
mostly images and scripts, and the interesting requests are a handful of
POSTs somewhere in it.
"""

from __future__ import annotations

import socket
import time

import pytest
from fastapi.testclient import TestClient

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
    add(client, id="1", path="/logo.png", status_code=200)
    add(client, id="2", path="/app.js", status_code=200)
    add(client, id="3", path="/style.css", status_code=304)
    add(client, id="4", path="/login", method="POST", status_code=302)
    add(client, id="5", path="/admin", status_code=403)
    add(client, id="6", path="/api/users", method="POST", status_code=201)
    add(client, id="7", path="/missing", status_code=404)
    add(client, id="8", path="/broken", status_code=500)
    add(client, id="9", host="b.test", path="/other.png", status_code=200)
    # No response yet, which is not any status class.
    add(client, id="10", path="/pending", status_code=None)


def ids(response) -> set[str]:
    return {i["id"] for i in response.json()["items"]}


class TestExtensions:
    def test_keeps_only_one_extension(self, client) -> None:
        assert ids(client.get("/api/flows?extensions=png")) == {"1", "9"}

    def test_accepts_several(self, client) -> None:
        # Checkboxes, not a single choice.
        assert ids(client.get("/api/flows?extensions=png&extensions=js")) == {
            "1",
            "2",
            "9",
        }

    def test_ignores_a_leading_dot(self, client) -> None:
        # ".png" is what someone types; it should mean the same thing.
        assert ids(client.get("/api/flows?extensions=.png")) == {"1", "9"}

    def test_is_case_insensitive(self, client) -> None:
        add(client, id="11", path="/PHOTO.PNG")
        assert "11" in ids(client.get("/api/flows?extensions=png"))

    def test_does_not_match_a_query_string(self, client) -> None:
        """The query lives in its own column, so ?x=.png is not a png."""
        add(client, id="12", path="/page", query="download=file.png")
        assert "12" not in ids(client.get("/api/flows?extensions=png"))


class TestExcludingExtensions:
    def test_drops_the_named_extension(self, client) -> None:
        # The usual reason to filter at all: a capture is mostly images.
        assert ids(client.get("/api/flows?exclude_extensions=png")) & {"1", "9"} == set()

    def test_drops_several(self, client) -> None:
        got = ids(client.get("/api/flows?exclude_extensions=png&exclude_extensions=js"))
        assert got & {"1", "2", "9"} == set()
        assert "4" in got

    def test_keeps_a_flow_with_no_path(self, client) -> None:
        """A missing path is not a png, so it should survive the filter
        rather than being swept out by a NULL comparison."""
        add(client, id="13", path=None)
        assert "13" in ids(client.get("/api/flows?exclude_extensions=png"))


class TestMethods:
    def test_keeps_one_method(self, client) -> None:
        assert ids(client.get("/api/flows?methods=POST")) == {"4", "6"}

    def test_accepts_several(self, client) -> None:
        got = ids(client.get("/api/flows?methods=POST&methods=GET"))
        assert {"4", "6", "1"} <= got

    def test_is_case_insensitive(self, client) -> None:
        assert ids(client.get("/api/flows?methods=post")) == {"4", "6"}


class TestStatusClasses:
    def test_keeps_one_class(self, client) -> None:
        # 2xx is the useful unit, not 200 against 201.
        assert ids(client.get("/api/flows?status_classes=2")) == {"1", "2", "6", "9"}

    def test_accepts_several(self, client) -> None:
        assert ids(client.get("/api/flows?status_classes=4&status_classes=5")) == {
            "5",
            "7",
            "8",
        }

    def test_excludes_a_flow_with_no_response(self, client) -> None:
        """A request still in flight belongs to no class, and should not
        fall into whichever one happens to be selected."""
        for cls in (2, 3, 4, 5):
            assert "10" not in ids(client.get(f"/api/flows?status_classes={cls}"))


class TestCombining:
    def test_filters_narrow_together(self, client) -> None:
        assert ids(client.get("/api/flows?methods=POST&status_classes=2")) == {"6"}

    def test_host_and_extension(self, client) -> None:
        assert ids(client.get("/api/flows?host=b.test&extensions=png")) == {"9"}

    def test_include_and_exclude_can_both_apply(self, client) -> None:
        got = ids(
            client.get("/api/flows?methods=GET&exclude_extensions=png&exclude_extensions=js")
        )
        assert got & {"1", "2", "9"} == set()
        assert {"3", "5", "7"} <= got

    def test_nothing_matching_is_an_empty_list(self, client) -> None:
        assert client.get("/api/flows?extensions=exe").json()["items"] == []


def include(client, host: str) -> None:
    """Add a scope rule, and insist it was actually added.

    Checked rather than assumed: a request to the wrong path answers 405
    and leaves the scope empty, which makes a scope filter look like it
    passes everything.
    """
    response = client.post("/api/scope/rules", json={"kind": "include", "host": host})
    assert response.status_code == 200, response.text


class TestScope:
    def test_keeps_only_flows_in_scope(self, client) -> None:
        include(client, "b.test")
        assert ids(client.get("/api/flows?in_scope_only=true")) == {"9"}

    def test_everything_shows_without_the_filter(self, client) -> None:
        include(client, "b.test")
        assert len(ids(client.get("/api/flows"))) > 1

    def test_respects_the_limit(self, client) -> None:
        """Scope is decided in Python, so the paging has to be applied
        after filtering rather than by the database."""
        include(client, "a.test")
        assert len(client.get("/api/flows?in_scope_only=true&limit=3").json()["items"]) == 3

    def test_combines_with_the_other_filters(self, client) -> None:
        include(client, "a.test")
        assert ids(client.get("/api/flows?in_scope_only=true&methods=POST")) == {"4", "6"}
