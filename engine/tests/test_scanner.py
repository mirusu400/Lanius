"""Scanner contribution, scheduling, issue, and API tests."""

from __future__ import annotations

import asyncio
import json
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from mitmproxy.test import tflow, tutils

from app.addons.capture import flow_to_record
from app.addons.scanner import ScannerAddon, ScannerError, _added_request, insertion_points
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowRecord, FlowStore
from app.events import EventBroker
from app.plugin_registry import ContributionRegistry
from lanius_sdk import ScanIssue


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def captured_record(flow_id: str = "flow-1") -> FlowRecord:
    return FlowRecord(
        id=flow_id,
        scheme="https",
        method="POST",
        host="example.test",
        port=443,
        path="/users/7",
        query="page=1",
        http_version="HTTP/1.1",
        request_headers=[
            ("content-type", "application/x-www-form-urlencoded"),
            ("content-length", "6"),
        ],
        request_body=b"name=a",
        status_code=200,
        response_headers=[("content-type", "text/plain")],
        response_body=b"ok",
        response_size=2,
        source="proxy",
    )


class FakeReplay:
    auto_decompress = True

    def __init__(self) -> None:
        self.sent = []

    async def send(self, flow):
        self.sent.append(flow)
        flow.response = tutils.tresp(status_code=201, content=b"active response")
        return flow_to_record(flow)


@pytest.mark.asyncio
async def test_passive_checks_deduplicate_issues(tmp_path) -> None:
    store = FlowStore(tmp_path / "project.sqlite")
    broker = EventBroker()
    queue = broker.subscribe()
    registry = ContributionRegistry(store)
    registry.context("checks").scanner.register_passive(
        "headers",
        "Header check",
        lambda snapshot: ScanIssue(
            "Missing header",
            "medium",
            "The response is missing a required header.",
            parameter="x-frame-options",
            evidence={"status": snapshot["status_code"]},
        ),
    )
    scanner = ScannerAddon(registry, store, broker, FakeReplay())
    snapshot = {
        "flow_id": "flow-1",
        "url": "https://example.test/",
        "host": "example.test",
        "path": "/",
        "status_code": 200,
    }

    first = await scanner.scan_passive(snapshot)
    second = await scanner.scan_passive(snapshot)

    assert first[0]["id"] == second[0]["id"]
    assert second[0]["occurrences"] == 2
    assert store.issue_summary()["by_severity"]["medium"] == 1
    assert queue.get_nowait()["type"] == "issues.changed"
    assert queue.get_nowait()["type"] == "issues.changed"
    store.close()


@pytest.mark.asyncio
async def test_repeated_scanner_errors_suspend_the_check(tmp_path) -> None:
    store = FlowStore(tmp_path / "project.sqlite")
    registry = ContributionRegistry(store)
    calls = 0

    def broken(_snapshot):
        nonlocal calls
        calls += 1
        raise RuntimeError("broken check")

    registry.context("checks").scanner.register_passive(
        "broken", "Broken check", broken
    )
    scanner = ScannerAddon(registry, store, EventBroker(), FakeReplay())
    for _ in range(7):
        await scanner.scan_passive({"flow_id": "flow-1"})

    health = registry.diagnostics("checks")["contributions"][0]
    assert calls == 5
    assert health["errors"] == 5
    assert health["suspended"] is True
    registry.reset_diagnostics("checks")
    assert len(registry.scan_handlers("passive_scanners")) == 1
    registry.dispose_owner("checks")
    store.close()


def test_issue_status_and_filters(tmp_path) -> None:
    store = FlowStore(tmp_path / "project.sqlite")
    now = 1.0
    issue = {
        "id": "issue-1",
        "fingerprint": "f" * 64,
        "plugin_id": "checks",
        "check_id": "one",
        "scan_mode": "passive",
        "title": "Finding",
        "severity": "high",
        "confidence": "firm",
        "status": "open",
        "detail": "detail text",
        "remediation": None,
        "url": "https://example.test/a",
        "host": "example.test",
        "path": "/a",
        "parameter": None,
        "flow_id": "flow-1",
        "evidence": {"header": "value"},
        "first_seen": now,
        "last_seen": now,
        "occurrences": 1,
    }
    store.upsert_issue(issue)

    assert store.list_issues(severity="high", search="detail")[0]["evidence"] == {
        "header": "value"
    }
    assert store.set_issue_status("issue-1", "resolved")["status"] == "resolved"
    assert store.list_issues(status="open") == []
    assert store.delete_issue("issue-1") is True
    store.close()


def test_issues_round_trip_with_project_data(tmp_path) -> None:
    source = FlowStore(tmp_path / "source.sqlite")
    now = 1.0
    source.upsert_issue({
        "id": "issue-1", "fingerprint": "a" * 64, "plugin_id": "checks",
        "check_id": "one", "scan_mode": "passive", "title": "Finding",
        "severity": "low", "confidence": "firm", "status": "false_positive",
        "detail": "detail", "remediation": None, "url": None, "host": None,
        "path": None, "parameter": None, "flow_id": None,
        "evidence": {"value": 1}, "first_seen": now, "last_seen": now,
        "occurrences": 2,
    })
    exported = source.all_issues()
    source.close()

    destination = FlowStore(tmp_path / "destination.sqlite")
    counts = destination.import_project({"issues": exported})

    assert counts["issues"] == 1
    assert destination.get_issue("issue-1")["status"] == "false_positive"
    assert destination.get_issue("issue-1")["evidence"] == {"value": 1}
    destination.close()


