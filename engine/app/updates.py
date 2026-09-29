"""Is there a newer build than this one?

The app ships two streams: a rolling `nightly` prerelease rebuilt on
every commit that lands on main, and tagged releases. A version number
cannot answer the question on its own - every nightly this month says
0.1.0 - so a nightly is compared by commit and a release by version.

Nothing is downloaded or installed here. The answer is a fact and a
link; what to do with it is the user's decision, which is the right
default for a tool that is often run on an isolated network.
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any

from . import __version__
from .build_info import build_info
from .lockdown import LockdownPolicy

REPO = "mirusu400/Lanius"
RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases"
COMPARE_URL = f"https://api.github.com/repos/{REPO}/compare"

#: The tag the nightly workflow keeps pointed at the tip of main.
NIGHTLY_TAG = "nightly"

CHANNELS = ("stable", "nightly")

TIMEOUT = 10.0

#: GitHub allows sixty unauthenticated calls an hour per address, and the
#: answer does not change between two builds of the same commit. Long
#: enough that an impatient click does not spend the budget, short
#: enough that a nightly published minutes ago is found.
CACHE_TTL = 900.0

_SHA = re.compile(r"[0-9a-f]{40}")
#: Nightly releases are named "Nightly 20260928 (f2b2e22)".
_SHORT_SHA = re.compile(r"\(([0-9a-f]{7,40})\)")

_cache: dict[str, Any] | None = None
_cache_at = 0.0
_lock = asyncio.Lock()


class UpdateError(Exception):
    """GitHub could not be reached or did not answer usefully."""


def _parse_version(text: str | None) -> tuple[int, ...] | None:
    """`v1.2.3` -> (1, 2, 3). Anything else is not a version."""
    if not text:
        return None
    match = re.match(r"v?(\d+(?:\.\d+)*)", text.strip())
    if match is None:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def _release_commit(release: dict[str, Any]) -> str | None:
    """Which commit a release was built from.

    The nightly workflow sets `target_commitish` to the commit CI
    approved, but a release made by hand carries a branch name there, so
    fall back to the sha its name and body both carry.
    """
    target = str(release.get("target_commitish") or "")
    if _SHA.fullmatch(target):
        return target
    for field in ("name", "body"):
        found = _SHORT_SHA.search(str(release.get(field) or ""))
        if found:
            return found.group(1)
    return None


def _published(release: dict[str, Any]) -> str | None:
    """When this build was actually put there.

    The nightly is one rolling release that every commit replaces, and
    GitHub keeps `published_at` at the day it was first created - which
    made a build from this morning claim to be ten days old. The files
    carry the time they were uploaded, so take the newest of those.
    """
    times = [str(release.get("published_at") or "")]
    assets = release.get("assets")
    if isinstance(assets, list):
        for asset in assets:
            if isinstance(asset, dict):
                times.append(str(asset.get("updated_at") or asset.get("created_at") or ""))
    # ISO-8601 in UTC sorts the same as it compares.
    newest = max((value for value in times if value), default="")
    return newest or None


def _entry(release: dict[str, Any], channel: str) -> dict[str, Any]:
    """One release, reduced to what the UI shows."""
    commit = _release_commit(release)
    tag = release.get("tag_name")
    version = _parse_version(tag) if channel == "stable" else None
    return {
        "channel": channel,
        "name": release.get("name") or tag,
        "tag": tag,
        "version": ".".join(str(part) for part in version) if version else None,
        "commit": commit,
        "commit_short": commit[:7] if commit else None,
        "url": release.get("html_url"),
        "published_at": _published(release),
        "prerelease": bool(release.get("prerelease")),
    }


async def _get_json(url: str, policy: LockdownPolicy | None = None) -> Any:
    """One GitHub call, with offline reported as itself."""
    if policy is not None:
        policy.require_outbound("update check")
    try:
        import httpx
    except ImportError as exc:  # pragma: no cover - httpx ships with us
        raise UpdateError("HTTP client unavailable") from exc

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        # GitHub refuses an unidentified client, and saying which build
        # is asking keeps the traffic explainable to whoever owns the
        # network this is running on.
        "User-Agent": f"lanius/{__version__}",
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            response = await client.get(url, headers=headers)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise UpdateError(f"could not reach GitHub: {exc}") from exc

    if response.status_code in (403, 429):
        raise UpdateError("GitHub rate limit reached; try again later")
    if response.status_code == 404:
        raise UpdateError("not found on GitHub")
    if response.status_code != 200:
        raise UpdateError(f"GitHub returned {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise UpdateError("GitHub returned something that is not JSON") from exc


async def _fetch_releases(policy: LockdownPolicy | None = None) -> list[dict[str, Any]]:
    """Published releases, newest first."""
    data = await _get_json(f"{RELEASES_URL}?per_page=20", policy)
    if not isinstance(data, list):
        raise UpdateError("GitHub returned something that is not a release list")
    return [item for item in data if isinstance(item, dict) and not item.get("draft")]


async def _compare(
    base: str, head: str, policy: LockdownPolicy | None = None
) -> str | None:
    """`ahead`, `behind`, `identical`, or None when GitHub cannot say.

    Two different commits are not the same as being out of date: a
    checkout with local work is ahead of the nightly, not behind it, and
    telling that user to update would be wrong.
    """
    try:
        data = await _get_json(f"{COMPARE_URL}/{base}...{head}", policy)
    except UpdateError:
        # A commit that was never pushed cannot be compared, which is
        # not a failure worth reporting on its own.
        return None
    status = data.get("status") if isinstance(data, dict) else None
    return status if isinstance(status, str) else None


def default_channel(current: dict[str, Any] | None = None) -> str:
    """Which stream this build belongs to.

    A build from the nightly workflow should be compared against the
    nightly and not against the last tagged release it is already newer
    than. A checkout tracks main, so it belongs with the nightlies too.
    """
    info = current if current is not None else build_info()
    release = str(info.get("release") or "")
    if release and not release.startswith(NIGHTLY_TAG):
        return "stable"
    return "nightly"


async def _verdict(
    channel: str, latest: dict[str, Any] | None, current: dict[str, Any],
    policy: LockdownPolicy | None = None,
) -> tuple[bool, str]:
    """Whether `latest` beats what is running, and how it was decided."""
    if latest is None:
        return False, "unknown"

    if channel == "stable":
        remote = _parse_version(latest.get("tag"))
        local = _parse_version(str(current.get("version") or ""))
        if remote is None or local is None:
            return False, "unknown"
        return (True, "behind") if remote > local else (False, "current")

    remote_commit = str(latest.get("commit") or "")
    local_commit = str(current.get("commit") or "")
    if not remote_commit or not local_commit:
        return False, "unknown"
    # One of the two is often abbreviated, so compare on the short form.
    if remote_commit.startswith(local_commit[:7]) or local_commit.startswith(
        remote_commit[:7]
    ):
        return False, "current"
    # A dirty checkout is not the commit it reports, and the published
    # nightly cannot contain the uncommitted work.
    if current.get("dirty"):
        return False, "different"

    status = await _compare(local_commit, remote_commit, policy)
    if status == "ahead":
        return True, "behind"
    if status in ("behind", "identical"):
        return False, "current"
    # GitHub could not place the two commits relative to each other, and
    # running something other than the published build is worth saying.
    return True, "different"


async def check(
    *, channel: str | None = None, refresh: bool = False,
    policy: LockdownPolicy | None = None,
) -> dict[str, Any]:
    """What the newest build is, and whether it beats this one."""
    if channel is not None and channel not in CHANNELS:
        raise ValueError(f"unknown channel: {channel!r}")
    if policy is not None:
        async with policy.outbound("update check"):
            return await _check(channel=channel, refresh=refresh, policy=policy)
    return await _check(channel=channel, refresh=refresh, policy=None)


async def _check(
    *, channel: str | None, refresh: bool, policy: LockdownPolicy | None,
) -> dict[str, Any]:

    current = build_info()
    chosen = channel or default_channel(current)

    global _cache, _cache_at
    async with _lock:
        fresh = _cache is not None and (time.monotonic() - _cache_at) < CACHE_TTL
        if refresh or not fresh:
            releases = await _fetch_releases(policy)
            stable = next(
                (
                    _entry(item, "stable")
                    for item in releases
                    if not item.get("prerelease")
                ),
                None,
            )
            nightly = next(
                (
                    _entry(item, "nightly")
                    for item in releases
                    if item.get("tag_name") == NIGHTLY_TAG
                ),
                None,
            )
            _cache = {"stable": stable, "nightly": nightly}
            _cache_at = time.monotonic()
        found = dict(_cache or {"stable": None, "nightly": None})

    latest = found.get(chosen)
    available, reason = await _verdict(chosen, latest, current, policy)
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "channel": chosen,
        "current": current,
        "releases": found,
        "latest": latest,
        "update_available": available,
        "reason": reason,
        # Where to go when there is something to download. The nightly
        # tag moves, so its release page always holds the newest build.
        "download_url": (latest or {}).get("url")
        or f"https://github.com/{REPO}/releases",
    }


def reset_cache() -> None:
    """Forget what GitHub said, so the next check asks again."""
    global _cache, _cache_at
    _cache = None
    _cache_at = 0.0
