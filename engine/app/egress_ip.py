"""Periodic, opt-in observation of the public address used for egress.

The observer is product-owned traffic, not captured browser traffic.  It must
therefore pass through :class:`LockdownPolicy` before DNS or a socket is
created.  Observations use the configured upstream route, but are stored as
what the observer saw -- never as a claim about an arbitrary target server.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import time
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlsplit

import httpx

from .db.store import FlowStore
from .lockdown import BLOCKED_DETAIL, LockdownBlocked, LockdownPolicy

logger = logging.getLogger(__name__)

ENABLED_SETTING = "egress_ip.enabled"
INTERVAL_SETTING = "egress_ip.interval_seconds"
IPV4_URL_SETTING = "egress_ip.ipv4_url"
IPV6_URL_SETTING = "egress_ip.ipv6_url"

DEFAULT_INTERVAL_SECONDS = 180
ALLOWED_INTERVALS = frozenset({60, 180, 300})
DEFAULT_IPV4_URL = "https://api.ipify.org"
DEFAULT_IPV6_URL = "https://api6.ipify.org"
MAX_RESPONSE_BYTES = 256
REQUEST_TIMEOUT_SECONDS = 8.0


def validate_observer_url(value: str) -> str:
    """Return a safe, normalized HTTPS observer URL."""
    value = value.strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid observer URL") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or any(character.isspace() for character in value)
    ):
        raise ValueError("observer URL must be HTTPS without credentials or a fragment")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("observer URL port must be between 1 and 65535")
    return value


@dataclass(frozen=True, slots=True)
class EgressIpConfig:
    enabled: bool = False
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS
    ipv4_url: str = DEFAULT_IPV4_URL
    ipv6_url: str = DEFAULT_IPV6_URL


def _read_config(store: FlowStore) -> EgressIpConfig:
    try:
        interval = int(store.get_setting(INTERVAL_SETTING) or DEFAULT_INTERVAL_SECONDS)
    except ValueError:
        interval = DEFAULT_INTERVAL_SECONDS
    if interval not in ALLOWED_INTERVALS:
        interval = DEFAULT_INTERVAL_SECONDS

    def saved_url(key: str, default: str) -> str:
        try:
            return validate_observer_url(store.get_setting(key) or default)
        except ValueError:
            logger.warning("ignoring invalid saved public IP observer URL for %s", key)
            return default

    return EgressIpConfig(
        enabled=store.get_setting(ENABLED_SETTING, "0") == "1",
        interval_seconds=interval,
        ipv4_url=saved_url(IPV4_URL_SETTING, DEFAULT_IPV4_URL),
        ipv6_url=saved_url(IPV6_URL_SETTING, DEFAULT_IPV6_URL),
    )


def _parse_ip(body: bytes, family: int) -> str:
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError("observer response is too large")
    text = body.decode("utf-8").strip()
    if text.startswith("{"):
        try:
            payload = json.loads(text)
            text = next(
                str(payload[key]).strip()
                for key in ("ip", "ip_addr", "address")
                if isinstance(payload, dict) and payload.get(key)
            )
        except (json.JSONDecodeError, StopIteration, TypeError) as exc:
            raise ValueError("observer JSON has no IP address") from exc
    try:
        address = ipaddress.ip_address(text)
    except ValueError as exc:
        raise ValueError("observer did not return an IP address") from exc
    if address.version != family:
        raise ValueError(f"observer returned IPv{address.version}, expected IPv{family}")
    if not address.is_global:
        raise ValueError("observer returned a non-public IP address")
    return str(address)


async def _request_ip(url: str, family: int, proxy_url: str | None) -> str:
    """Fetch and validate one address without following redirects."""
    timeout = httpx.Timeout(REQUEST_TIMEOUT_SECONDS)
    async with httpx.AsyncClient(
        proxy=proxy_url,
        timeout=timeout,
        follow_redirects=False,
        trust_env=False,
        headers={"Accept": "text/plain, application/json"},
    ) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ValueError("observer response is too large")
    return _parse_ip(bytes(body), family)


class EgressIpMonitor:
    """Own the background polling loop and its in-memory status."""

    def __init__(
        self,
        store: FlowStore,
        lockdown: LockdownPolicy,
        proxy_url: Callable[[], str | None],
    ) -> None:
        self.store = store
        self.lockdown = lockdown
        self.proxy_url = proxy_url
        self.config = _read_config(store)
        self.last_checked_at: float | None = None
        self.last_success_at: float | None = None
        self.errors: dict[int, str | None] = {4: None, 6: None}
        self._revision = 0
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="lanius-egress-ip")

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

    async def reload(self) -> None:
        self.config = _read_config(self.store)
        self._revision += 1
        self._wake.set()

    def policy_changed(self) -> None:
        """Discard an in-flight result and re-evaluate the Lockdown gate."""
        self._revision += 1
        self._wake.set()

    def route_changed(self) -> None:
        """Never save an answer obtained through a route being replaced."""
        self._revision += 1
        self._wake.set()

    async def configure(self, config: EgressIpConfig) -> None:
        if config.interval_seconds not in ALLOWED_INTERVALS:
            raise ValueError("poll interval must be 60, 180 or 300 seconds")
        ipv4_url = validate_observer_url(config.ipv4_url)
        ipv6_url = validate_observer_url(config.ipv6_url)
        self.store.set_setting(ENABLED_SETTING, "1" if config.enabled else "0")
        self.store.set_setting(INTERVAL_SETTING, str(config.interval_seconds))
        self.store.set_setting(IPV4_URL_SETTING, ipv4_url)
        self.store.set_setting(IPV6_URL_SETTING, ipv6_url)
        self.config = EgressIpConfig(
            enabled=config.enabled,
            interval_seconds=config.interval_seconds,
            ipv4_url=ipv4_url,
            ipv6_url=ipv6_url,
        )
        self._revision += 1
        self._wake.set()

    def state(self, *, history_limit: int = 20) -> dict[str, object]:
        observations = self.store.list_egress_ip_observations(limit=history_limit)
        current = {
            "ipv4": self.store.latest_egress_ip_observation(4),
            "ipv6": self.store.latest_egress_ip_observation(6),
        }
        return {
            "enabled": self.config.enabled,
            "interval_seconds": self.config.interval_seconds,
            "ipv4_url": self.config.ipv4_url,
            "ipv6_url": self.config.ipv6_url,
            "blocked_by_lockdown": self.lockdown.enabled,
            "last_checked_at": self.last_checked_at,
            "last_success_at": self.last_success_at,
            "errors": {"ipv4": self.errors[4], "ipv6": self.errors[6]},
            "current": current,
            "history": observations,
        }

    async def _wait(self, timeout: float | None = None) -> None:
        if self._wake.is_set():
            self._wake.clear()
            return
        try:
            if timeout is None:
                await self._wake.wait()
            else:
                await asyncio.wait_for(self._wake.wait(), timeout=timeout)
        except TimeoutError:
            pass
        finally:
            self._wake.clear()

    async def _run(self) -> None:
        while True:
            revision = self._revision
            config = self.config
            if not config.enabled or self.lockdown.enabled:
                await self._wait()
                continue
            await self._poll(config, revision)
            if revision != self._revision:
                continue
            await self._wait(float(config.interval_seconds))

    async def _poll(self, config: EgressIpConfig, revision: int) -> None:
        self.last_checked_at = time.time()
        for family, url in ((4, config.ipv4_url), (6, config.ipv6_url)):
            try:
                await self._observe(family, url, revision)
                self.errors[family] = None
            except LockdownBlocked:
                self.errors[family] = BLOCKED_DETAIL
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.errors[family] = str(exc)
                logger.info("public IPv%s observation failed: %s", family, exc)

    async def _observe(self, family: int, url: str, revision: int) -> None:
        # Keep the policy context around the entire network operation. Turning
        # Lockdown on cancels this task; no result survives to the DB write.
        async with self.lockdown.outbound("public IP observation"):
            observed = await _request_ip(url, family, self.proxy_url())
            if (
                self.lockdown.enabled
                or revision != self._revision
                or not self.config.enabled
            ):
                return
            # Deliberately synchronous and immediately after the final policy
            # check: the event loop cannot activate Lockdown between the check
            # and commit. This write is one indexed SELECT plus UPDATE/INSERT.
            self.store.record_egress_ip_observation(
                family=family,
                ip=observed,
                observed_at=time.time(),
                observer_url=url,
            )
            self.last_success_at = time.time()
