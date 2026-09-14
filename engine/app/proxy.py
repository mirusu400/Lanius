"""Embedded mitmproxy engine (DumpMaster) lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import socket
import subprocess
import sys

from mitmproxy import options
from mitmproxy.tools.dump import DumpMaster
from mitmproxy_rs.local import LocalRedirector

from .addons.capture import CaptureAddon
from .addons.intercept import InterceptAddon
from .addons.repeater import RepeaterAddon
from .addons.intruder import IntruderAddon
from .addons.plugins import PluginManager
from .addons.scope import ScopeManager
from .config import Settings
from .db.store import FlowStore
from .events import EventBroker

logger = logging.getLogger(__name__)

BIND_TIMEOUT_SECONDS = 5.0


# macOS ships the local-capture redirector as a system extension. It only
# takes effect once the user approves it, and until then mitmproxy reports
# the mode as running with no error, so the state has to be read from the
# OS instead. Reading it needs no privileges and takes milliseconds.
MACOS_REDIRECTOR_EXTENSION = "org.mitmproxy.macos-redirector"


def local_capture_state() -> dict[str, object]:
    """Whether OS-level local capture is ready on this machine.

    Returns ``supported`` (does this platform have it at all),
    ``approved`` (may it actually run) and a ``detail`` string. On
    platforms where approval is not a concept, ``approved`` mirrors
    ``supported``.
    """
    if sys.platform != "darwin":
        # Windows elevates a helper per run and Linux uses sudo, so there
        # is no persistent approval state to read.
        return {"supported": True, "approved": True, "detail": None}

    try:
        proc = subprocess.run(
            ["systemextensionsctl", "list"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"supported": True, "approved": False, "detail": str(exc)}

    for line in proc.stdout.splitlines():
        if MACOS_REDIRECTOR_EXTENSION not in line:
            continue
        state = ""
        if (match := re.search(r"\[(.+?)\]", line)) is not None:
            state = match.group(1).strip()
        # "activated enabled" is the working state; anything else, most
        # commonly "activated waiting for user", is not yet usable.
        return {
            "supported": True,
            "approved": state == "activated enabled",
            "detail": state or None,
        }

    return {
        "supported": True,
        "approved": False,
        "detail": "not installed",
    }


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
        self.scope = ScopeManager(store, broker)
        self.capture = CaptureAddon(store, broker, self.scope)
        self.intercept = InterceptAddon(broker)
        self.repeater = RepeaterAddon(store)
        self.intruder = IntruderAddon(self.repeater, broker)
        self.plugins = PluginManager(
            settings.plugins_dir,
            store,
            broker,
            on_chain_changed=self._reorder_capture_last,
        )
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def _modes(self, extra: list[str] | None = None) -> list[str]:
        """The mode list: the HTTP proxy, plus anything configured.

        ``extra`` overrides the saved local-capture setting, so a caller
        switching it off is not handed the old value back.
        """
        modes = [f"regular@{self.settings.proxy_port}"]
        modes.extend(self.settings.extra_modes)
        if extra is None:
            if (spec := self.local_capture_spec()) is not None:
                modes.append(f"local:{spec}" if spec else "local")
        else:
            modes.extend(extra)
        return modes

    def _build_master(self) -> DumpMaster:
        opts = options.Options(
            listen_host=self.settings.proxy_host,
            confdir=str(self.settings.confdir),
            # The port goes on the mode rather than in listen_port. A global
            # listen_port is inherited by every mode, including local capture,
            # which binds nothing: mitmproxy then sees two servers on one
            # address and refuses any later change to the mode list. Naming
            # the port here keeps modes switchable at runtime.
            mode=self._modes(),
            tcp_hosts=list(self.settings.tcp_hosts),
        )
        master = DumpMaster(opts, with_termlog=False, with_dumper=False)
        # mitmproxy's errorcheck addon calls sys.exit() on startup errors, which
        # would tear down the host application. We surface errors ourselves.
        if (errorcheck := master.addons.get("errorcheck")) is not None:
            master.addons.remove(errorcheck)
        # Intercept runs first so it can pause before capture records the flow.
        master.addons.add(self.intercept)
        master.addons.add(self.capture)
        master.addons.add(self.repeater)
        self.plugins.addons = master.addons
        self.plugins.load_enabled()
        self._reorder_capture_last()
        return master

    def _reorder_capture_last(self) -> None:
        """Keep the capture addon at the end of the chain.

        mitmproxy runs hooks in chain order, so capture must come after user
        plugins; otherwise a plugin's edits are applied after we have already
        persisted the flow and never show up in the history.
        """
        if self.master is None:
            return
        chain = self.master.addons.chain
        if self.capture in chain and chain[-1] is not self.capture:
            chain.remove(self.capture)
            chain.append(self.capture)

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
        self._report_mode_failures()

    CAPTURE_SETTING = "local_capture_spec"

    def local_capture_spec(self) -> str | None:
        """The saved local-capture target.

        ``None`` means off. An empty string means on with no filter, i.e.
        every application, which is distinct from off.
        """
        return self.store.get_setting(self.CAPTURE_SETTING)

    async def set_local_capture(self, spec: str | None) -> dict[str, object]:
        """Turn OS-level capture on or off without a restart.

        ``spec`` is a mitmproxy intercept spec: ``""`` or ``None`` for off,
        ``"curl"`` for one process, ``"!Slack"`` to exclude one, and so on.
        Returns the resulting readiness state.
        """
        if spec is not None:
            spec = spec.strip()
            if spec:
                # Reject a bad spec here rather than letting it take the
                # proxy down when mitmproxy reconfigures.
                LocalRedirector.describe_spec(spec)

        if spec is None:
            self.store.delete_setting(self.CAPTURE_SETTING)
        else:
            self.store.set_setting(self.CAPTURE_SETTING, spec)

        wanted = [] if spec is None else [f"local:{spec}" if spec else "local"]
        if self.master is not None:
            # "local" with no spec captures everything; "local:x" filters.
            self.master.options.update(mode=self._modes(wanted))

        state = local_capture_state()
        applied = await self._local_mode_applied(wanted)
        logger.info(
            "local capture set to %r (approved=%s, applied=%s)",
            spec,
            state["approved"],
            applied,
        )
        result = {"spec": spec, "restart_required": not applied, **state}
        self.broker.publish("engine.local_capture_changed", result)
        return result

    async def _local_mode_applied(
        self, wanted: list[str], timeout: float = 3.0
    ) -> bool:
        """Did mitmproxy actually adopt the new local mode?

        The OS redirector is a process-wide singleton that mitmproxy will
        not respawn, so switching between specs (or switching off) does not
        always take effect on a running engine. That is not an error, but
        the caller has to be told a restart is needed.
        """
        deadline = asyncio.get_running_loop().time() + timeout
        expected = set(wanted)
        while asyncio.get_running_loop().time() < deadline:
            current = {
                str(m["spec"])
                for m in self.mode_status()
                if str(m["spec"]).startswith("local")
            }
            if current == expected:
                return True
            await asyncio.sleep(0.2)
        return False

    def mode_status(self) -> list[dict[str, object]]:
        """Per-mode state, so a mode that did not come up is visible.

        mitmproxy keeps running when one of several modes fails, and we
        remove its ``errorcheck`` addon (it calls ``sys.exit``), so without
        this a failed mode is indistinguishable from a working one.
        """
        if self.master is None:
            return []
        server = self.master.addons.get("proxyserver")
        if server is None:
            return []
        out: list[dict[str, object]] = []
        for spec, instance in server.servers._instances.items():
            error = getattr(instance, "last_exception", None)
            # Listening modes bind an address; local capture does not, so an
            # empty tuple only means failure for the former.
            addrs = tuple(getattr(instance, "listen_addrs", ()) or ())
            out.append(
                {
                    "spec": getattr(spec, "full_spec", str(spec)),
                    "running": bool(instance.is_running),
                    "listening": bool(addrs),
                    "error": str(error) if error else None,
                }
            )
        return out

    def _report_mode_failures(self) -> None:
        for mode in self.mode_status():
            if mode["running"]:
                continue
            logger.error("mode %s did not start: %s", mode["spec"], mode["error"])
            self.broker.publish("engine.mode_failed", mode)
        self._warn_if_local_capture_blocked()

    def _warn_if_local_capture_blocked(self) -> None:
        """Local capture reports itself as running while it waits for the
        user to approve the OS extension, so warn explicitly."""
        if not any(
            str(mode["spec"]).startswith("local") for mode in self.mode_status()
        ):
            return
        state = local_capture_state()
        if state["approved"]:
            return
        logger.warning(
            "local capture is not active yet (%s); traffic will not be "
            "intercepted until the system extension is approved",
            state["detail"],
        )
        self.broker.publish("engine.local_capture_blocked", state)

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
