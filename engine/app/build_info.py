"""What build this is.

A version number alone does not identify a build: every nightly this
month says 0.1.0. When something looks wrong, the useful question is
which commit it came from, and whether it is a release or something
somebody built on their own machine.

The values are stamped in at build time, because a frozen binary has no
repository to ask. In a checkout they are read from git instead, so a
development build reports itself honestly rather than claiming to be
whatever was last released.
"""

from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path

from . import __version__

# Written by the build. The nightly workflow sets them; a local build
# leaves them empty and the values come from git.
_COMMIT_ENV = "LANIUS_BUILD_COMMIT"
_RELEASE_ENV = "LANIUS_BUILD_RELEASE"
_DATE_ENV = "LANIUS_BUILD_DATE"


def _git(*args: str) -> str | None:
    """Run a git command in the checkout, if there is one."""
    root = Path(__file__).resolve().parents[2]
    if not (root / ".git").exists():
        return None
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def _stamped() -> tuple[str | None, str | None, str | None, bool] | None:
    """What the build wrote in, if this is a built binary."""
    try:
        from . import _build_stamp  # type: ignore[attr-defined]
    except ImportError:
        return None
    return (
        getattr(_build_stamp, "COMMIT", None),
        getattr(_build_stamp, "RELEASE", None),
        getattr(_build_stamp, "BUILT_AT", None),
        bool(getattr(_build_stamp, "DIRTY", False)),
    )


@lru_cache(maxsize=1)
def build_info() -> dict[str, object]:
    """Version, commit and release for this build.

    Cached: the answer cannot change while the process is running, and
    the git calls are not worth repeating.
    """
    stamp = _stamped()
    if stamp is not None:
        commit, release, date, dirty = stamp
    else:
        # A checkout. Environment variables win so a build can say what
        # it is without a repository, then git, so a development build
        # reports itself rather than claiming the last release.
        commit = os.environ.get(_COMMIT_ENV) or _git("rev-parse", "HEAD")
        release = os.environ.get(_RELEASE_ENV) or _git(
            "describe", "--tags", "--exact-match"
        )
        date = os.environ.get(_DATE_ENV)
        # Uncommitted changes mean the commit does not describe what is
        # running, which is worth saying out loud in a bug report.
        dirty = bool(_git("status", "--porcelain")) if not os.environ.get(
            _COMMIT_ENV
        ) else False

    return {
        "version": __version__,
        "commit": commit,
        # Seven characters is what people paste and what GitHub shows.
        "commit_short": commit[:7] if commit else None,
        "release": release,
        "built_at": date,
        "dirty": dirty,
        # A build with no release tag came from a checkout, not a
        # download, and should not be reported as a release.
        "source": "release" if release else "development",
    }
