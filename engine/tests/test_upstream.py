"""The local GOST bridge is always a background process."""

from __future__ import annotations

import subprocess
from unittest.mock import AsyncMock, Mock

import pytest

from app import upstream


@pytest.mark.asyncio
async def test_windows_gost_does_not_open_a_console(monkeypatch, tmp_path) -> None:
    executable = tmp_path / "gost.exe"
    process = Mock(returncode=None)
    spawn = AsyncMock(return_value=process)
    writer = Mock()
    writer.wait_closed = AsyncMock()

    monkeypatch.setattr(upstream, "gost_executable", lambda: executable)
    monkeypatch.setattr(upstream, "_free_local_port", lambda: 43123)
    monkeypatch.setattr(upstream.sys, "platform", "win32")
    monkeypatch.setattr(
        upstream.subprocess,
        "CREATE_NO_WINDOW",
        0x0800_0000,
        raising=False,
    )
    monkeypatch.setattr(upstream.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(
        upstream.asyncio,
        "open_connection",
        AsyncMock(return_value=(Mock(), writer)),
    )

    bridge = upstream.UpstreamBridge(["http://proxy.example:8080"])
    await bridge.start()

    spawn.assert_awaited_once_with(
        str(executable),
        "-L",
        "http://127.0.0.1:43123",
        "-F",
        "http://proxy.example:8080",
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=0x0800_0000,
    )
    writer.close.assert_called_once_with()
    writer.wait_closed.assert_awaited_once_with()
