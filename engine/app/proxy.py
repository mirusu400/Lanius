"""Embedded mitmproxy engine (DumpMaster) lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import ipaddress
import socket
import subprocess
import sys
import time
from typing import Any
from urllib.parse import urlsplit

from mitmproxy import options
from mitmproxy.proxy.mode_specs import ProxyMode
from mitmproxy.tools.dump import DumpMaster
from mitmproxy_rs.local import LocalRedirector

from .addons.capture import CaptureAddon
from .addons.intercept import InterceptAddon
from .addons.match_replace import MatchReplaceAddon
from .addons.repeater import RepeaterAddon
from .addons.websocket_proxy import WebSocketProxyAddon
from .addons.intruder import IntruderAddon
from .addons.plugins import PluginManager
from .addons.scanner import ScannerAddon
from .plugin_packages import PluginPackageManager
from .plugin_catalogue import PluginCatalogueManager
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
from .upstream import UpstreamBridge

logger = logging.getLogger(__name__)

BIND_TIMEOUT_SECONDS = 5.0


# macOS ships the local-capture redirector as a system extension. It only
# takes effect once the user approves it, and until then mitmproxy reports
# the mode as running with no error, so the state has to be read from the
# OS instead. Reading it needs no privileges and takes milliseconds.
MACOS_REDIRECTOR_EXTENSION = "org.mitmproxy.macos-redirector"


# Approval changes only when the user acts on a system dialog, so asking
# the OS more than once every few seconds is wasted work. It is read on
# every status poll and by several tests, which on a slow machine adds up
# to minutes of subprocess spawning for an answer that did not change.
_STATE_TTL_SECONDS = 5.0
_state_cache: tuple[float, dict[str, object]] | None = None


def reset_local_capture_cache() -> None:
    """Forget the cached answer.

    For tests, which change what the OS would report between cases, and
    after anything that could plausibly have changed the approval.
    """
    global _state_cache
    _state_cache = None


def local_capture_state(*, refresh: bool = False) -> dict[str, object]:
    """Whether OS-level local capture is ready on this machine.

    Returns ``supported`` (does this platform have it at all),
    ``approved`` (may it actually run) and a ``detail`` string. On
    platforms where approval is not a concept, ``approved`` mirrors
    ``supported``.

    Cached briefly; pass ``refresh`` when the user has just been asked to
    approve something and the answer is expected to have changed.
    """
    global _state_cache
    if not refresh and _state_cache is not None:
        cached_at, cached = _state_cache
        if time.monotonic() - cached_at < _STATE_TTL_SECONDS:
            return cached
    state = _read_local_capture_state()
    _state_cache = (time.monotonic(), state)
    return state


def _read_local_capture_state() -> dict[str, object]:
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


def normalize_upstream_url(value: str) -> str:
    """Accept an explicit HTTP, HTTPS or SOCKS5 proxy URL."""
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid upstream proxy address") from exc
    if (
        parsed.scheme not in {"http", "https", "socks5"}
        or not parsed.hostname
        or any(character.isspace() for character in parsed.hostname)
        or "," in parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("use an HTTP, HTTPS or SOCKS5 proxy URL without credentials or a path")
    if port is None:
        port = {"http": 80, "https": 443, "socks5": 1080}[parsed.scheme]
    if not 1 <= port <= 65535:
        raise ValueError("upstream proxy port must be between 1 and 65535")
    host = parsed.hostname
    authority = f"[{host}]" if ":" in host else host
    normalized = f"{parsed.scheme}://{authority}:{port}"
    if parsed.scheme != "socks5":
        try:
            ProxyMode.parse(f"upstream:{normalized}@8080")
        except ValueError as exc:
            raise ValueError("invalid upstream proxy address") from exc
    return normalized


def _upstream_loops_back(url: str, listen_host: str, listen_port: int) -> bool:
    parsed = urlsplit(url)
    if parsed.port != listen_port:
        return False
    host = parsed.hostname or ""
    if host == listen_host:
        return True
    if _is_loopback(host):
        return listen_host in {ALL_INTERFACES, "::", ""} or _is_loopback(listen_host)
    if listen_host in {ALL_INTERFACES, "::", ""}:
        return host in {entry["host"] for entry in _bindable_addresses()}
    return False


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
        self.match_replace = MatchReplaceAddon(store, broker)
        self.intercept = InterceptAddon(
            broker,
            store=store,
            # A request edited while held does not fire the request hook a
            # second time. Persist it immediately so History can show the
            # final "Modified request" even before a response arrives.
            on_forwarded=self.capture.request_updated,
        )
        self.websockets = WebSocketProxyAddon(broker, store=store)
        self.repeater = RepeaterAddon(store)
        self.intruder = IntruderAddon(self.repeater, broker)
        self.plugin_packages = PluginPackageManager(
            settings.plugins_dir,
            trusted_keys_path=settings.plugin_trusted_keys,
            revocations_path=settings.plugin_revocations,
            development_mode=settings.plugin_dev_mode,
        )
        self.plugin_catalogue = PluginCatalogueManager(
            settings.plugin_catalogue_sources,
            settings.plugin_catalogue_cache,
            settings.plugin_revocations,
            self.plugin_packages,
        )
        self.plugins = PluginManager(
            settings.plugins_dir,
            store,
            broker,
            on_chain_changed=self._reorder_capture_last,
            user_values_path=settings.data_dir / "plugin-values.json",
            packages=self.plugin_packages,
            safe_mode=settings.disable_plugins,
        )
        self.scanner = ScannerAddon(
            self.plugins.registry,
            store,
            broker,
            self.repeater,
            self.scope,
        )
        self._task: asyncio.Task[None] | None = None
        # Why the proxy is not listening, when it failed to start. The API
        # stays up so the user can fix the listener from the app itself.
        self.start_error: str | None = None
        # A saved listener overrides the defaults and the environment, since
        # it is the one a user chose deliberately.
        self._apply_saved_listener()
        self.upstream_hops: list[str] = []
        self._upstream_bridge: UpstreamBridge | None = None
        self._apply_saved_upstream()

    LISTEN_HOST_SETTING = "listen_host"
    LISTEN_PORT_SETTING = "listen_port"
    UPSTREAM_SETTING = "upstream_proxy_url"
    UPSTREAM_HOPS_SETTING = "upstream_proxy_hops"

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

    def _apply_saved_upstream(self) -> None:
        saved = self.store.get_setting(self.UPSTREAM_HOPS_SETTING)
        if saved is None:
            legacy = self.store.get_setting(self.UPSTREAM_SETTING)
            saved = json.dumps([legacy]) if legacy else None
        if saved:
            try:
                hops = json.loads(saved)
                if not isinstance(hops, list) or not all(isinstance(hop, str) for hop in hops):
                    raise ValueError("invalid saved upstream chain")
                hops = [normalize_upstream_url(hop) for hop in hops]
                if any(_upstream_loops_back(hop, self.settings.proxy_host, self.settings.proxy_port) for hop in hops):
                    raise ValueError("upstream proxy points back to the listener")
                self.upstream_hops = hops
            except (ValueError, TypeError) as exc:
                logger.warning("ignoring saved upstream proxy: %s", exc)

    def _needs_upstream_bridge(self) -> bool:
        return len(self.upstream_hops) > 1 or (
            bool(self.upstream_hops) and self.upstream_hops[0].startswith("socks5://")
        )

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def _modes(self, extra: list[str] | None = None) -> list[str]:
        """The mode list: the HTTP proxy, plus anything configured.

        ``extra`` overrides the saved local-capture setting, so a caller
        switching it off is not handed the old value back.
        """
        upstream = self._upstream_bridge.url if self._upstream_bridge else (
            self.upstream_hops[0] if self.upstream_hops else None
        )
        listener = f"upstream:{upstream}@{self.settings.proxy_port}" if upstream else f"regular@{self.settings.proxy_port}"
        modes = [listener]
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
        # Automatic replacements must be visible in Intercept, and capture
        # stays last so it persists the final form of each message.
        master.addons.add(self.match_replace)
        master.addons.add(self.intercept)
        master.addons.add(self.websockets)
        master.addons.add(self.scanner)
        master.addons.add(self.capture)
        master.addons.add(self.repeater)
        # Not via the running hook: it does not fire for every mode set.
        self.repeater.attach(master.options)
        self.websockets.attach(master)
        self.plugins.addons = master.addons
        self.plugins.load_enabled()
        self._reorder_capture_last(master)
        return master

    def _reorder_capture_last(self, master: DumpMaster | None = None) -> None:
        """Persist final HTTP and WebSocket content after user plugins.

        mitmproxy runs hooks in chain order. A plugin may edit a frame or
        request, so both persistence hooks must run after it.
        """
        master = master or self.master
        if master is None:
            return
        chain = master.addons.chain
        for addon in (self.websockets, self.scanner, self.capture):
            if addon in chain:
                chain.remove(addon)
                chain.append(addon)

    async def start(self) -> None:
        if self.running:
            return
        try:
            self._check_port_available()
        except ProxyStartError as exc:
            self.start_error = str(exc)
            raise
        try:
            if self._needs_upstream_bridge():
                bridge = UpstreamBridge(self.upstream_hops)
                try:
                    await bridge.start()
                except (OSError, RuntimeError) as exc:
                    raise ProxyStartError(f"upstream chain could not start: {exc}") from exc
                self._upstream_bridge = bridge
            self.master = self._build_master()
            self._task = asyncio.create_task(self.master.run(), name="lanius-proxy")
            await self._await_bind()
            await self.plugins.start_runtime()
        except Exception as exc:
            self.start_error = str(exc)
            await self.stop()
            raise
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

    def upstream_state(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.upstream_hops),
            "hops": list(self.upstream_hops),
            "url": self.upstream_hops[0] if len(self.upstream_hops) == 1 else None,
        }

    async def set_upstream(self, hops: list[str] | str | None) -> dict[str, Any]:
        """Apply an ordered proxy chain to the regular listener."""
        if isinstance(hops, str):
            hops = [hops]
        wanted = [normalize_upstream_url(hop) for hop in hops] if hops is not None else []
        if len(wanted) > 16:
            raise ValueError("an upstream chain can contain at most 16 hops")
        if any(_upstream_loops_back(hop, self.settings.proxy_host, self.settings.proxy_port) for hop in wanted):
            raise ValueError("upstream proxy points back to the listener")
        if wanted == self.upstream_hops:
            return self.upstream_state()

        previous = self.upstream_hops
        was_running = self.running
        if was_running:
            await self.stop()
        self.upstream_hops = wanted
        try:
            if was_running:
                await self.start()
        except Exception:
            self.upstream_hops = previous
            if was_running:
                with contextlib.suppress(Exception):
                    await self.start()
            raise

        self.store.delete_setting(self.UPSTREAM_SETTING)
        if not wanted:
            self.store.delete_setting(self.UPSTREAM_HOPS_SETTING)
        else:
            self.store.set_setting(self.UPSTREAM_HOPS_SETTING, json.dumps(wanted))
        state = self.upstream_state()
        self.broker.publish("engine.upstream_changed", state)
        return state

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
        if any(_upstream_loops_back(hop, host, port) for hop in self.upstream_hops):
            raise ProxyStartError("upstream proxy points back to the listener")

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

        # The user may have just approved the extension in response to
        # switching this on, so do not answer from a stale cache.
        state = local_capture_state(refresh=True)
        # Nothing to wait for when the proxy is not running: the modes can
        # never appear, so the poll would burn its whole timeout and report
        # a restart is needed, which is true but already obvious.
        applied = (
            await self._local_mode_applied(wanted)
            if self.master is not None
            else True
        )
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
        """Fail fast with a clear message when the listen port is taken.

        A route change restarts the listener on the same port. On POSIX,
        SO_REUSEADDR permits that while old connections are in TIME_WAIT;
        listen() still refuses a second live listener. Windows needs its
        exclusive-address option instead of SO_REUSEADDR.
        """
        probe = socket.socket()
        try:
            if sys.platform == "win32":  # pragma: no cover - platform specific
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((self.settings.proxy_host, self.settings.proxy_port))
            probe.listen(1)
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
            if await self._can_connect() and self._addons_ready():
                return
            await asyncio.sleep(0.05)
        raise ProxyStartError(
            f"proxy did not start listening on {self.settings.proxy_host}:"
            f"{self.settings.proxy_port} within {BIND_TIMEOUT_SECONDS}s"
        )

    def _addons_ready(self) -> bool:
        """Has mitmproxy run the addons' ``running`` hook yet?

        Accepting a connection is not the same as being ready: the hook
        that hands Repeater its options runs separately, and with an extra
        mode configured it can land after the port is already open. Callers
        that returned at that moment got a Repeater which reported the
        engine as not running, permanently, until the next restart.
        """
        return self.repeater.options is not None

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
        self.websockets.resume_all()
        await self.plugins.stop_runtime()
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
        await self.scanner.done()
        self.plugins.master_stopped()
        self._task = None
        self.master = None
        if self._upstream_bridge is not None:
            await self._upstream_bridge.stop()
            self._upstream_bridge = None
        self.websockets.master = None
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
