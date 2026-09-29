"""Local GOST bridge for ordered HTTP, HTTPS and SOCKS5 proxy hops."""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlsplit


def gost_executable() -> Path | None:
    name = "gost.exe" if sys.platform == "win32" else "gost"
    locations = [
        Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / name,
        Path(__file__).resolve().parents[1] / "vendor" / "gost" / name,
    ]
    for path in locations:
        if path.is_file():
            return path
    installed = shutil.which(name)
    return Path(installed) if installed else None


def _free_local_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class UpstreamBridge:
    """Own a loopback HTTP proxy whose GOST forwarding chain is ordered."""

    def __init__(self, hops: list[str]) -> None:
        self.hops = hops
        self.port: int | None = None
        self.process: asyncio.subprocess.Process | None = None

    @property
    def url(self) -> str:
        if self.port is None:
            raise RuntimeError("upstream bridge is not running")
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> None:
        executable = gost_executable()
        if executable is None:
            raise RuntimeError("GOST is missing; reinstall Lanius or run scripts/fetch_gost.py")
        self.port = _free_local_port()
        args = [str(executable), "-L", self.url]
        for hop in self.hops:
            # GOST does not verify HTTPS proxy certificates by default.
            # Make verification explicit for every TLS hop.
            args.extend(["-F", f"{hop}?secure=true" if urlsplit(hop).scheme == "https" else hop])
        try:
            self.process = await asyncio.create_subprocess_exec(
                *args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 5.0
            while loop.time() < deadline:
                if self.process.returncode is not None:
                    raise RuntimeError(f"GOST exited with code {self.process.returncode}")
                try:
                    _reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
                except OSError:
                    await asyncio.sleep(0.05)
                else:
                    writer.close()
                    with contextlib.suppress(OSError):
                        await writer.wait_closed()
                    return
            raise RuntimeError("GOST did not start listening within 5 seconds")
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        process = self.process
        self.process = None
        self.port = None
        if process is None or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()
