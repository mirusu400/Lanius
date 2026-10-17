"""Cleanup progress must be honest about what it measures and never go back."""

from __future__ import annotations

import pytest

from app import compact_progress as module
from app.compact_progress import CompactProgress, CompactRates


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture()
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(module.time, "monotonic", fake)
    return fake


def test_deletion_is_measured_and_timed_from_its_own_rate(clock: Clock) -> None:
    progress = CompactProgress()
    assert progress.start("op", 1000)
    progress.plan(db_bytes=10_000_000, live_bytes=5_000_000)
    progress.update("deleting")

    clock.now += 1
    progress.update("deleting", 100)
    early = progress.get("op")
    assert early["estimated"] is False
    assert early["eta_seconds"] is None  # too soon to promise anything
    assert early["elapsed_seconds"] == 1.0

    clock.now += 4
    progress.update("deleting", 500)
    later = progress.get("op")
    assert later["percent"] > early["percent"]
    # 500 flows in 5 s leaves 5 s for the rest, plus the phases after it.
    assert later["eta_seconds"] >= 5.0
    assert later["eta_seconds"] < 10.0


def test_slow_first_deletion_still_moves_the_bar(clock: Clock) -> None:
    """Uncalibrated defaults must not leave a long deletion stuck near 0%."""
    progress = CompactProgress()
    progress.start("op", 4000)
    progress.plan(db_bytes=3_000_000_000, live_bytes=1_500_000_000)
    progress.update("deleting")
    clock.now += 80
    progress.update("deleting", 2000)  # 25 flows/s, far below the default
    halfway = progress.get("op")
    assert halfway["percent"] > 30
    assert halfway["eta_seconds"] >= 80


def test_vacuum_switches_from_estimate_to_log_growth(clock: Clock, tmp_path) -> None:
    wal = tmp_path / "project.sqlite-wal"
    wal.write_bytes(b"")
    progress = CompactProgress(wal_path=wal)
    progress.start("op", 0)
    progress.plan(db_bytes=40_000_000, live_bytes=40_000_000)
    progress.update("optimizing")
    clock.now += 0.3
    progress.update("vacuuming", live_bytes=40_000_000)

    clock.now += 0.2
    building = progress.get("op")
    assert building["phase"] == "vacuuming"
    assert building["estimated"] is True

    clock.now += 0.4
    wal.write_bytes(b"x" * 1_000_000)
    progress.get("op")  # the UI polls; the copy is first seen here
    clock.now += 1.5
    wal.write_bytes(b"x" * 20_000_000)
    copying = progress.get("op")
    assert copying["estimated"] is False
    assert copying["percent"] > building["percent"]
    assert copying["eta_seconds"] is not None


def test_overrun_hides_remaining_time_but_never_lowers_percent(clock: Clock) -> None:
    progress = CompactProgress()
    progress.start("op", 0)
    progress.plan(db_bytes=150_000_000, live_bytes=1)
    progress.update("optimizing")
    clock.now += 2.5
    before = progress.get("op")
    assert before["eta_seconds"] is None  # a 1 s estimate has already overrun
    clock.now += 60
    after = progress.get("op")
    assert after["percent"] >= before["percent"]
    assert after["percent"] < 100

    progress.update("refreshing")
    progress.finish(True)
    done = progress.get("op")
    assert done["percent"] == 100
    assert done["active"] is False


def test_measured_rates_are_kept_for_the_next_cleanup(clock: Clock, tmp_path) -> None:
    path = tmp_path / "compact-rates.json"
    progress = CompactProgress(rates=CompactRates(path))
    progress.start("op", 0)
    progress.plan(db_bytes=10_000_000, live_bytes=20_000_000)
    progress.update("vacuuming")
    clock.now += 2
    progress.update("checkpointing")
    clock.now += 0.1  # too short to calibrate anything
    progress.finish(True)

    rates = CompactRates(path)
    assert rates.calibrated == {"vacuuming"}
    assert rates.get("vacuuming") == pytest.approx(10_000_000)


def test_failed_cleanup_does_not_calibrate(clock: Clock, tmp_path) -> None:
    path = tmp_path / "compact-rates.json"
    progress = CompactProgress(rates=CompactRates(path))
    progress.start("op", 0)
    progress.plan(db_bytes=1, live_bytes=20_000_000)
    progress.update("vacuuming")
    clock.now += 5
    progress.finish(False)
    assert not path.exists()
    assert progress.get("op")["phase"] == "failed"


def test_unreadable_rates_fall_back_to_defaults(tmp_path) -> None:
    path = tmp_path / "compact-rates.json"
    path.write_text('{"vacuuming": -1, "deleting": "fast", "other": 5}')
    rates = CompactRates(path)
    assert rates.calibrated == set()
    assert rates.get("vacuuming") == module.DEFAULT_RATES["vacuuming"]
