"""Which build this is, and how it works that out."""

from __future__ import annotations

import pytest

from app import build_info as module


@pytest.fixture(autouse=True)
def clear_cache():
    module.build_info.cache_clear()
    yield
    module.build_info.cache_clear()


def test_reads_the_stamp_a_build_left(monkeypatch) -> None:
    """A frozen binary has no repository to ask, so the build writes the
    answer in."""
    monkeypatch.setattr(
        module, "_stamped", lambda: ("abc1234def", "nightly-20260101", "2026-01-01", False)
    )
    info = module.build_info()
    assert info["commit"] == "abc1234def"
    assert info["release"] == "nightly-20260101"
    assert info["source"] == "release"


def test_prefers_the_stamp_over_the_environment(monkeypatch) -> None:
    """Reading the environment at runtime would describe whoever launched
    the binary, not whoever built it."""
    monkeypatch.setenv("LANIUS_BUILD_COMMIT", "from-the-environment")
    monkeypatch.setattr(module, "_stamped", lambda: ("from-the-build", None, None, False))
    assert module.build_info()["commit"] == "from-the-build"


def test_falls_back_to_git_in_a_checkout(monkeypatch) -> None:
    monkeypatch.setattr(module, "_stamped", lambda: None)
    monkeypatch.delenv("LANIUS_BUILD_COMMIT", raising=False)
    monkeypatch.delenv("LANIUS_BUILD_RELEASE", raising=False)
    calls = {}

    def fake_git(*args):
        calls[args] = True
        if args[0] == "rev-parse":
            return "0123456789abcdef"
        if args[0] == "describe":
            return None
        return ""

    monkeypatch.setattr(module, "_git", fake_git)
    info = module.build_info()
    assert info["commit"] == "0123456789abcdef"
    assert info["commit_short"] == "0123456"


def test_a_checkout_without_a_tag_is_not_a_release(monkeypatch) -> None:
    """Otherwise a development build would report itself as whatever was
    last released."""
    monkeypatch.setattr(module, "_stamped", lambda: None)
    monkeypatch.delenv("LANIUS_BUILD_COMMIT", raising=False)
    monkeypatch.delenv("LANIUS_BUILD_RELEASE", raising=False)
    monkeypatch.setattr(
        module, "_git", lambda *a: "abc" if a[0] == "rev-parse" else None
    )
    assert module.build_info()["source"] == "development"


def test_says_when_the_tree_had_uncommitted_changes(monkeypatch) -> None:
    """The commit does not describe what is running if the tree was
    dirty, which matters in a bug report."""
    monkeypatch.setattr(module, "_stamped", lambda: None)
    monkeypatch.delenv("LANIUS_BUILD_COMMIT", raising=False)

    def fake_git(*args):
        if args[0] == "status":
            return " M engine/app/main.py"
        if args[0] == "rev-parse":
            return "abc"
        return None

    monkeypatch.setattr(module, "_git", fake_git)
    assert module.build_info()["dirty"] is True


def test_survives_a_machine_without_git(monkeypatch) -> None:
    """A downloaded build has no git and no repository; it must still
    report its version."""
    monkeypatch.setattr(module, "_stamped", lambda: None)
    monkeypatch.delenv("LANIUS_BUILD_COMMIT", raising=False)
    monkeypatch.delenv("LANIUS_BUILD_RELEASE", raising=False)
    monkeypatch.setattr(module, "_git", lambda *a: None)
    info = module.build_info()
    assert info["version"]
    assert info["commit"] is None
    assert info["commit_short"] is None


def test_the_environment_can_supply_the_values(monkeypatch) -> None:
    """So a build outside a checkout, in CI, can still say what it is."""
    monkeypatch.setattr(module, "_stamped", lambda: None)
    monkeypatch.setenv("LANIUS_BUILD_COMMIT", "ffffffffffff")
    monkeypatch.setenv("LANIUS_BUILD_RELEASE", "nightly-20260202")
    info = module.build_info()
    assert info["commit_short"] == "fffffff"
    assert info["source"] == "release"
    # Nothing was built from a dirty tree if the build said what it was.
    assert info["dirty"] is False
