"""Launching a browser that is already pointed at the proxy.

The launch itself is checked by inspecting the arguments rather than by
opening a window, because the flags are the whole feature: the wrong
proxy flag silently sends traffic around Lanius, and the wrong
certificate flag disables verification everywhere instead of excusing
one certificate.
"""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

from app import browser


def _write_ca(confdir: Path) -> None:
    """A real self-signed certificate, so the SPKI hash is genuine."""
    confdir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(confdir / "key.pem"),
            "-out",
            str(confdir / "mitmproxy-ca-cert.pem"),
            "-days",
            "1",
            "-nodes",
            "-subj",
            "/CN=lanius-test",
        ],
        capture_output=True,
        check=True,
        timeout=60,
    )


def test_spki_hash_matches_the_certificate(tmp_path) -> None:
    """Chromium compares this against the key it is offered, so a wrong
    value means every HTTPS page warns."""
    confdir = tmp_path / "mitm"
    _write_ca(confdir)

    digest = browser.ca_spki_hash(confdir)
    assert digest is not None

    # Recompute independently from the same certificate.
    public_key = subprocess.run(
        ["openssl", "x509", "-in", str(confdir / "mitmproxy-ca-cert.pem"),
         "-pubkey", "-noout"],
        capture_output=True, check=True, timeout=30,
    ).stdout
    der = subprocess.run(
        ["openssl", "pkey", "-pubin", "-outform", "der"],
        input=public_key, capture_output=True, check=True, timeout=30,
    ).stdout
    assert digest == base64.b64encode(hashlib.sha256(der).digest()).decode()


def test_no_certificate_means_no_hash(tmp_path) -> None:
    """Better to report it than to launch a browser trusting everything."""
    assert browser.ca_spki_hash(tmp_path / "missing") is None


def test_browser_ca_trust_does_not_require_an_openssl_executable(tmp_path) -> None:
    _write_ca(tmp_path)
    expected = browser.ca_spki_hash(tmp_path)
    with mock.patch.object(browser.subprocess, "run", side_effect=FileNotFoundError) as run:
        assert browser.ca_spki_hash(tmp_path) == expected
        run.assert_not_called()


def test_unreadable_certificate_is_not_trusted(tmp_path) -> None:
    (tmp_path / "mitmproxy-ca-cert.pem").write_text("invalid certificate")
    assert browser.ca_spki_hash(tmp_path) is None


def test_launch_points_the_browser_at_the_proxy(tmp_path) -> None:
    confdir = tmp_path / "mitm"
    _write_ca(confdir)
    found = browser.Browser("Google Chrome", "/fake/chrome")

    with mock.patch.object(browser, "find_browser", return_value=found):
        with mock.patch.object(browser, "_spawn") as popen:
            popen.return_value = 4242
            # The hash is computed before Popen is needed, so take it now.
            expected_spki = browser.ca_spki_hash(confdir)
            result = browser.launch(
                proxy_host="127.0.0.1",
                proxy_port=8080,
                data_dir=tmp_path,
                confdir=confdir,
                url="https://example.com/",
            )

    args = popen.call_args[0][0]
    assert args[0] == "/fake/chrome"
    assert "--proxy-server=http://127.0.0.1:8080" in args

    # Without this Chromium bypasses the proxy for localhost, which is
    # exactly where a local application under test lives.
    assert "--proxy-bypass-list=<-loopback>" in args

    # Our certificate is excused by hash. Blanket flags would turn off
    # verification for every site, hiding the errors this tool exists to
    # surface.
    spki = [a for a in args if a.startswith("--ignore-certificate-errors-spki-list=")]
    assert len(spki) == 1
    assert spki[0].endswith(expected_spki or "")
    assert "--ignore-certificate-errors" not in args
    assert not any(a.startswith("--ignore-urlfetcher-cert-requests") for a in args)

    # A profile of our own, so the user's browser, history and logins are
    # untouched.
    profile = [a for a in args if a.startswith("--user-data-dir=")][0]
    assert profile.endswith("browser-profile")
    assert str(tmp_path) in profile

    assert args[-1] == "https://example.com/"
    assert result["pid"] == 4242
    assert result["ca_trusted"] is True
    assert result["proxy"] == "http://127.0.0.1:8080"


def test_launch_follows_the_listener(tmp_path) -> None:
    """The listener is movable, so a hardcoded 8080 would send the browser
    somewhere nothing is listening."""
    confdir = tmp_path / "mitm"
    _write_ca(confdir)
    found = browser.Browser("Chromium", "/fake/chromium")

    with mock.patch.object(browser, "find_browser", return_value=found):
        with mock.patch.object(browser, "_spawn") as popen:
            popen.return_value = 1
            browser.launch(
                proxy_host="0.0.0.0",  # noqa: S104 - the case under test
                proxy_port=9443,
                data_dir=tmp_path,
                confdir=confdir,
            )

    args = popen.call_args[0][0]
    assert "--proxy-server=http://0.0.0.0:9443" in args


