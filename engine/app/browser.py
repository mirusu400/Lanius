"""Launch a Chromium browser already pointed at the proxy.

Testing a site normally starts with two chores: change the system or
browser proxy settings, and install the CA certificate. Both touch the
machine, and the proxy setting is easy to leave switched on afterwards.
This opens a browser configured for this proxy alone, in a throwaway
profile, so the user's own browser and its history are untouched.

The CA is handled with ``--ignore-certificate-errors-spki-list``, which
excuses exactly our certificate rather than disabling verification: a
real certificate error on some other site still stops the page, which
matters when the point of the tool is to notice such things.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import platform
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization

logger = logging.getLogger(__name__)

# Chromium builds we know how to drive, most preferred first. Firefox is
# absent deliberately: it keeps its own certificate store, so the SPKI
# trick does not apply and it would need the CA installed properly.
_MACOS_CANDIDATES = [
    (
        "chrome", "Google Chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
    (
        "chrome-beta", "Google Chrome Beta",
        "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    ),
    ("chromium", "Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
    (
        "edge", "Microsoft Edge",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ),
    ("brave", "Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
]

_WINDOWS_CANDIDATES = [
    (
        "chrome", "Google Chrome",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ),
    (
        "chrome",
        "Google Chrome",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ),
    (
        "edge", "Microsoft Edge",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ),
    (
        "edge", "Microsoft Edge",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ),
]

_LINUX_COMMANDS = [
    ("chrome", "Google Chrome", "google-chrome"),
    ("chrome", "Google Chrome", "google-chrome-stable"),
    ("chromium", "Chromium", "chromium"),
    ("chromium", "Chromium", "chromium-browser"),
    ("edge", "Microsoft Edge", "microsoft-edge"),
    ("brave", "Brave", "brave-browser"),
]


class BrowserError(RuntimeError):
    """The browser could not be found or started."""


@dataclass(slots=True)
class Browser:
    name: str
    path: str


@dataclass(slots=True)
class BrowserChoice:
    id: str
    name: str
    path: str | None


def browser_choices() -> list[BrowserChoice]:
    """Known browsers in preference order, including ones not yet installed."""
    system = platform.system()
    if system == "Darwin":
        candidates = _MACOS_CANDIDATES
    elif system == "Windows":
        candidates = _WINDOWS_CANDIDATES
    else:
        candidates = _LINUX_COMMANDS
    choices: dict[str, BrowserChoice] = {}
    for browser_id, name, candidate in candidates:
        if system in ("Darwin", "Windows"):
            path = candidate if Path(candidate).is_file() else None
        else:
            path = shutil.which(candidate)
        if browser_id not in choices:
            choices[browser_id] = BrowserChoice(browser_id, name, path)
        elif path and choices[browser_id].path is None:
            choices[browser_id].path = path
    return list(choices.values())


def find_browser() -> Browser | None:
    """The best Chromium-based browser on this machine, if any."""
    for choice in browser_choices():
        if choice.path:
            return Browser(choice.name, choice.path)
    return None


def browser_by_id(browser_id: str) -> Browser:
    """Resolve an ID from our allowlist, never an executable path from a client."""
    for choice in browser_choices():
        if choice.id == browser_id:
            if choice.path:
                return Browser(choice.name, choice.path)
            raise BrowserError(f"{choice.name} is not installed")
    raise BrowserError(f"unknown browser: {browser_id}")


def ca_spki_hash(confdir: Path) -> str | None:
    """Base64 SHA-256 of the CA's public key, as Chromium wants it.

    Returns None when the certificate is missing or unreadable,
    in which case the caller has to decide what to do rather
    than silently launching a browser that trusts everything.
    """
    pem = Path(confdir) / "mitmproxy-ca-cert.pem"
    if not pem.exists():
        return None
    try:
        # cryptography is bundled with the engine. Windows does not normally
        # provide an openssl executable, so invoking it gave a false negative.
        cert = x509.load_pem_x509_certificate(pem.read_bytes())
        der = cert.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    except (OSError, ValueError) as exc:
        logger.warning("could not read the CA public key: %s", exc)
        return None
    return base64.b64encode(hashlib.sha256(der).digest()).decode()


def profile_dir(data_dir: Path, custom: Path | str | None = None) -> Path:
    """Where the browser profile lives.

    Kept rather than recreated per launch, so logins and cookies survive
    between sessions the way they would in a real browser. A user may
    choose their own directory instead, to keep several sets of browsing
    data and switch between them.
    """
    if custom:
        return Path(custom).expanduser()
    return Path(data_dir) / "browser-profile"


def browser_profile_dir(
    data_dir: Path, custom: Path | str | None, browser_id: str | None
) -> Path:
    """Keep each browser's profile separate so Chromium cannot steal its launch."""
    base = profile_dir(data_dir, custom)
    # The original profile path belongs to the old default launch. Keep it
    # for Chrome so existing macOS/Windows users retain their browser data.
    if browser_id is None or browser_id == "chrome":
        return base
    return base.with_name(f"{base.name}-{browser_id}")


