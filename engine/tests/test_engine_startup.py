"""Exercise the CLI's real event loop, which TestClient does not use."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


def test_cli_starts_proxy_with_default_event_loop(tmp_path: Path) -> None:
    def free_port() -> int:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    api_port, proxy_port = free_port(), free_port()
    log = tmp_path / "engine.log"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    environment = dict(
        os.environ,
        LANIUS_DATA_DIR=str(tmp_path),
        LANIUS_API_TOKEN="",
        LANIUS_WATCH_PARENT="0",
    )
    with log.open("wb") as output:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "app.main",
                "--api-port",
                str(api_port),
                "--proxy-port",
                str(proxy_port),
                "--db",
                str(tmp_path / "startup.sqlite"),
            ],
            cwd=Path(__file__).parents[1],
            env=environment,
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                try:
                    with opener.open(
                        f"http://127.0.0.1:{api_port}/api/status", timeout=1
                    ) as response:
                        status = json.load(response)
                    break
                except (urllib.error.URLError, TimeoutError):
                    assert process.poll() is None, log.read_text(encoding="utf-8")
                    time.sleep(0.1)
            else:
                raise AssertionError(log.read_text(encoding="utf-8"))

            assert status["proxy"]["running"], status["proxy"]["error"]
            with socket.create_connection(("127.0.0.1", proxy_port), timeout=2):
                pass
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
