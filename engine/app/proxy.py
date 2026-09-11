"""Embedded mitmproxy engine (DumpMaster) lifecycle."""

from __future__ import annotations

import asyncio
import logging

from mitmproxy import options
from mitmproxy.tools.dump import DumpMaster

from .addons.capture import CaptureAddon
from .config import Settings
from .db.store import FlowStore
from .events import EventBroker

logger = logging.getLogger(__name__)


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
        master.addons.add(self.capture)
        return master

    async def start(self) -> None:
        if self.running:
            return
        self.master = self._build_master()
        self._task = asyncio.create_task(self.master.run(), name="lanius-proxy")
        await asyncio.sleep(0)  # let the server bind
        self.broker.publish(
            "engine.started",
            {"host": self.settings.proxy_host, "port": self.settings.proxy_port},
        )
        logger.info(
            "proxy listening on %s:%s",
            self.settings.proxy_host,
            self.settings.proxy_port,
        )

    async def stop(self) -> None:
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
