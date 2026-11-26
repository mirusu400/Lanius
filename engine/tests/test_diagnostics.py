from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from app import diagnostics
from app.diagnostics import Diagnostics, redact
from app.lockdown import PROJECT_SETTING

from .test_api import client  # noqa: F401 - fixture


def test_redact_removes_targets_and_credentials() -> None:
    text = redact(
        "GET https://target.example.com/a?x=1 failed\n"
        "Cookie: sid=1; theme=dark\n"
        "headers=[('cookie', 'sid=1'), ('Authorization', 'Bearer abc.def')]\n"
        "api_token=deadbeef&q=1 Authorization: Bearer abcdefghij\n"
        "peer 10.1.2.3 mail someone@corp.example\n"
        f"File \"{Path.home()}/project/x.py\", line 3\n"
    )
    for secret in ("target.example.com", "sid=1", "abc.def", "deadbeef",
                   "abcdefghij", "10.1.2.3", "someone@corp.example", str(Path.home())):
        assert secret not in text
    assert 'File "~/project/x.py", line 3' in text


def test_redact_keeps_the_app_itself_readable() -> None:
    text = redact("engine at http://127.0.0.1:12954/api/status, python 3.12.1")
    assert "http://127.0.0.1:12954/api/status" in text
    assert "3.12.1" in text


def test_reports_are_written_newest_first_and_pruned(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(diagnostics, "MAX_REPORTS", 3)
    log = Diagnostics(tmp_path)
    for index in range(5):
        log.record("engine", "ValueError", f"error {index}")
    reports = log.reports()
    assert [r["message"] for r in reports] == ["error 4", "error 3", "error 2"]
    assert len(list((tmp_path / "reports").glob("*.json"))) == 3


def test_a_repeated_error_is_recorded_once(tmp_path) -> None:
    log = Diagnostics(tmp_path)
    assert log.record("ui", "TypeError", "x is undefined", "at render") is not None
    assert log.record("ui", "TypeError", "x is undefined", "at render") is None
    assert len(log.reports()) == 1


def test_reports_read_back_redacted(tmp_path) -> None:
    log = Diagnostics(tmp_path)
    log.record("engine", "ConnectError", "could not reach https://secret.example/x")
    stored = next((tmp_path / "reports").glob("*.json")).read_text()
    # The local file keeps the detail; what leaves the module does not.
    assert "secret.example" in stored
    assert "secret.example" not in json.dumps(log.reports())


def test_shell_reports_in_the_same_directory_are_listed(tmp_path) -> None:
    (tmp_path / "reports").mkdir()
    (tmp_path / "reports" / "01795564800000000000-shell-abc.json").write_text(json.dumps({
        "id": "abc", "source": "shell", "time": "2026-11-26T00:00:00+00:00",
        "kind": "panic", "message": "boom", "traceback": "", "context": {},
    }))
    assert Diagnostics(tmp_path).reports()[0]["source"] == "shell"


def test_api_records_ui_errors_and_builds_a_bundle(client) -> None:  # noqa: F811
    response = client.post("/api/diagnostics/reports", json={
        "kind": "TypeError",
        "message": "cannot read 'host' of https://victim.example/login",
        "stack": "at HistoryTab (index.js:1:2)",
        "component_stack": "\n    in HistoryTab",
        "where": "render",
    })
    assert response.json() == {"recorded": True}

    items = client.get("/api/diagnostics").json()["items"]
    assert items[0]["source"] == "ui"
    assert "victim.example" not in items[0]["message"]
    assert "Component stack" in items[0]["traceback"]

    bundle = client.get("/api/diagnostics/bundle", params={"shell": "0.7.0"})
    assert bundle.status_code == 200
    assert bundle.headers["content-type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(bundle.content))
    names = set(archive.namelist())
    assert {"README.txt", "state.json", "reports.json", "logs/recent.log"} <= names
    state = json.loads(archive.read("state.json"))
    assert state["shell_version"] == "0.7.0"
    assert "lockdown" in state and "doctor" in state
    assert b"victim.example" not in b"".join(archive.read(n) for n in names)

    assert client.delete("/api/diagnostics/reports").json()["removed"] == 1
    assert client.get("/api/diagnostics").json()["count"] == 0


def test_bundle_refuses_an_odd_shell_version(client) -> None:  # noqa: F811
    assert client.get("/api/diagnostics/bundle", params={"shell": "1.0\n<x>"}).status_code == 422


def test_issue_url_carries_the_build_and_latest_error(client) -> None:  # noqa: F811
    client.post("/api/diagnostics/reports", json={"kind": "Error", "message": "boom"})
    url = client.post("/api/diagnostics/issue").json()["url"]
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == diagnostics.ISSUE_URL
    query = parse_qs(parts.query)
    assert query["title"] == ["[ui] Error: boom"]
    assert "Lanius" in query["body"][0]


def test_issue_url_is_refused_in_lockdown(client) -> None:  # noqa: F811
    client.put("/api/lockdown/project", json={"enabled": True})
    assert client.app.state.lockdown.store.get_setting(PROJECT_SETTING) == "1"
    response = client.post("/api/diagnostics/issue")
    assert response.status_code == 423
    assert response.json()["detail"] == "LOCKDOWN_MODE_BLOCKED"
    # Saving a bundle stays local and keeps working.
    assert client.get("/api/diagnostics/bundle").status_code == 200


def test_unhandled_api_errors_are_recorded(client) -> None:  # noqa: F811
    from unittest import mock

    from fastapi.testclient import TestClient

    engine = client.app.state.engine
    with mock.patch.object(engine, "listener_state", side_effect=RuntimeError("kaboom")):
        failing = TestClient(client.app, raise_server_exceptions=False)
        failing.headers.update(client.headers)
        assert failing.get("/api/status").status_code == 500
    report = client.get("/api/diagnostics").json()["items"][0]
    assert report["kind"] == "RuntimeError"
    assert report["context"]["where"] == "GET /api/status"
    assert "kaboom" in report["traceback"]
