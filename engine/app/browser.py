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
    ("Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ("Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ("Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    ("Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
]

_WINDOWS_CANDIDATES = [
    ("Google Chrome", r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    (
        "Google Chrome",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ),
    ("Microsoft Edge", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    ("Microsoft Edge", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
]

_LINUX_COMMANDS = [
    ("Google Chrome", "google-chrome"),
    ("Google Chrome", "google-chrome-stable"),
    ("Chromium", "chromium"),
    ("Chromium", "chromium-browser"),
    ("Microsoft Edge", "microsoft-edge"),
    ("Brave", "brave-browser"),
]


class BrowserError(RuntimeError):
    """The browser could not be found or started."""


@dataclass(slots=True)
class Browser:
    name: str
    path: str


def find_browser() -> Browser | None:
    """The best Chromium-based browser on this machine, if any."""
    system = platform.system()
    if system == "Darwin":
        candidates = _MACOS_CANDIDATES
    elif system == "Windows":
        candidates = _WINDOWS_CANDIDATES
    else:
        found = [
            (name, path)
            for name, command in _LINUX_COMMANDS
            if (path := shutil.which(command))
        ]
        return Browser(*found[0]) if found else None

    for name, path in candidates:
        if Path(path).exists():
            return Browser(name, path)
    return None


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


def profile_dir(data_dir: Path) -> Path:
    """Where the throwaway browser profile lives.

    Kept rather than recreated per launch, so logins and cookies survive
    between sessions the way they would in a real browser.
    """
    return Path(data_dir) / "browser-profile"


# The proxy a profile's browser was started with. Chromium hands a second
# launch on the same profile to the running process and drops its flags, so
# this is the only record of which proxy the open windows actually use.
_PROXY_MARKER = "lanius-proxy"


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


def running_proxy(data_dir: Path) -> str | None:
    """The proxy the open Lanius browser uses, or None if none is open."""
    profile = profile_dir(data_dir)
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
) -> dict[str, object]:
    """Open the browser against this proxy. Returns what was started."""
    browser = find_browser()
    if browser is None:
        raise BrowserError(
            "no Chromium-based browser found. Install Chrome, Chromium, "
            "Edge or Brave, or point your own browser at the proxy."
        )

    profile = profile_dir(data_dir)
    profile.mkdir(parents=True, exist_ok=True)

    # A loopback proxy must still be used for loopback addresses, or the
    # browser bypasses it exactly when testing a local application.
    proxy = f"http://{proxy_host}:{proxy_port}"

    # A second launch only opens a window in the running browser, which
    # keeps its old proxy. After the listener moves, that window would
    # quietly send traffic to whatever now holds the old port.
    current = running_proxy(data_dir)
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


def state(data_dir: Path, confdir: Path) -> dict[str, object]:
    """What the UI needs to describe the feature before it is used."""
    browser = find_browser()
    return {
        "available": browser is not None,
        "name": browser.name if browser else None,
        "profile": str(profile_dir(data_dir)),
        "ca_trusted": ca_spki_hash(confdir) is not None,
    }


def clear_profile(data_dir: Path) -> bool:
    """Throw away the browser profile: cookies, logins, history."""
    profile = profile_dir(data_dir)
    if not profile.exists():
        return False
    # Only ever the directory we created, never a path from a caller.
    if profile.name != "browser-profile":  # pragma: no cover - defensive
        raise BrowserError("refusing to remove an unexpected profile path")
    shutil.rmtree(profile)
    return True


__all__ = [
    "Browser",
    "BrowserError",
    "ca_spki_hash",
    "clear_profile",
    "find_browser",
    "launch",
    "profile_dir",
    "running_proxy",
    "state",
]
