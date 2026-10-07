"""Project cleanup must reclaim disk space without mixing or erasing other work."""

from __future__ import annotations

import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowRecord
from app.db import store as store_module


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "project.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as api:
        yield api


def seed(client: TestClient, flow_id: str, host: str, port: int = 443) -> None:
    client.app.state.store.upsert(
        FlowRecord(
            id=flow_id,
            scheme="https",
            host=host,
            port=port,
            path="/large",
            method="GET",
            started_at=time.time(),
            response_body=b"x" * (512 * 1024),
            response_size=512 * 1024,
        )
    )


def site(preview: dict, host: str, port: int = 443) -> dict:
    return next(
        row for row in preview["sites"] if row["host"] == host and row["port"] == port
    )


def test_preview_marks_scope_and_exact_sites(client: TestClient) -> None:
    seed(client, "a", "keep.test")
    seed(client, "b", "noise.test")
    seed(client, "c", "keep.test", 8443)
    client.post("/api/scope/rules", json={"kind": "include", "host": "keep.test"})

    preview = client.get("/api/project/compact").json()
    assert preview["total_flows"] == 3
    assert len(preview["sites"]) == 3
    assert site(preview, "keep.test")["in_scope"] is True
    assert site(preview, "noise.test")["in_scope"] is False
    assert site(preview, "noise.test")["content_bytes"] >= 512 * 1024


def test_selected_target_is_deleted_and_other_project_state_stays(client: TestClient) -> None:
    seed(client, "keep", "same.test")
    seed(client, "remove", "same.test", 8443)
    client.post("/api/scope/rules", json={"kind": "include", "host": "same.test"})
    client.put("/api/workspace/replay", json={"value": [{"name": "saved tab"}]})
    before = client.get("/api/project/compact").json()

    result = client.post(
        "/api/project/compact", json={"sites": [site(before, "same.test", 8443)]}
    ).json()

    assert result["deleted"] == 1
    assert result["reclaim_error"] is None
    assert result["after_bytes"] < result["before_bytes"]
    assert client.get("/api/flows/remove").status_code == 404
    assert client.get("/api/flows/keep").status_code == 200
    assert len(client.get("/api/scope").json()["rules"]) == 1
    assert client.get("/api/workspace/replay").json()["value"] == [
        {"name": "saved tab"}
    ]


def test_changed_preview_refuses_deletion(client: TestClient) -> None:
    seed(client, "first", "noise.test")
    preview = client.get("/api/project/compact").json()
    seed(client, "second", "noise.test")

    result = client.post(
        "/api/project/compact", json={"sites": [site(preview, "noise.test")]}
    )
    assert result.status_code == 409
    assert client.get("/api/status").json()["flows"] == 2


def test_compact_only_keeps_remaining_requests(client: TestClient) -> None:
    seed(client, "keep", "keep.test")
    seed(client, "old", "old.test")
    client.app.state.store.delete_by_prefix(host="old.test")
    before = client.get("/api/project/compact").json()
    result = client.post("/api/project/compact", json={"sites": []}).json()

    assert result["deleted"] == 0
    assert result["after_bytes"] <= result["before_bytes"]
    assert client.get("/api/flows/keep").status_code == 200
    assert before["total_flows"] == 1


def test_single_large_target_reports_each_delete_batch(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    for flow_id in ("first", "second", "third"):
        seed(client, flow_id, "noise.test")
    monkeypatch.setattr(store_module, "COMPACT_DELETE_BATCH_SIZE", 2)
    reported: list[tuple[int, int]] = []

    deleted = client.app.state.store.delete_sites(
        [("https", "noise.test", 443, 3)],
        lambda processed, total: reported.append((processed, total)),
    )

    assert deleted == 3
    assert reported == [(2, 3), (3, 3)]
    assert client.app.state.store.compact_overview()["total_flows"] == 0


def test_progress_is_visible_during_compaction_and_rejects_overlap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed(client, "remove", "noise.test")
    preview = client.get("/api/project/compact").json()
    operation_id = str(uuid4())
    entered = threading.Event()
    release = threading.Event()
    store = client.app.state.store
    original_reclaim = store.reclaim_space

    def slow_reclaim(on_phase):
        on_phase("vacuuming")
        entered.set()
        assert release.wait(timeout=10)
        original_reclaim(on_phase)

    monkeypatch.setattr(store, "reclaim_space", slow_reclaim)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                client.post,
                "/api/project/compact",
                json={"operation_id": operation_id, "sites": [site(preview, "noise.test")]},
            )
            assert entered.wait(timeout=10)
            progress = client.get(f"/api/project/compact/progress/{operation_id}")
            assert progress.status_code == 200
            assert progress.json()["phase"] == "vacuuming"
            assert progress.json()["processed_flows"] == 1
            assert progress.json()["total_flows"] == 1
            assert client.post("/api/project/compact", json={"sites": []}).status_code == 409
            release.set()
            assert future.result(timeout=10).status_code == 200
    finally:
        release.set()

    assert client.get(f"/api/project/compact/progress/{operation_id}").json()["phase"] == "done"
    assert client.get(f"/api/project/compact/progress/{uuid4()}").status_code == 404
