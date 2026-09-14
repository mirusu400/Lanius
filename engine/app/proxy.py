"""Embedded mitmproxy engine (DumpMaster) lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import ipaddress
import socket
import subprocess
import sys
from typing import Any

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
from .tls import (
    DEFAULT_PROFILE,
    PROFILES as TLS_PROFILES,
    options_for,
    patch_version_probe,
    validate_ciphers,
)

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


# Bind addresses with a meaning worth naming in the UI.
LOOPBACK = "127.0.0.1"
ALL_INTERFACES = "0.0.0.0"  # noqa: S104 - deliberate, and warned about in the UI


def _is_loopback(host: str) -> bool:
    """Is this address reachable only from this machine?"""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in {"localhost", ""}


def _bindable_addresses() -> list[dict[str, str]]:
    """Addresses this machine can bind, for the UI to offer.

    Includes the two that always make sense, then whatever the interfaces
    report, so a user can pick the LAN address a phone would point at
    rather than exposing every interface.
    """
    found: list[dict[str, str]] = [
        {"host": LOOPBACK, "label": "This machine only"},
        {"host": ALL_INTERFACES, "label": "All interfaces"},
    ]
    seen = {entry["host"] for entry in found}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            host = str(info[4][0])
            if host not in seen and not _is_loopback(host):
                found.append({"host": host, "label": host})
                seen.add(host)
    except OSError:  # pragma: no cover - depends on the host's DNS
        logger.debug("could not enumerate local addresses")
    return found


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
        # Why the proxy is not listening, when it failed to start. The API
        # stays up so the user can fix the listener from the app itself.
        self.start_error: str | None = None
        # A saved listener overrides the defaults and the environment, since
        # it is the one a user chose deliberately.
        self._apply_saved_listener()

    LISTEN_HOST_SETTING = "listen_host"
    LISTEN_PORT_SETTING = "listen_port"

    def _apply_saved_listener(self) -> None:
        host = self.store.get_setting(self.LISTEN_HOST_SETTING)
        if host:
            self.settings.proxy_host = host
        port = self.store.get_setting(self.LISTEN_PORT_SETTING)
        if port:
            try:
                self.settings.proxy_port = int(port)
            except ValueError:
                logger.warning("ignoring saved listener port %r", port)

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
        # Applying a TLS option makes mitmproxy probe which versions this
        # OpenSSL supports, which raises rather than returning False here.
        patch_version_probe()
        # The TLS options only exist once the addons are loaded, so they
        # cannot go into Options() above.
        profile = self.store.get_setting(self.TLS_PROFILE_SETTING) or DEFAULT_PROFILE
        custom = self.store.get_setting(self.TLS_CIPHERS_SETTING) or None
        master.options.update(**options_for(profile, custom))
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
        try:
            self._check_port_available()
        except ProxyStartError as exc:
            self.start_error = str(exc)
            raise
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
        self.start_error = None
        self._report_mode_failures()

    def listener_state(self) -> dict[str, Any]:
        """Where the proxy listens, and whether it managed to."""
        return {
            "host": self.settings.proxy_host,
            "port": self.settings.proxy_port,
            "running": self.running,
            "error": self.start_error,
            # Anything other than a loopback address is reachable from the
            # network, which is what makes a phone or a VM able to use it.
            "exposed": not _is_loopback(self.settings.proxy_host),
            "addresses": _bindable_addresses(),
        }

    async def set_listener(self, host: str, port: int) -> dict[str, Any]:
        """Move the proxy to a new address, keeping the old one on failure.

        The engine is stopped first, because a port cannot be tested while
        the current listener still holds it. If the new address turns out to
        be unusable, the previous one is restored and restarted, so a typo
        cannot leave the user without a proxy.
        """
        host = host.strip()
        if not host:
            raise ProxyStartError("bind address must not be empty")
        if not 1 <= port <= 65535:
            raise ProxyStartError(f"port {port} is out of range (1-65535)")

        previous = (self.settings.proxy_host, self.settings.proxy_port)
        if (host, port) == previous and self.running:
            return self.listener_state()

        was_running = self.running
        if was_running:
            await self.stop()

        self.settings.proxy_host = host
        self.settings.proxy_port = port
        try:
            await self.start()
        except ProxyStartError:
            self.settings.proxy_host, self.settings.proxy_port = previous
            if was_running:
                with contextlib.suppress(ProxyStartError):
                    await self.start()
            raise

        self.store.set_setting(self.LISTEN_HOST_SETTING, host)
        self.store.set_setting(self.LISTEN_PORT_SETTING, str(port))
        self.broker.publish("engine.listener_changed", self.listener_state())
        return self.listener_state()

    CAPTURE_SETTING = "local_capture_spec"
    TLS_PROFILE_SETTING = "tls_profile"
    TLS_CIPHERS_SETTING = "tls_ciphers"

    def tls_state(self) -> dict[str, Any]:
        """The upstream TLS profile in use, and what is available."""
        profile = self.store.get_setting(self.TLS_PROFILE_SETTING) or DEFAULT_PROFILE
        custom = self.store.get_setting(self.TLS_CIPHERS_SETTING) or None
        applied = options_for(profile, custom)
        return {
            "profile": profile,
            "custom_ciphers": custom,
            "ciphers": applied["ciphers_server"],
            "available": [
                {"id": key, "label": value["label"]}
                for key, value in TLS_PROFILES.items()
            ],
        }

    async def set_tls_profile(
        self, profile: str, custom_ciphers: str | None = None
    ) -> dict[str, Any]:
        """Change the TLS profile used for connections to the server.

        mitmproxy terminates TLS, so without this every request carries
        mitmproxy's own handshake and is trivially fingerprinted.
        """
        if profile not in TLS_PROFILES:
            raise ValueError(f"unknown TLS profile: {profile!r}")
        custom = (custom_ciphers or "").strip() or None
        if custom is not None:
            validate_ciphers(custom)

        self.store.set_setting(self.TLS_PROFILE_SETTING, profile)
        if custom is None:
            self.store.delete_setting(self.TLS_CIPHERS_SETTING)
        else:
            self.store.set_setting(self.TLS_CIPHERS_SETTING, custom)

        if self.master is not None:
            self.master.options.update(**options_for(profile, custom))

        state = self.tls_state()
        logger.info("upstream TLS profile set to %s", profile)
        self.broker.publish("engine.tls_changed", state)
        return state

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
            await self._stop_listeners()
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

    async def _stop_listeners(self) -> None:
        """Close the listening sockets before shutting the master down.

        ``Master.shutdown()`` only asks the run loop to exit; it does not
        close the servers, and mitmproxy's proxyserver addon has no ``done``
        hook, so the port stays bound after the task has finished. That
        leaks a listener on every restart and makes moving to a new port
        look like it worked while the old one is still accepting.
        """
        if self.master is None:
            return
        proxyserver = self.master.addons.get("proxyserver")
        if proxyserver is None:  # pragma: no cover - always present upstream
            return
        for server in list(getattr(proxyserver, "servers", []) or []):
            try:
                await server.stop()
            except Exception:  # pragma: no cover - already going away
                logger.debug("listener did not stop cleanly", exc_info=True)
