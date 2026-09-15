"""Lanius engine entrypoint: mitmproxy + REST/WS API in one asyncio loop.

Usage::

    python -m app.main [--proxy-port 8080] [--api-port 8081]
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
import time

import uvicorn

from .api import create_app
from .config import Settings

logger = logging.getLogger(__name__)

# How often the watchdog checks that the shell is still alive. Two seconds
# is unnoticeable in use, but the tests wait for a real poll, so they set
# this lower rather than sleeping through the production interval.
PARENT_POLL_SECONDS = float(os.environ.get("LANIUS_PARENT_POLL_SECONDS", "2.0"))
SHUTDOWN_GRACE_SECONDS = float(
    os.environ.get("LANIUS_SHUTDOWN_GRACE_SECONDS", "3.0")
)


def watch_parent(parent_pid: int) -> None:
    """Exit when the supervising process disappears.

    The desktop shell runs the engine as a sidecar. If the shell is killed
    hard (SIGKILL, crash), its cleanup never runs, and without this watchdog
    the proxy would keep holding its ports forever.

    The PID is explicit rather than ``os.getppid()`` because PyInstaller's
    bootloader stays alive as our direct parent, so the parent PID would
    never change even after the shell is gone.
    """

    def _watch() -> None:
        while True:
            time.sleep(PARENT_POLL_SECONDS)
            if not _pid_alive(parent_pid):
                logger.warning("supervisor %s exited; shutting down", parent_pid)
                _request_shutdown()
                time.sleep(SHUTDOWN_GRACE_SECONDS)
                logger.warning("graceful shutdown timed out; exiting")
                os._exit(0)

    thread = threading.Thread(target=_watch, name="parent-watchdog", daemon=True)
    thread.start()


def _supervisor_pid() -> int | None:
    """Which process are we meant to outlive, if any?

    ``LANIUS_SUPERVISOR_PID`` is what the desktop shell passes. Falling back
    to ``os.getppid()`` is racy: if the supervisor dies before we get here,
    the kernel has already reparented us and getppid() reports the reaper
    (pid 1 on macOS, or an arbitrary subreaper on Linux). Watching that pid
    would mean watching a process that never exits, so the watchdog would
    sleep forever and the engine would outlive the shell it was meant to
    follow. Treat a missing parent as "already orphaned" instead.
    """
    explicit = os.environ.get("LANIUS_SUPERVISOR_PID")
    if explicit:
        try:
            return int(explicit)
        except ValueError:
            logger.warning("ignoring malformed LANIUS_SUPERVISOR_PID %r", explicit)

    parent = os.getppid()
    if parent <= 1:
        return None  # reparented already: nothing meaningful left to watch
    return parent


def _request_shutdown() -> None:
    """Ask the server to stop, then let the caller hard-exit if it stalls.

    Windows has no SIGTERM delivery to self in the POSIX sense, so raise
    SIGINT there, which CPython maps onto the console Ctrl-C path that
    uvicorn already handles.
    """
    sig = signal.SIGINT if os.name == "nt" else signal.SIGTERM
    try:
        os.kill(os.getpid(), sig)
    except (OSError, ValueError):  # pragma: no cover - platform dependent
        logger.debug("could not signal self; falling back to exit")


def _pid_alive(pid: int) -> bool:
    """Is this process still running?

    ``os.kill(pid, 0)`` is the POSIX probe. On Windows it raises for a pid
    that exists but has already exited, so query the process table instead.
    """
    if pid <= 1:
        return True  # no meaningful supervisor to watch

    if os.name == "nt":
        return _pid_alive_windows(pid)

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but owned by someone else
    return True


def _pid_alive_windows(pid: int) -> bool:
    import ctypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259

    kernel32 = _kernel32()

    # A HANDLE is pointer-sized. ctypes defaults every return value to
    # c_int, which would truncate it on 64-bit Windows and leave us closing
    # a bogus handle, so the signatures are declared explicitly.
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.GetExitCodeProcess.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ulong),
    ]

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _kernel32():  # pragma: no cover - trivial, and Windows only
    """Indirection so the Win32 probe can be tested on any platform."""
    import ctypes

    return ctypes.windll.kernel32  # type: ignore[attr-defined]


def parse_args(argv: list[str] | None = None) -> tuple[Settings, bool]:
    parser = argparse.ArgumentParser(prog="lanius-engine")
    defaults = Settings.from_env()
    parser.add_argument("--proxy-host", default=defaults.proxy_host)
    parser.add_argument("--proxy-port", type=int, default=defaults.proxy_port)
    parser.add_argument("--api-host", default=defaults.api_host)
    parser.add_argument("--api-port", type=int, default=defaults.api_port)
    parser.add_argument("--db", dest="db_path", default=None)
    parser.add_argument("--log-level", default=defaults.log_level)
    parser.add_argument(
        "--watch-parent",
        action="store_true",
        help="exit when the launching process does (used by the desktop shell)",
    )
    args = parser.parse_args(argv)
    settings = Settings(
        proxy_host=args.proxy_host,
        proxy_port=args.proxy_port,
        api_host=args.api_host,
        api_port=args.api_port,
        db_path=args.db_path,
        log_level=args.log_level,
    )
    return settings, bool(args.watch_parent)


def main(argv: list[str] | None = None) -> None:
    settings, watch = parse_args(argv)
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    if watch or os.environ.get("LANIUS_WATCH_PARENT") == "1":
        supervisor = _supervisor_pid()
        if supervisor is None:
            logger.warning("no supervisor to watch; continuing unsupervised")
        else:
            watch_parent(supervisor)
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