def test_launch_without_a_certificate_says_so(tmp_path) -> None:
    """HTTPS will warn. That must be reported, not hidden by turning
    verification off."""
    found = browser.Browser("Google Chrome", "/fake/chrome")
    with mock.patch.object(browser, "find_browser", return_value=found):
        with mock.patch.object(browser, "_spawn") as popen:
            popen.return_value = 7
            result = browser.launch(
                proxy_host="127.0.0.1",
                proxy_port=8080,
                data_dir=tmp_path,
                confdir=tmp_path / "missing",
            )

    args = popen.call_args[0][0]
    assert not any(a.startswith("--ignore-certificate-errors") for a in args)
    assert result["ca_trusted"] is False


def test_missing_browser_is_reported_not_guessed(tmp_path) -> None:
    with mock.patch.object(browser, "find_browser", return_value=None):
        with pytest.raises(browser.BrowserError) as excinfo:
            browser.launch(
                proxy_host="127.0.0.1",
                proxy_port=8080,
                data_dir=tmp_path,
                confdir=tmp_path,
            )
    # The message has to tell the user what to do about it.
    assert "Chrome" in str(excinfo.value)


def test_clearing_the_profile_removes_it(tmp_path) -> None:
    profile = browser.profile_dir(tmp_path)
    profile.mkdir(parents=True)
    (profile / "Cookies").write_text("session")

    assert browser.clear_profile(tmp_path) is True
    assert not profile.exists()
    # Clearing twice is not an error.
    assert browser.clear_profile(tmp_path) is False


def test_state_describes_the_feature_before_use(tmp_path) -> None:
    confdir = tmp_path / "mitm"
    _write_ca(confdir)
    found = browser.Browser("Microsoft Edge", "/fake/edge")

    with mock.patch.object(browser, "find_browser", return_value=found):
        state = browser.state(tmp_path, confdir)
    assert state["available"] is True
    assert state["name"] == "Microsoft Edge"
    assert state["ca_trusted"] is True

    with mock.patch.object(browser, "find_browser", return_value=None):
        assert browser.state(tmp_path, confdir)["available"] is False


def _hold_profile(data_dir: Path, proxy: str) -> None:
    """Leave the profile as a running browser launched for ``proxy`` does."""
    profile = browser.profile_dir(data_dir)
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "SingletonLock").symlink_to(f"{socket.gethostname()}-{os.getpid()}")
    (profile / "lanius-proxy").write_text(proxy, encoding="utf-8")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX profile lock")
def test_open_browser_on_an_old_listener_is_refused(tmp_path) -> None:
    """Chromium hands a second launch to the running browser and drops its
    flags, so after the listener moves the new window would still use the
    old port, where another proxy may be capturing it."""
    _hold_profile(tmp_path, "http://127.0.0.1:8080")
    found = browser.Browser("Google Chrome", "/fake/chrome")

    with mock.patch.object(browser, "find_browser", return_value=found):
        with mock.patch.object(browser, "_spawn") as popen:
            with pytest.raises(browser.BrowserError) as excinfo:
                browser.launch(
                    proxy_host="127.0.0.1",
                    proxy_port=8083,
                    data_dir=tmp_path,
                    confdir=tmp_path / "missing",
                )

    popen.assert_not_called()
    assert "http://127.0.0.1:8080" in str(excinfo.value)
    assert "http://127.0.0.1:8083" in str(excinfo.value)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX profile lock")
def test_open_browser_on_the_same_listener_opens_a_window(tmp_path) -> None:
    _hold_profile(tmp_path, "http://127.0.0.1:8080")
    found = browser.Browser("Google Chrome", "/fake/chrome")

    with mock.patch.object(browser, "find_browser", return_value=found):
        with mock.patch.object(browser, "_spawn", return_value=5) as popen:
            browser.launch(
                proxy_host="127.0.0.1",
                proxy_port=8080,
                data_dir=tmp_path,
                confdir=tmp_path / "missing",
            )

    popen.assert_called_once()


def test_launch_records_the_proxy_and_a_stale_lock_is_ignored(tmp_path) -> None:
    """A lock left by a crashed browser must not block the next launch."""
    profile = browser.profile_dir(tmp_path)
    profile.mkdir(parents=True)
    if sys.platform != "win32":
        (profile / "SingletonLock").symlink_to("some-other-host-1")
    (profile / "lanius-proxy").write_text("http://127.0.0.1:8080", encoding="utf-8")
    found = browser.Browser("Google Chrome", "/fake/chrome")

    with mock.patch.object(browser, "find_browser", return_value=found):
        with mock.patch.object(browser, "_spawn", return_value=5):
            browser.launch(
                proxy_host="127.0.0.1",
                proxy_port=8083,
                data_dir=tmp_path,
                confdir=tmp_path / "missing",
            )

    assert (profile / "lanius-proxy").read_text(encoding="utf-8") == "http://127.0.0.1:8083"
    assert browser.running_proxy(tmp_path) is None
