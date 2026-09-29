"""Policy for Lanius-owned outbound traffic.

Proxy forwarding, replay and fuzzing are user traffic and deliberately do not
pass through this gate. Product features such as updates and remote wordlists
must call :meth:`LockdownPolicy.require_outbound` before opening a connection.
"""

from __future__ import annotations

import os
import asyncio
from contextlib import asynccontextmanager
from typing import Any

from .db.store import FlowStore

PROJECT_SETTING = "lockdown.project"
BLOCKED_DETAIL = "LOCKDOWN_MODE_BLOCKED"


class LockdownBlocked(RuntimeError):
    """A Lanius-owned external connection was refused by Lockdown Mode."""

    def __init__(self, purpose: str) -> None:
        super().__init__(f"{BLOCKED_DETAIL}: {purpose}")
        self.purpose = purpose


class LockdownPolicy:
    def __init__(self, store: FlowStore, *, global_enabled: bool = False) -> None:
        self.store = store
        self.global_enabled = global_enabled
        self._active: set[asyncio.Task[Any]] = set()

    @classmethod
    def from_env(cls, store: FlowStore) -> "LockdownPolicy":
        return cls(
            store,
            global_enabled=(
                os.environ.get("LANIUS_LOCKDOWN_GLOBAL") == "1"
                or os.environ.get("LANIUS_LOCKDOWN") == "1"
            ),
        )

    @property
    def project_enabled(self) -> bool:
        return self.store.get_setting(PROJECT_SETTING, "0") == "1"

    @property
    def enabled(self) -> bool:
        return self.global_enabled or self.project_enabled

    def status(self) -> dict[str, Any]:
        return {
            "global_enabled": self.global_enabled,
            "project_enabled": self.project_enabled,
            "effective": self.enabled,
        }

    def set_project(self, enabled: bool) -> dict[str, Any]:
        self.store.set_setting(PROJECT_SETTING, "1" if enabled else "0")
        if self.enabled:
            for task in tuple(self._active):
                task.cancel()
        return self.status()

    def require_outbound(self, purpose: str) -> None:
        if self.enabled:
            raise LockdownBlocked(purpose)

    @asynccontextmanager
    async def outbound(self, purpose: str):
        """Cancel an in-flight product request when project mode turns on."""
        self.require_outbound(purpose)
        task = asyncio.current_task()
        if task is not None:
            self._active.add(task)
        try:
            yield
        except asyncio.CancelledError:
            if self.enabled:
                raise LockdownBlocked(purpose) from None
            raise
        finally:
            if task is not None:
                self._active.discard(task)
