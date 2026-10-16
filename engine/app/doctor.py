"""Preflight checks that run before any project is opened.

``lanius-engine --doctor`` prints one JSON report and exits. The desktop
shell runs it from the project picker, so a machine where the proxy cannot
start can be diagnosed without opening a project first. Everything here is
local: no check sends a request anywhere.

Only light modules are imported at the top. Importing mitmproxy is itself a
check, and a broken install must produce a report rather than a crash.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import os
import platform
import socket
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Literal

from . import __version__
from .config import Settings

Status = Literal["ok", "warn", "error"]

# Starting a throwaway proxy generates a CA and binds a socket; a healthy
# machine needs well under a second, so this only bounds a hang.
START_TIMEOUT_SECONDS = 15.0
CA_FILE = "mitmproxy-ca.pem"


def _check(check_id: str, status: Status, detail: str, **extra: Any) -> dict[str, Any]:
    return {"id": check_id, "status": status, "detail": detail, **extra}


def _error_text(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def probe_listen(host: str, port: int) -> None:
    """Raise OSError if another listener holds ``host:port``.

    A restarted listener reuses its port. On POSIX, SO_REUSEADDR permits that
    while old connections are in TIME_WAIT; listen() still refuses a second
    live listener. Windows needs its exclusive-address option instead.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    probe = socket.socket(family)
    try:
        if sys.platform == "win32":  # pragma: no cover - platform specific
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((host, port))
        probe.listen(1)
    finally:
        probe.close()


def check_runtime() -> dict[str, Any]:
    python = platform.python_version()
    try:
        from mitmproxy import version as mitmproxy_version
        import mitmproxy_rs  # noqa: F401  # native core; the usual frozen-build failure
    except Exception as exc:
        return _check("runtime", "error", _error_text(exc), python=python)
    return _check(
        "runtime",
        "ok",
        f"Python {python}, mitmproxy {mitmproxy_version.VERSION}",
        python=python,
        mitmproxy=mitmproxy_version.VERSION,
    )


def check_data_dir(path: Path) -> dict[str, Any]:
    try:
        path.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path, prefix=".doctor-"):
            pass
    except OSError as exc:
        return _check("data_dir", "error", _error_text(exc), path=str(path))
    return _check("data_dir", "ok", str(path), path=str(path))


def check_ca(confdir: Path) -> dict[str, Any]:
    """Read the existing CA without creating one; startup creates it if missing."""
    path = confdir / CA_FILE
    if not path.exists():
        if confdir.exists() and not os.access(confdir, os.W_OK):
            return _check("ca", "error", f"{confdir} is not writable", path=str(path))
        return _check("ca", "warn", "not created yet", path=str(path))
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        pem = path.read_bytes()
        cert = x509.load_pem_x509_certificate(pem)
        load_pem_private_key(pem, password=None)
    except Exception as exc:
        return _check("ca", "error", f"{path}: {_error_text(exc)}", path=str(path))
    expires = cert.not_valid_after_utc
    if expires <= datetime.datetime.now(datetime.timezone.utc):
        return _check("ca", "error", f"{path}: expired {expires.date()}", path=str(path))
    return _check("ca", "ok", f"valid until {expires.date()}", path=str(path))


def port_holder(port: int) -> str | None:
    """Name the process listening on ``port``, when the OS lets us see it.

    macOS refuses the system-wide table to normal users, so ask each process;
    the ones we may not inspect belong to other users and are skipped.
    """
    try:
        import psutil
    except ImportError:  # pragma: no cover - bundled dependency
        return None
    for process in psutil.process_iter(["name"]):
        try:
            for conn in process.net_connections("inet"):
                if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port:
                    return f"{process.info['name']} (pid {process.pid})"
        except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
    return None


def check_port(check_id: str, host: str, port: int) -> dict[str, Any]:
    address = f"{host}:{port}"
    try:
        probe_listen(host, port)
    except OSError as exc:
        holder = port_holder(port)
        detail = f"{_error_text(exc)} ({holder})" if holder else _error_text(exc)
        return _check(check_id, "error", detail, address=address, holder=holder)
    return _check(check_id, "ok", address, address=address)


async def _start_proxy(confdir: Path) -> float:
    """Start a real mitmproxy listener on a free port, then shut it down."""
    from mitmproxy import options
    from mitmproxy.tools.dump import DumpMaster

    with socket.socket() as spare:
        spare.bind(("127.0.0.1", 0))
        port = int(spare.getsockname()[1])
    started = time.monotonic()
    opts = options.Options(
        listen_host="127.0.0.1", confdir=str(confdir), mode=[f"regular@{port}"]
    )
    master = DumpMaster(opts, with_termlog=False, with_dumper=False)
    # errorcheck calls sys.exit() on startup errors; we report them instead.
    if (errorcheck := master.addons.get("errorcheck")) is not None:
        master.addons.remove(errorcheck)
    task = asyncio.create_task(master.run())
    try:
        while True:
            if task.done():
                raise RuntimeError(f"proxy stopped during startup: {task.exception()}")
            with contextlib.suppress(OSError):
                _reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                return time.monotonic() - started
            await asyncio.sleep(0.05)
    finally:
        master.shutdown()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(task, 5)


def check_proxy_start() -> dict[str, Any]:
    # A scratch confdir: the check must not create or touch the user's CA.
    with tempfile.TemporaryDirectory(prefix="lanius-doctor-") as confdir:
        try:
            elapsed = asyncio.run(
                asyncio.wait_for(_start_proxy(Path(confdir)), START_TIMEOUT_SECONDS)
            )
        except TimeoutError:
            return _check(
                "proxy_start", "error", f"no listener after {START_TIMEOUT_SECONDS:.0f}s"
            )
        except Exception as exc:
            return _check(
                "proxy_start",
                "error",
                _error_text(exc),
                trace=traceback.format_exc(limit=8),
            )
    return _check("proxy_start", "ok", f"{elapsed * 1000:.0f} ms")


def run(settings: Settings) -> dict[str, Any]:
    checks = [check_runtime(), check_data_dir(settings.data_dir), check_ca(settings.confdir)]
    checks.append(check_port("proxy_port", settings.proxy_host, settings.proxy_port))
    checks.append(check_port("api_port", settings.api_host, settings.api_port))
    if checks[0]["status"] != "error":
        checks.append(check_proxy_start())
    return {
        "engine_version": __version__,
        "platform": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "checks": checks,
    }
