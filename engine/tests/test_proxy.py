from __future__ import annotations

import asyncio
import socket

import pytest

from app.config import Settings
from app.db.store import FlowStore
from app.events import EventBroker
from app.proxy import ProxyEngine, ProxyStartError


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def engine(tmp_path, port: int) -> ProxyEngine:
    settings = Settings(
        proxy_port=port,
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "p.sqlite",
        confdir=tmp_path / "mitm",
    )
    return ProxyEngine(settings, FlowStore(settings.db_path), EventBroker())


@pytest.mark.asyncio
async def test_start_binds_and_accepts_connections(tmp_path) -> None:
    port = free_port()
    eng = engine(tmp_path, port)
    await eng.start()
    assert eng.running
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.close()
    await eng.stop()
    assert not eng.running
    eng.store.close()


@pytest.mark.asyncio
async def test_start_raises_when_port_is_taken(tmp_path) -> None:
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    eng = engine(tmp_path, port)
    try:
        # mitmproxy refuses to bind; start() must fail fast, not silently.
        with pytest.raises(ProxyStartError):
            await eng.start()
    finally:
        blocker.close()
        eng.store.close()