def test_builds_insertion_points_for_request_parts() -> None:
    points = insertion_points(captured_record())
    assert {(point.kind, point.name) for point in points} == {
        ("query", "page"),
        ("header", "content-type"),
        ("path", "1"),
        ("path", "2"),
        ("form", "name"),
    }


def test_added_request_keeps_target_and_rejects_unsafe_headers() -> None:
    record = captured_record()
    query = _added_request(record, "query", "debug", "probe")
    assert query["url"] == "https://example.test/users/7?page=1&debug=probe"
    assert query["body"] == "name=a"
    cookie = _added_request(record, "cookie", "mode", "test")
    assert ["Cookie", "mode=test"] in cookie["headers"]
    form = _added_request(record, "form", "preview", "1")
    assert form["body"] == "name=a&preview=1"
    record.query = "signature=%2f&space=a+b"
    assert _added_request(record, "query", "__debug", "1")["url"].endswith(
        "?signature=%2f&space=a+b&__debug=1"
    )
    record.request_headers = [("Content-Type", "application/json")]
    record.request_body = b'{ "existing": 1 }'
    json_request = _added_request(record, "json", "preview", "yes")
    assert json_request["body"].startswith('{ "existing": 1 ')
    assert json.loads(json_request["body"]) == {"existing": 1, "preview": "yes"}
    with pytest.raises(ScannerError, match="cannot be added"):
        _added_request(record, "header", "Host", "other.test")
    with pytest.raises(ScannerError, match="invalid added input value"):
        _added_request(record, "header", "X-Debug", "yes\r\nHost: other.test")


@pytest.mark.asyncio
async def test_request_level_check_can_probe_new_inputs(tmp_path) -> None:
    store = FlowStore(tmp_path / "project.sqlite")
    record = captured_record()
    record.query = ""
    record.request_headers = []
    record.request_body = b""
    record.path = "/"
    store.upsert(record)
    registry = ContributionRegistry(store)

    async def check(scan):
        assert scan.insertion_point.kind == "request"
        await scan.send_with()
        await scan.send_with("query", "debug", "probe")
        return None

    registry.context("checks").scanner.register_active(
        "new-input", "New input", check, request_level=True,
    )
    replay = FakeReplay()
    scanner = ScannerAddon(registry, store, EventBroker(), replay)
    registry.active_scan_start = scanner.start_active
    job = await scanner.start_active("flow-1")
    await scanner._job_tasks[job.id]

    assert job.status == "completed"
    assert job.total == 1
    assert job.requests == 2
    assert replay.sent[0].request.pretty_url == "https://example.test/"
    assert replay.sent[1].request.pretty_url == "https://example.test/?debug=probe"
    store.close()


@pytest.mark.asyncio
async def test_active_scan_sends_bounded_mutations_and_reports_issues(tmp_path) -> None:
    store = FlowStore(tmp_path / "project.sqlite")
    store.upsert(captured_record())
    registry = ContributionRegistry(store)

    async def active(context):
        response = await context.send("probe")
        assert response["status_code"] == 201
        return ScanIssue(
            "Active finding",
            "high",
            "Probe changed the response.",
            parameter=context.insertion_point.name,
        )

    registry.context("checks").scanner.register_active(
        "probe", "Probe", active
    )
    replay = FakeReplay()
    scanner = ScannerAddon(registry, store, EventBroker(), replay)

    job = await scanner.start_active(
        "flow-1", concurrency=2, requests_per_second=50
    )
    await scanner._job_tasks[job.id]

    assert job.status == "completed"
    assert job.requests == job.total == 5
    assert job.completed == 5
    assert job.issues == 5
    assert len(replay.sent) == 5
    assert len(store.list_issues()) == 5
    store.close()


def test_scanner_issue_api(tmp_path: Path) -> None:
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "api.sqlite",
        confdir=tmp_path / "mitm",
        plugins_dir=tmp_path / "plugins",
    )
    with TestClient(create_app(settings)) as client:
        engine = client.app.state.engine
        engine.plugins.registry.context("checks").scanner.register_passive(
            "api",
            "API check",
            lambda _snapshot: ScanIssue("API issue", "low", "Found through API"),
        )
        client.app.state.store.upsert(captured_record())

        scanned = client.post("/api/scanner/passive/flow-1")
        assert scanned.status_code == 200
        issue_id = scanned.json()["items"][0]["id"]
        listed = client.get("/api/issues?status=open").json()
        assert listed["summary"]["by_severity"]["low"] == 1

        resolved = client.patch(
            f"/api/issues/{issue_id}", json={"status": "resolved"}
        )
        assert resolved.json()["status"] == "resolved"
        assert client.delete(f"/api/issues/{issue_id}").json()["deleted"] is True
