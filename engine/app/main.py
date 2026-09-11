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

PARENT_POLL_SECONDS = 2.0
SHUTDOWN_GRACE_SECONDS = 3.0


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
                # Ask uvicorn to stop, then hard-exit if it does not: the
                # frozen bootloader would otherwise sit in wait4() forever.
                os.kill(os.getpid(), signal.SIGTERM)
                time.sleep(SHUTDOWN_GRACE_SECONDS)
                logger.warning("graceful shutdown timed out; exiting")
                os._exit(0)

    thread = threading.Thread(target=_watch, name="parent-watchdog", daemon=True)
    thread.start()


def _pid_alive(pid: int) -> bool:
    if pid <= 1:
        return True  # no meaningful supervisor to watch
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but owned by someone else
    return True


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
        supervisor = int(os.environ.get("LANIUS_SUPERVISOR_PID", os.getppid()))
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