# The proxy a profile's browser was started with. Chromium hands a second
# launch on the same profile to the running process and drops its flags, so
# this is the only record of which proxy the open windows actually use.
_PROXY_MARKER = "lanius-proxy"

# Left in every profile Lanius has launched. Clearing a directory the user
# chose deletes it, so it must be one Lanius has really used as a profile.
_OWNER_MARKER = "lanius-profile"


def check_profile_dir(path: Path | str, data_dir: Path) -> Path:
    """Validate a directory the user wants as the browser profile.

    The directory is handed to Chromium and may later be deleted by
    "clear browsing data", so an existing folder full of unrelated files
    is refused rather than adopted.
    """
    raw = str(path).strip()
    if not raw:
        raise BrowserError("the profile directory is empty")
    profile = Path(raw).expanduser()
    if not profile.is_absolute():
        raise BrowserError("the profile directory must be an absolute path")
    resolved = profile.resolve()
    if (
        resolved == Path.home().resolve()
        or resolved == Path(resolved.anchor)
        or Path(data_dir).resolve().is_relative_to(resolved)
    ):
        raise BrowserError(f"{profile} cannot be used as a browser profile")
    if profile.exists():
        if not profile.is_dir():
            raise BrowserError(f"{profile} is not a directory")
        if not _looks_like_profile(profile):
            raise BrowserError(
                f"{profile} already contains other files. Choose an empty "
                "folder or an existing browser profile."
            )
    return profile


def _looks_like_profile(profile: Path) -> bool:
    """Empty, or already a Chromium profile."""
    try:
        if not any(profile.iterdir()):
            return True
    except OSError:
        return False
    return (profile / _OWNER_MARKER).exists() or (profile / "Local State").exists()


def _running_pid(profile: Path) -> int | None:
    """The pid of a live browser holding this profile, if one is known.

    POSIX Chromium leaves ``SingletonLock`` as a symlink to
    ``<hostname>-<pid>``. Windows keeps an opaque lock file instead, so
    there a running browser goes undetected.
    """
    try:
        target = os.readlink(profile / "SingletonLock")
    except OSError:
        return None
    host, _, pid_text = target.rpartition("-")
    if host != socket.gethostname() or not pid_text.isdigit():
        return None
    pid = int(pid_text)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return pid


