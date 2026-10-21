"""A failed result writer must not leave a producer blocked on its queue."""

import asyncio
from types import SimpleNamespace

import pytest

from app.addons.fuzzer import FuzzerAddon, RunSpeed
from app.db.store import FlowStore


@pytest.mark.parametrize("concurrency", [1, 4])
async def test_result_storage_failure_finishes_a_run_with_a_full_queue(tmp_path, monkeypatch, concurrency):
    class Replay:
        auto_decompress = True

        async def send(self, flow, *, http_mode=None):
            return SimpleNamespace(
                id=flow.id, status_code=200, response_size=0,
                duration_ms=1, error=None,
            )

    store = FlowStore(tmp_path / "fuzzer.sqlite")
    addon = FuzzerAddon(Replay(), store=store)

    def fail_write(*_args):
        raise OSError("result storage is full")

    monkeypatch.setattr(store, "save_fuzzer_result", fail_write)
    run = await addon.start(
        url="http://example.test",
        template="GET /{{payload}} HTTP/1.1\nHost: example.test\n\n",
        payload_sets=[[str(index) for index in range(64)]],
        speed=RunSpeed(concurrency=concurrency),
    )
    task = addon._tasks[run.id]
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=2)
        assert run.status == "failed"
        assert "result storage is full" in run.error
        assert store.list_fuzzer_runs()[0]["status"] == "failed"
        assert run.id not in addon._tasks
    finally:
        await addon.stop_all()
        store.close()
