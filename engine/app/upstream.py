"""Local GOST bridge for ordered HTTP, HTTPS and SOCKS5 proxy hops."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


@dataclass(frozen=True, slots=True)
class UpstreamCredential:
    """Basic authentication for one upstream proxy hop."""

    username: str
    password: str


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

    def __init__(
        self,
        hops: list[str],
        credentials: list[UpstreamCredential | None] | None = None,
    ) -> None:
        self.hops = hops
        self.credentials = (
            credentials if credentials is not None else [None] * len(hops)
        )
        if len(self.credentials) != len(hops):
            raise ValueError("each upstream hop needs one authentication entry")
        self.port: int | None = None
        self.process: asyncio.subprocess.Process | None = None
        self._config_path: Path | None = None

    @property
    def url(self) -> str:
        if self.port is None:
            raise RuntimeError("upstream bridge is not running")
        return f"http://127.0.0.1:{self.port}"

    def _config(self) -> dict[str, object]:
        """Build a GOST config without putting credentials in process args."""
        hops: list[dict[str, object]] = []
        for index, (url, credential) in enumerate(
            zip(self.hops, self.credentials, strict=True)
        ):
            parsed = urlsplit(url)
            host = parsed.hostname
            port = parsed.port
            if host is None or port is None:  # normalized by ProxyEngine
                raise ValueError("invalid upstream proxy address")
            address = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
            connector: dict[str, object] = {
                "type": "socks5" if parsed.scheme == "socks5" else "http",
            }
            if credential is not None:
                connector["auth"] = {
                    "username": credential.username,
                    "password": credential.password,
                }
            dialer: dict[str, object] = {
                "type": "tls" if parsed.scheme == "https" else "tcp",
            }
            if parsed.scheme == "https":
                dialer["tls"] = {"secure": True, "serverName": host}
            node = {
                "name": f"node-{index}",
                "addr": address,
                "connector": connector,
                "dialer": dialer,
            }
            hops.append({"name": f"hop-{index}", "nodes": [node]})
        return {
            "services": [{
                "name": "lanius-upstream",
                "addr": f"127.0.0.1:{self.port}",
                "handler": {"type": "http", "chain": "lanius-chain"},
                "listener": {"type": "tcp"},
            }],
            "chains": [{"name": "lanius-chain", "hops": hops}],
        }

    def _write_config(self) -> Path:
        descriptor, raw_path = tempfile.mkstemp(
            prefix="lanius-upstream-", suffix=".json"
        )
        path = Path(raw_path)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
                json.dump(self._config(), config_file, ensure_ascii=False)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        self._config_path = path
        return path

    def _remove_config(self) -> None:
        if self._config_path is not None:
            self._config_path.unlink(missing_ok=True)
            self._config_path = None

    async def start(self) -> None:
        executable = gost_executable()
        if executable is None:
            raise RuntimeError("GOST is missing; reinstall Lanius or run scripts/fetch_gost.py")
        self.port = _free_local_port()
        if any(self.credentials):
            # A config file keeps passwords out of the process command line.
            args = [str(executable), "-C", str(self._write_config())]
        else:
            args = [str(executable), "-L", self.url]
            for hop in self.hops:
                # GOST does not verify HTTPS proxy certificates by default.
                # Make verification explicit for every TLS hop.
                args.extend(["-F", f"{hop}?secure=true" if urlsplit(hop).scheme == "https" else hop])
        try:
            if sys.platform == "win32":  # pragma: no cover - platform specific
                self.process = await asyncio.create_subprocess_exec(
                    *args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
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
                    self._remove_config()
                    return
            raise RuntimeError("GOST did not start listening within 5 seconds")
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        self._remove_config()
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
