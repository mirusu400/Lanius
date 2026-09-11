"""Embedded mitmproxy engine (DumpMaster) lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket

from mitmproxy import options
from mitmproxy.tools.dump import DumpMaster

from .addons.capture import CaptureAddon
from .addons.intercept import InterceptAddon
from .config import Settings
from .db.store import FlowStore
from .events import EventBroker

logger = logging.getLogger(__name__)

BIND_TIMEOUT_SECONDS = 5.0


class ProxyStartError(RuntimeError):
    """The proxy could not bind its listen address."""


class ProxyEngine:
    """Runs mitmproxy inside the app's asyncio loop."""

    def __init__(
        self, settings: Settings, store: FlowStore, broker: EventBroker
    ) -> None:
        self.settings = settings
        self.store = store
        self.broker = broker
        self.master: DumpMaster | None = None
        self.capture = CaptureAddon(store, broker)
        self.intercept = InterceptAddon(broker)
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def _build_master(self) -> DumpMaster:
        opts = options.Options(
            listen_host=self.settings.proxy_host,
            listen_port=self.settings.proxy_port,
            confdir=str(self.settings.confdir),
        )
        master = DumpMaster(opts, with_termlog=False, with_dumper=False)
        # mitmproxy's errorcheck addon calls sys.exit() on startup errors, which
        # would tear down the host application. We surface errors ourselves.
        if (errorcheck := master.addons.get("errorcheck")) is not None:
            master.addons.remove(errorcheck)
        # Intercept runs first so it can pause before capture records the flow.
        master.addons.add(self.intercept)
        master.addons.add(self.capture)
        return master

    async def start(self) -> None:
        if self.running:
            return
        self._check_port_available()
        self.master = self._build_master()
        self._task = asyncio.create_task(self.master.run(), name="lanius-proxy")
        await self._await_bind()
        self.broker.publish(
            "engine.started",
            {"host": self.settings.proxy_host, "port": self.settings.proxy_port},
        )
        logger.info(
            "proxy listening on %s:%s",
            self.settings.proxy_host,
            self.settings.proxy_port,
        )

    def _check_port_available(self) -> None:
        """Fail fast with a clear message when the listen port is taken."""
        probe = socket.socket()
        try:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((self.settings.proxy_host, self.settings.proxy_port))
        except OSError as exc:
            raise ProxyStartError(
                f"proxy port {self.settings.proxy_host}:"
                f"{self.settings.proxy_port} is unavailable: {exc}"
            ) from exc
        finally:
            probe.close()

    async def _await_bind(self) -> None:
        """Block until mitmproxy actually accepts connections, or fail loudly.

        ``DumpMaster.run()`` binds asynchronously, so without this a bind
        failure (e.g. port already in use) would surface only as a late crash.
        """
        deadline = asyncio.get_running_loop().time() + BIND_TIMEOUT_SECONDS
        while asyncio.get_running_loop().time() < deadline:
            if self._task is not None and self._task.done():
                exc = self._task.exception()
                self._task = None
                self.master = None
                raise ProxyStartError(
                    f"proxy failed to bind {self.settings.proxy_host}:"
                    f"{self.settings.proxy_port}: {exc or 'startup aborted'}"
                )
            if await self._can_connect():
                return
            await asyncio.sleep(0.05)
        raise ProxyStartError(
            f"proxy did not start listening on {self.settings.proxy_host}:"
            f"{self.settings.proxy_port} within {BIND_TIMEOUT_SECONDS}s"
        )

    async def _can_connect(self) -> bool:
        try:
            _reader, writer = await asyncio.open_connection(
                self.settings.proxy_host, self.settings.proxy_port
            )
        except OSError:
            return False
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
        return True

    async def stop(self) -> None:
        self.intercept.resume_all()
        if self.master is not None:
            self.master.shutdown()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            except Exception:  # pragma: no cover - defensive
                logger.exception("proxy shutdown error")
        await self.capture.done()
        self._task = None
        self.master = None
        self.broker.publish("engine.stopped", {})
