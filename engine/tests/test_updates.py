"""Update checks: is the published build newer than this one?

A version number cannot answer that on its own, so nightlies are
compared by commit and releases by version. The cases that matter are
the ones where a naive comparison gets it wrong: a checkout that is
ahead of the nightly, and a build whose commit nobody stamped in.
"""

from __future__ import annotations

import asyncio
from unittest import mock

import pytest

from app import updates

NIGHTLY = {
    "tag_name": "nightly",
    "name": "Nightly 20260928 (f2b2e22)",
    "target_commitish": "f2b2e22b1fddabc0d3bd32c4abd5b0a813dcef62",
    "html_url": "https://github.com/mirusu400/Lanius/releases/tag/nightly",
    "published_at": "2026-09-28T10:00:00Z",
    "prerelease": True,
}

STABLE = {
    "tag_name": "v0.2.0",
    "name": "Lanius 0.2.0",
    "target_commitish": "main",
    "html_url": "https://github.com/mirusu400/Lanius/releases/tag/v0.2.0",
    "published_at": "2026-09-20T10:00:00Z",
    "prerelease": False,
}


def build(**overrides) -> dict:
    info = {
        "version": "0.1.0",
        "commit": "aaaaaaa1111111111111111111111111111111aa",
        "commit_short": "aaaaaaa",
        "release": "nightly-20260920-aaaaaaa",
        "built_at": "20260920",
        "dirty": False,
        "source": "release",
    }
    info.update(overrides)
    return info


@pytest.fixture(autouse=True)
def clean_cache():
    updates.reset_cache()
    yield
    updates.reset_cache()


def run(*, releases=(NIGHTLY, STABLE), compare="ahead", current=None, **kwargs):
    """One check with GitHub replaced by fixed answers."""
    with mock.patch.object(
        updates, "_fetch_releases", mock.AsyncMock(return_value=list(releases))
    ), mock.patch.object(
        updates, "_compare", mock.AsyncMock(return_value=compare)
    ), mock.patch.object(
        updates, "build_info", lambda: current or build()
    ):
        return asyncio.run(updates.check(**kwargs))


def test_nightly_with_a_newer_commit_is_an_update() -> None:
    result = run()
    assert result["channel"] == "nightly"
    assert result["update_available"] is True
    assert result["reason"] == "behind"
    assert result["latest"]["commit_short"] == "f2b2e22"
    assert result["download_url"].endswith("/releases/tag/nightly")


def test_running_the_published_nightly_is_up_to_date() -> None:
    # The same commit, so there is nothing to compare and nothing to do.
    result = run(current=build(commit=NIGHTLY["target_commitish"]))
    assert result["update_available"] is False
    assert result["reason"] == "current"


def test_short_commit_still_matches_the_published_one() -> None:
    # A stamp abbreviated to seven characters is the same build.
    result = run(current=build(commit="f2b2e22", commit_short="f2b2e22"))
    assert result["update_available"] is False


def test_a_checkout_ahead_of_the_nightly_is_not_behind_it() -> None:
    # Local work is newer than what was published; telling this user to
    # update would be wrong, which is why the commits are compared and
    # not merely diffed.
    result = run(compare="behind")
    assert result["update_available"] is False
    assert result["reason"] == "current"


def test_unrelated_commit_is_reported_as_different() -> None:
    # GitHub cannot place a commit it has never seen, and running
    # something other than the published build is still worth saying.
    result = run(compare=None)
    assert result["update_available"] is True
    assert result["reason"] == "different"


def test_a_modified_tree_is_never_told_to_update() -> None:
    # The commit does not describe what is running, so no published
    # build can contain it.
    result = run(current=build(dirty=True))
    assert result["update_available"] is False
    assert result["reason"] == "different"


def test_a_build_with_no_commit_cannot_be_compared() -> None:
    result = run(current=build(commit=None, commit_short=None))
    assert result["update_available"] is False
    assert result["reason"] == "unknown"


def test_release_channel_compares_versions() -> None:
    result = run(channel="stable")
    assert result["channel"] == "stable"
    assert result["update_available"] is True
    assert result["latest"]["version"] == "0.2.0"


def test_release_channel_is_current_when_the_tag_is_not_newer() -> None:
    result = run(channel="stable", current=build(version="0.2.0"))
    assert result["update_available"] is False
    assert result["reason"] == "current"


def test_a_tagged_build_defaults_to_the_release_channel() -> None:
    # A download of v0.1.0 should not be compared against the nightly it
    # is already older than by design.
    result = run(current=build(release="v0.1.0"))
    assert result["channel"] == "stable"


def test_a_development_build_follows_the_nightlies() -> None:
    assert updates.default_channel(build(release=None, source="development")) == "nightly"


def test_both_channels_come_back_from_one_call() -> None:
    # The Settings screen shows both, and GitHub's rate limit is small.
    result = run()
    assert result["releases"]["stable"]["tag"] == "v0.2.0"
    assert result["releases"]["nightly"]["tag"] == "nightly"


def test_drafts_are_not_releases() -> None:
    fetched = mock.AsyncMock(
        return_value=[{"tag_name": "v9.9.9", "draft": True, "prerelease": False}]
    )
    with mock.patch.object(updates, "_get_json", fetched):
        assert asyncio.run(updates._fetch_releases()) == []


def test_the_commit_is_read_from_the_name_when_the_target_is_a_branch() -> None:
    # A release made by hand carries a branch name in target_commitish.
    commit = updates._release_commit({**NIGHTLY, "target_commitish": "main"})
    assert commit == "f2b2e22"


def test_a_rebuilt_nightly_is_not_reported_as_ten_days_old() -> None:
    """One rolling release keeps the date it was first created, so the
    files it holds are what says when this build was made."""
    entry = updates._entry(
        {
            **NIGHTLY,
            "assets": [
                {"updated_at": "2026-09-18T07:26:55Z"},
                {"updated_at": "2026-09-28T10:09:00Z"},
            ],
        },
        "nightly",
    )
    assert entry["published_at"] == "2026-09-28T10:09:00Z"


def test_a_release_with_no_files_still_has_a_date() -> None:
    entry = updates._entry(STABLE, "stable")
    assert entry["published_at"] == STABLE["published_at"]


def test_the_answer_is_cached_between_checks() -> None:
    # Sixty unauthenticated calls an hour is not much to spend on a
    # question whose answer cannot change between two builds.
    fetch = mock.AsyncMock(return_value=[NIGHTLY, STABLE])
    with mock.patch.object(updates, "_fetch_releases", fetch), mock.patch.object(
        updates, "_compare", mock.AsyncMock(return_value="ahead")
    ), mock.patch.object(updates, "build_info", build):
        asyncio.run(updates.check())
        asyncio.run(updates.check())
        assert fetch.await_count == 1
        asyncio.run(updates.check(refresh=True))
        assert fetch.await_count == 2


def test_an_unknown_channel_is_refused() -> None:
    with pytest.raises(ValueError):
        asyncio.run(updates.check(channel="beta"))


def test_offline_is_reported_as_itself() -> None:
    with mock.patch.object(
        updates,
        "_fetch_releases",
        mock.AsyncMock(side_effect=updates.UpdateError("could not reach GitHub")),
    ), mock.patch.object(updates, "build_info", build):
        with pytest.raises(updates.UpdateError):
            asyncio.run(updates.check())
