"""Let user traffic leave only while the observed public IP is the pinned one.

The pin is project-owned and fail-closed: proxy, Replay and Fuzzer traffic is
allowed only while every pinned address family was confirmed recently by the
public IP observer, no unexpected family appeared, the local interfaces have
not changed since that confirmation and Lockdown Mode is off. The observer is
product traffic, so Lockdown stops it and therefore blocks pinned projects.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from typing import Callable

import psutil

from .db.store import FlowStore
from .lockdown import LockdownPolicy

logger = logging.getLogger(__name__)

ENABLED_SETTING = "egress_pin.enabled"
IPV4_SETTING = "egress_pin.ipv4"
IPV6_SETTING = "egress_pin.ipv6"

# While pinned the observer runs at this interval regardless of the history
# interval, and a confirmation is trusted for a little longer than one round.
POLL_SECONDS = 30
VALID_SECONDS = 45
WATCH_SECONDS = 2.0

Snapshot = frozenset[tuple[str, str]]


def local_interface_addresses() -> Snapshot:
    """Every non-loopback interface address; a VPN or Wi-Fi change alters it."""
    found: set[tuple[str, str]] = set()
    try:
        interfaces = psutil.net_if_addrs()
    except (OSError, RuntimeError):  # pragma: no cover - depends on the host OS
        logger.debug("could not enumerate local addresses", exc_info=True)
        return frozenset()
    for name, addresses in interfaces.items():
        for address in addresses:
            if address.family not in (socket.AF_INET, socket.AF_INET6):
                continue
            host = str(address.address).split("%", 1)[0]
            try:
                if ipaddress.ip_address(host).is_loopback:
                    continue
            except ValueError:
                continue
            found.add((name, host))
    return frozenset(found)


def normalize_ip(value: str | None, family: int) -> str | None:
    if value is None or value == "":
        return None
    address = ipaddress.ip_address(value.strip())
    if address.version != family:
        raise ValueError(f"expected an IPv{family} address")
    return str(address)


class EgressPinPolicy:
    """In-memory decision consulted from mitmproxy hooks (never touches SQLite)."""

    def __init__(
        self,
        store: FlowStore,
        lockdown: LockdownPolicy,
        *,
        interfaces: Callable[[], Snapshot] = local_interface_addresses,
    ) -> None:
        self.store = store
        self.lockdown = lockdown
        self._interfaces = interfaces
        self.enabled = False
        self.pinned: dict[int, str | None] = {4: None, 6: None}
        self.mismatch: dict[int, str | None] = {4: None, 6: None}
        # (monotonic, wall clock) of the last matching observation. macOS
        # monotonic time stops during sleep, so both clocks must agree.
        self._confirmed: dict[int, tuple[float, float] | None] = {4: None, 6: None}
        self._snapshot: Snapshot | None = None
        self._was_allowed = True
        self._task: asyncio.Task[None] | None = None
        # Close live user connections when traffic stops being allowed.
        self.on_revoked: Callable[[], None] | None = None
        # Ask the observer for an immediate re-check.
        self.on_unverified: Callable[[], None] | None = None
        self.reload()

    # --- configuration -----------------------------------------------------
    def reload(self) -> dict[str, object]:
        self.enabled = self.store.get_setting(ENABLED_SETTING, "0") == "1"
        self.pinned = {}
        for family, key in ((4, IPV4_SETTING), (6, IPV6_SETTING)):
            try:
                self.pinned[family] = normalize_ip(self.store.get_setting(key), family)
            except ValueError:
                # An unreadable pin can never match: stay closed, not open.
                logger.warning("ignoring invalid pinned public IP in %s", key)
                self.pinned[family] = None
        self._reset()
        self.evaluate()
        return self.status()

    def configure(self, enabled: bool, ipv4: str | None, ipv6: str | None) -> dict[str, object]:
        pinned = {4: normalize_ip(ipv4, 4), 6: normalize_ip(ipv6, 6)}
        if enabled and not any(pinned.values()):
            raise ValueError("at least one public IP is required")
        if not enabled:
            pinned = {4: None, 6: None}
        self.store.set_setting(ENABLED_SETTING, "1" if enabled else "0")
        self.store.set_setting(IPV4_SETTING, pinned[4] or "")
        self.store.set_setting(IPV6_SETTING, pinned[6] or "")
        self.enabled = enabled
        self.pinned = pinned
        self._reset()
        self.evaluate()
        if enabled and self.on_unverified is not None:
            self.on_unverified()
        return self.status()

    def _reset(self) -> None:
        self.mismatch = {4: None, 6: None}
        self._confirmed = {4: None, 6: None}
        self._snapshot = None

    # --- decision ----------------------------------------------------------
    def reason(self) -> str | None:
        """``None`` when user traffic may leave, otherwise why it may not."""
        if not self.enabled:
            return None
        if self.lockdown.enabled:
            return "lockdown"
        if any(self.mismatch.values()):
            return "mismatch"
        if not any(self.pinned.values()):
            return "unverified"
        mono, wall = time.monotonic(), time.time()
        for family, ip in self.pinned.items():
            if ip is None:
                continue
            confirmed = self._confirmed[family]
            if confirmed is None:
                return "unverified"
            mono_age, wall_age = mono - confirmed[0], wall - confirmed[1]
            if mono_age > VALID_SECONDS or not 0 <= wall_age <= VALID_SECONDS:
                return "unverified"
        return None

    @property
    def allowed(self) -> bool:
        return self.reason() is None

    def evaluate(self) -> bool:
        allowed = self.allowed
        if self._was_allowed and not allowed and self.on_revoked is not None:
            self.on_revoked()
        self._was_allowed = allowed
        return allowed

    def status(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "ipv4": self.pinned[4],
            "ipv6": self.pinned[6],
            "allowed": self.allowed,
            "reason": self.reason(),
            "mismatch": {"ipv4": self.mismatch[4], "ipv6": self.mismatch[6]},
        }

    # --- observer feedback -------------------------------------------------
    def network_snapshot(self) -> Snapshot:
        return self._interfaces()

    def observed(self, family: int, ip: str, before: Snapshot) -> None:
        """Record one observation; ``before`` is the network it started on."""
        if not self.enabled:
            return
        if before != self._interfaces():
            # The answer may describe the old network. Do not trust it.
            self.invalidate()
            return
        if ip == self.pinned[family]:
            self._confirmed[family] = (time.monotonic(), time.time())
            self.mismatch[family] = None
            self._snapshot = before
        else:
            # Includes an address in a family that was not pinned at all.
            self._confirmed[family] = None
            self.mismatch[family] = ip
        self.evaluate()

    def observation_failed(self, family: int) -> None:
        if not self.enabled:
            return
        if self.pinned[family] is None:
            # The unpinned family is unreachable again.
            self.mismatch[family] = None
        else:
            self._confirmed[family] = None
        self.evaluate()

    def invalidate(self) -> None:
        """The route or network changed; require a fresh confirmation."""
        if not self.enabled:
            return
        self._confirmed = {4: None, 6: None}
        self._snapshot = None
        self.evaluate()
        if self.on_unverified is not None:
            self.on_unverified()

    # --- network watcher ---------------------------------------------------
    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._watch(), name="lanius-egress-pin")

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(WATCH_SECONDS)
            if not self.enabled:
                continue
            if self._snapshot is not None:
                current = await asyncio.to_thread(self._interfaces)
                if self._snapshot is not None and current != self._snapshot:
                    logger.info("network interfaces changed; public IP pin re-checks")
                    self.invalidate()
                    continue
            # A confirmation also expires with time alone.
            self.evaluate()
