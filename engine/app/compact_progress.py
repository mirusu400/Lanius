"""Progress, percentage and remaining time for project cleanup.

SQLite says nothing while it rebuilds a database, so only deletion has an
exact count. The other phases are weighted by how long they took on this
machine before, and VACUUM is partly measured: in WAL mode it first builds
a temporary copy (invisible to us) and then writes the rebuilt file into
the write-ahead log, which grows towards the size of the live data.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PHASES = ("preparing", "deleting", "optimizing", "vacuuming", "checkpointing", "refreshing")

# Work per second before this machine has been measured. Deliberately
# modest: an estimate that finishes early reads better than one that stalls.
DEFAULT_RATES = {
    "deleting": 100.0,  # flows; search-index deletes dominate
    "optimizing": 150e6,  # database bytes
    "vacuuming": 40e6,  # live bytes
    "checkpointing": 150e6,  # live bytes
}
FIXED_SECONDS = {"preparing": 0.5, "refreshing": 0.5}
# Share of a VACUUM spent building the temporary copy before the log grows.
VACUUM_BUILD_SHARE = 0.4
# A time-based phase never claims to be finished before it is.
TIME_BASED_CAP = 0.95
# Rates measured over less than this are noise, not a calibration.
MIN_CALIBRATION_SECONDS = 1.0
# No remaining time until there is something to base it on.
SETTLE_SECONDS = 2.0


class CompactRates:
    """Per-machine phase throughput, kept outside any project."""

    def __init__(self, path: Path | None) -> None:
        self._path = path
        self._rates = dict(DEFAULT_RATES)
        self.calibrated: set[str] = set()
        if path is None:
            return
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(stored, dict):
            return
        for phase, rate in stored.items():
            if phase in DEFAULT_RATES and isinstance(rate, (int, float)) and rate > 0:
                self._rates[phase] = float(rate)
                self.calibrated.add(phase)

    def get(self, phase: str) -> float:
        return self._rates[phase]

    def record(self, measured: dict[str, float]) -> None:
        for phase, rate in measured.items():
            if phase in self.calibrated:
                # Blend so that one unusual run does not swing the next estimate.
                rate = (self._rates[phase] + rate) / 2
            self._rates[phase] = rate
            self.calibrated.add(phase)
        if self._path is None or not measured:
            return
        try:
            self._path.write_text(
                json.dumps({phase: self._rates[phase] for phase in sorted(self.calibrated)}),
                encoding="utf-8",
            )
        except OSError:
            logger.warning("could not save cleanup timings", exc_info=True)


class CompactProgress:
    """One active cleanup per project; snapshots never wait for the database."""

    def __init__(self, wal_path: Path | None = None, rates: CompactRates | None = None) -> None:
        self._lock = threading.Lock()
        self._wal_path = wal_path
        self._rates = rates or CompactRates(None)
        self._snapshot: dict[str, Any] | None = None
        self._active = False
        self._started = self._phase_started = 0.0
        self._finished: float | None = None
        self._durations: dict[str, float] = {}
        self._db_bytes = self._live_bytes = self._wal_base = 0
        self._planned = False
        self._copy_started: float | None = None
        self._percent = 0.0

    def start(self, operation_id: str, total_flows: int) -> bool:
        with self._lock:
            if self._active:
                return False
            self._active = True
            now = time.monotonic()
            self._snapshot = {
                "operation_id": operation_id,
                "phase": "preparing",
                "processed_flows": 0,
                "total_flows": total_flows,
            }
            self._started = now
            self._finished = None
            self._phase_started = now
            self._durations = {}
            self._db_bytes = 0
            self._live_bytes = 0
            self._planned = False
            self._wal_base = 0
            self._copy_started = None
            self._percent = 0.0
            return True

    def plan(self, *, db_bytes: int, live_bytes: int) -> None:
        """Size the work once the preview has been re-read."""
        with self._lock:
            self._db_bytes = max(0, db_bytes)
            self._live_bytes = max(0, live_bytes)
            self._planned = True

    def update(
        self,
        phase: str,
        processed_flows: int | None = None,
        *,
        live_bytes: int | None = None,
    ) -> None:
        with self._lock:
            if self._snapshot is None:
                return
            now = time.monotonic()
            if phase != self._snapshot["phase"]:
                self._end_phase(now)
                self._snapshot["phase"] = phase
                self._phase_started = now
                if phase == "vacuuming":
                    self._wal_base = self._wal_size()
                    self._copy_started = None
            if processed_flows is not None:
                self._snapshot["processed_flows"] = processed_flows
            if live_bytes is not None:
                self._live_bytes = max(0, live_bytes)

    def finish(self, succeeded: bool) -> None:
        with self._lock:
            if self._snapshot is None:
                return
            now = time.monotonic()
            self._end_phase(now)
            self._finished = now
            self._snapshot["phase"] = "done" if succeeded else "failed"
            self._active = False
            measured = self._measured_rates() if succeeded else {}
        if measured:
            self._rates.record(measured)

    def get(self, operation_id: str) -> dict[str, Any] | None:
        with self._lock:
            if self._snapshot is None or self._snapshot["operation_id"] != operation_id:
                return None
            return self._report()

    def current(self) -> dict[str, Any] | None:
        """The running cleanup, so a reloaded window can show it again."""
        with self._lock:
            if not self._active:
                return None
            return self._report()

    # --- internals, called with the lock held -----------------------------
    def _state(self) -> dict[str, Any]:
        assert self._snapshot is not None
        return self._snapshot

    def _end_phase(self, now: float) -> None:
        phase = self._state()["phase"]
        if phase in PHASES:
            self._durations[phase] = self._durations.get(phase, 0.0) + now - self._phase_started

    def _measured_rates(self) -> dict[str, float]:
        work = {
            "deleting": self._state()["total_flows"],
            "optimizing": self._db_bytes,
            "vacuuming": self._live_bytes,
            "checkpointing": self._live_bytes,
        }
        return {
            phase: amount / self._durations[phase]
            for phase, amount in work.items()
            if amount > 0 and self._durations.get(phase, 0.0) >= MIN_CALIBRATION_SECONDS
        }

    def _wal_size(self) -> int:
        if self._wal_path is None:
            return 0
        try:
            return self._wal_path.stat().st_size
        except OSError:
            return 0

    def _estimates(self) -> dict[str, float]:
        total_flows = self._state()["total_flows"]
        return {
            "preparing": FIXED_SECONDS["preparing"],
            "deleting": total_flows / self._rates.get("deleting") if total_flows else 0.0,
            "optimizing": self._db_bytes / self._rates.get("optimizing"),
            "vacuuming": self._live_bytes / self._rates.get("vacuuming"),
            "checkpointing": self._live_bytes / self._rates.get("checkpointing"),
            "refreshing": FIXED_SECONDS["refreshing"],
        }

    def _current(self, now: float, estimate: float) -> tuple[float, float | None, bool]:
        """Fraction done, seconds left (None if unknown) and whether it is measured."""
        phase = self._state()["phase"]
        spent = now - self._phase_started
        if phase == "deleting":
            total = self._state()["total_flows"]
            done = self._state()["processed_flows"]
            if not total:
                return 1.0, 0.0, True
            left = (total - done) / (done / spent) if done and spent > 0 else estimate
            return min(1.0, done / total), left, True
        if phase == "vacuuming" and self._live_bytes > 0:
            written = max(0, self._wal_size() - self._wal_base)
            if written > 0:
                if self._copy_started is None:
                    self._copy_started = now
                copied = min(1.0, written / self._live_bytes)
                fraction = VACUUM_BUILD_SHARE + (1 - VACUUM_BUILD_SHARE) * copied
                copying = now - self._copy_started
                if copying >= 0.5 and copied > 0:
                    left = copying / copied * (1 - copied)
                else:
                    left = max(0.0, estimate * (1 - fraction))
                return fraction, left, True
            build = estimate * VACUUM_BUILD_SHARE
            share = min(spent / build, TIME_BASED_CAP) if build > 0 else TIME_BASED_CAP
            left = None if spent > build else estimate - spent
            return VACUUM_BUILD_SHARE * share, left, False
        fraction = min(spent / estimate, TIME_BASED_CAP) if estimate > 0 else TIME_BASED_CAP
        return fraction, (None if spent > estimate else estimate - spent), False

    def _report(self) -> dict[str, Any]:
        snapshot = self._state().copy()
        now = self._finished or time.monotonic()
        snapshot["active"] = self._active
        snapshot["elapsed_seconds"] = round(now - self._started, 1)
        phase = snapshot["phase"]
        if phase == "done":
            self._percent = 100.0
        if phase not in PHASES or not self._planned:
            snapshot.update(percent=round(self._percent, 1), eta_seconds=None, estimated=True)
            return snapshot

        estimates = self._estimates()
        if not snapshot["total_flows"]:
            estimates["deleting"] = 0.0
        index = PHASES.index(phase)
        # What has finished took exactly as long as it took.
        for name in PHASES[:index]:
            estimates[name] = self._durations.get(name, 0.0)
        fraction, left, measured = self._current(now, estimates[phase])
        if measured and left is not None:
            # A measured phase knows its own length better than any default,
            # so it also gets its real share of the bar.
            estimates[phase] = now - self._phase_started + left
        total = sum(estimates.values())
        done = sum(estimates[name] for name in PHASES[:index]) + fraction * estimates[phase]
        if total > 0:
            # Estimates are revised as phases finish; the bar never goes back.
            self._percent = max(self._percent, min(99.0, 100 * done / total))
        eta = None
        if left is not None and now - self._started >= SETTLE_SECONDS:
            eta = max(0.0, left + sum(estimates[name] for name in PHASES[index + 1 :]))
        snapshot.update(
            percent=round(self._percent, 1),
            eta_seconds=None if eta is None else round(eta, 1),
            estimated=not measured,
        )
        return snapshot