def running_proxy(data_dir: Path, custom: Path | str | None = None) -> str | None:
    """The proxy the open Lanius browser uses, or None if none is open."""
    profile = profile_dir(data_dir, custom)
    if _running_pid(profile) is None:
        return None
    try:
        return (profile / _PROXY_MARKER).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def launch(
    *,
    proxy_host: str,
    proxy_port: int,
    data_dir: Path,
    confdir: Path,
    url: str | None = None,
    custom_profile: Path | str | None = None,
    browser_id: str | None = None,
) -> dict[str, object]:
    """Open the browser against this proxy. Returns what was started."""
    browser = find_browser() if browser_id is None else browser_by_id(browser_id)
    if browser is None:
        raise BrowserError(
            "no Chromium-based browser found. Install Chrome, Chromium, "
            "Edge or Brave, or point your own browser at the proxy."
        )

    if custom_profile:
        # Checked again here: the folder may have changed since it was chosen.
        check_profile_dir(custom_profile, data_dir)
        profile = browser_profile_dir(data_dir, custom_profile, browser_id)
    else:
        profile = browser_profile_dir(data_dir, None, browser_id)
    if browser_id not in (None, "chrome") and profile.exists():
        # A derived sibling may already be an unrelated user directory.
        # Only a folder Lanius previously created may be reused.
        if not profile.is_dir() or (
            any(profile.iterdir()) and not (profile / _OWNER_MARKER).exists()
        ):
            raise BrowserError(f"{profile} was not created by Lanius")
    profile.mkdir(parents=True, exist_ok=True)

    # A loopback proxy must still be used for loopback addresses, or the
    # browser bypasses it exactly when testing a local application.
    proxy = f"http://{proxy_host}:{proxy_port}"

    # A second launch only opens a window in the running browser, which
    # keeps its old proxy. After the listener moves, that window would
    # quietly send traffic to whatever now holds the old port.
    current = running_proxy(data_dir, profile)
    if current is not None and current != proxy:
        raise BrowserError(
            f"the Lanius browser is still open with proxy {current}. "
            f"Close it, then open it again to use {proxy}."
        )
    args = [
        browser.path,
        f"--user-data-dir={profile}",
        f"--proxy-server={proxy}",
        "--proxy-bypass-list=<-loopback>",
        "--no-first-run",
        "--no-default-browser-check",
    ]

    spki = ca_spki_hash(confdir)
    if spki:
        # Only our certificate is excused; a genuine error elsewhere still
        # stops the page.
        args.append(f"--ignore-certificate-errors-spki-list={spki}")
    else:
        logger.warning(
            "CA certificate unavailable, so HTTPS pages will warn until it "
            "is installed"
        )

    args.append(url or "about:blank")

    try:
        pid = _spawn(args)
    except OSError as exc:
        raise BrowserError(f"could not start {browser.name}: {exc}") from exc
    if current is None:
        try:
            (profile / _PROXY_MARKER).write_text(proxy, encoding="utf-8")
            (profile / _OWNER_MARKER).touch()
        except OSError as exc:
            logger.warning("could not record the browser proxy: %s", exc)

    return {
        "name": browser.name,
        "path": browser.path,
        "pid": pid,
        "profile": str(profile),
        "proxy": proxy,
        # Whether HTTPS will work without the user installing anything.
        "ca_trusted": bool(spki),
    }


def _spawn(args: list[str]) -> int:
    """Start the browser detached, and return its pid.

    Detached because the browser outlives the request that started it, and
    closing Lanius should not take away a window the user is still using.
    """
    if sys.platform == "win32":  # pragma: no cover - platform specific
        process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    else:
        process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    return process.pid


def state(
    data_dir: Path, confdir: Path, custom: Path | str | None = None
) -> dict[str, object]:
    """What the UI needs to describe the feature before it is used."""
    browser = find_browser()
    return {
        "available": browser is not None,
        "name": browser.name if browser else None,
        "browsers": [
            {"id": choice.id, "name": choice.name, "available": choice.path is not None}
            for choice in browser_choices()
        ],
        "profile": str(profile_dir(data_dir, custom)),
        "default_profile": str(profile_dir(data_dir)),
        "custom_profile": bool(custom),
        "ca_trusted": ca_spki_hash(confdir) is not None,
    }


def clear_profile(data_dir: Path, custom: Path | str | None = None) -> bool:
    """Throw away every Lanius-owned browser profile for this directory."""
    base = profile_dir(data_dir, custom)
    profiles = [base]
    browser_ids = {
        browser_id
        for candidates in (_MACOS_CANDIDATES, _WINDOWS_CANDIDATES, _LINUX_COMMANDS)
        for browser_id, _, _ in candidates
        if browser_id != "chrome"
    }
    profiles.extend(
        browser_profile_dir(data_dir, custom, browser_id)
        for browser_id in sorted(browser_ids)
    )
    removable: list[Path] = []
    for profile in profiles:
        if not profile.exists():
            continue
        if custom and profile == base and not (profile / _OWNER_MARKER).exists():
            # A user-selected browser profile is not Lanius-owned.
            continue
        if profile != base and not (profile / _OWNER_MARKER).exists():
            continue
        if _running_pid(profile) is not None:
            raise BrowserError("close the Lanius browser before clearing its data")
        if profile == base:
            if not custom and profile.name != "browser-profile":
                raise BrowserError("refusing to remove an unexpected profile path")
        removable.append(profile)
    if custom and base.exists() and not (base / _OWNER_MARKER).exists() and not removable:
        raise BrowserError(f"{base} was not created by Lanius, so it is left alone")
    for profile in removable:
        shutil.rmtree(profile)
    return bool(removable)


__all__ = [
    "Browser",
    "BrowserChoice",
    "BrowserError",
    "browser_by_id",
    "browser_choices",
    "browser_profile_dir",
    "ca_spki_hash",
    "check_profile_dir",
    "clear_profile",
    "find_browser",
    "launch",
    "profile_dir",
    "running_proxy",
    "state",
]
