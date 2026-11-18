"""Import a chosen browser profile's cookies into a Lanius-owned browser.

Cookie values and OS secrets never enter an API response or a log. Chromium
destinations are written through the browser's own cookie API so their values
are encrypted by that browser, including on Windows.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import io
import json
import math
import os
import platform
import sqlite3
import subprocess
import sys
import time
import zipfile
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

import psutil
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.padding import PKCS7
from websockets.exceptions import WebSocketException
from websockets.sync.client import ClientConnection, connect

from . import browser

_CHROMIUM_IDS = ("chrome", "chrome-beta", "chromium")
_BROWSER_IDS = (*_CHROMIUM_IDS, "firefox")
_CHROME_EPOCH_US = 11_644_473_600_000_000
_SESSION_COOKIE_MS = 8 * 60 * 60 * 1000
_FIREFOX_SCHEMA_VERSIONS = (15, 16, 17)
_FIREFOX_COLUMNS = {
    "originAttributes", "name", "value", "host", "path", "expiry",
    "lastAccessed", "creationTime", "isSecure", "isHttpOnly", "sameSite",
    "schemeMap", "isPartitionedAttributeSet",
}
_CHROMIUM_COLUMNS = {
    "host_key", "top_frame_site_key", "name", "value", "encrypted_value",
    "path", "expires_utc", "is_secure", "is_httponly", "is_persistent",
    "samesite", "source_scheme",
}


class CookieImportError(RuntimeError):
    """A source, decryption, or destination check refused the import."""


class _ProtectedCookie(ValueError):
    """The browser's application-bound encryption cannot be read externally."""


@dataclass(frozen=True, slots=True)
class CookieProfile:
    id: str
    name: str
    browser_id: str
    cookie_count: int
    database: Path
    root: Path


@dataclass(frozen=True, slots=True)
class _Cookie:
    name: str
    value: str
    host: str
    path: str
    expiry: int  # Unix milliseconds
    secure: int
    http_only: int
    same_site: int  # Firefox's 0/1/2/256 representation
    source_scheme: int  # Chromium's 0/1/2 representation
    source_port: int


def _source_roots(system: str | None = None) -> dict[str, Path | tuple[Path, ...]]:
    system = system or platform.system()
    home = Path.home()
    if system == "Darwin":
        support = home / "Library/Application Support"
        return {
            "chrome": support / "Google/Chrome",
            "chrome-beta": support / "Google/Chrome Beta",
            "chromium": support / "Chromium",
            "firefox": support / "Firefox/Profiles",
        }
    if system == "Windows":
        local = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData/Local")))
        roaming = Path(os.environ.get("APPDATA", str(home / "AppData/Roaming")))
        return {
            "chrome": local / "Google/Chrome/User Data",
            "chrome-beta": local / "Google/Chrome Beta/User Data",
            "chromium": local / "Chromium/User Data",
            "firefox": roaming / "Mozilla/Firefox/Profiles",
        }
    config = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
    return {
        "chrome": config / "google-chrome",
        "chrome-beta": config / "google-chrome-beta",
        "chromium": (config / "chromium", home / "snap/chromium/common/chromium"),
        "firefox": (
            home / ".mozilla/firefox", config / "mozilla/firefox",
            home / "snap/firefox/common/.mozilla/firefox",
        ),
    }


def exporter_archive() -> bytes:
    """Package the bundled, network-free extension for user installation."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        root = Path(sys._MEIPASS) / "browser-cookie-exporter"  # type: ignore[attr-defined]
    else:
        root = Path(__file__).resolve().parents[1] / "browser_cookie_exporter"
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ("manifest.json", "popup.html", "popup.js"):
            archive.write(root / name, name)
    return output.getvalue()


def _chromium_database(profile: Path) -> Path | None:
    for candidate in (profile / "Network/Cookies", profile / "Cookies"):
        if candidate.is_file():
            return candidate
    return None


def _profile_names(root: Path) -> dict[str, object]:
    try:
        state = json.loads((root / "Local State").read_text(encoding="utf-8"))
        names = state.get("profile", {}).get("info_cache", {})
        return names if isinstance(names, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def source_profiles(
    roots: dict[str, Path | tuple[Path, ...]] | None = None,
) -> list[CookieProfile]:
    """Enumerate only standard browser profile directories, never API paths."""
    roots = roots or _source_roots()
    names = {choice.id: choice.name for choice in browser.browser_choices()}
    names.update({"chrome": "Google Chrome", "chrome-beta": "Google Chrome Beta",
                  "chromium": "Chromium", "firefox": "Firefox"})
    found: list[CookieProfile] = []
    for browser_id in _BROWSER_IDS:
        configured = roots.get(browser_id)
        candidates = configured if isinstance(configured, tuple) else (configured,)
        for root_index, root in enumerate(candidates):
            if root is None or not root.is_dir():
                continue
            info_cache = _profile_names(root) if browser_id in _CHROMIUM_IDS else {}
            for directory in sorted(root.iterdir()):
                if directory.is_symlink() or not directory.is_dir():
                    continue
                if browser_id in _CHROMIUM_IDS:
                    if directory.name != "Default" and not (
                        directory.name.startswith("Profile ")
                        and directory.name.removeprefix("Profile ").isdigit()
                    ):
                        continue
                    database = _chromium_database(directory)
                    info = info_cache.get(directory.name)
                    display = info.get("name") if isinstance(info, dict) else None
                else:
                    database = directory / "cookies.sqlite"
                    display = directory.name
                if database is None or not database.is_file():
                    continue
                try:
                    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
                        table = "cookies" if browser_id in _CHROMIUM_IDS else "moz_cookies"
                        count = int(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
                except (OSError, sqlite3.Error):
                    continue
                label = display if isinstance(display, str) and display else directory.name
                profile_id = f"{browser_id}{f'@{root_index}' if root_index else ''}:{directory.name}"
                found.append(CookieProfile(
                    profile_id, f"{names[browser_id]} — {label}",
                    browser_id, count, database, root,
                ))
    return found


def _target_profile(data_dir: Path, custom: Path | str | None, browser_id: str) -> Path:
    return browser.browser_profile_dir(data_dir, custom, browser_id)


def _target_database(profile: Path, browser_id: str) -> Path | None:
    if browser_id == "firefox":
        candidate = profile / "cookies.sqlite"
        return candidate if candidate.is_file() else None
    return _chromium_database(profile / "Default")


def _uses_profile(args: list[str], expected: str) -> bool:
    for index, arg in enumerate(args):
        value = arg.partition("=")[2] if arg.startswith("--user-data-dir=") else (
            args[index + 1] if arg == "--user-data-dir" and index + 1 < len(args) else ""
        )
        if value and str(Path(value).expanduser().resolve()).casefold() == expected:
            return True
    return False


def _chromium_running(profile: Path) -> bool:
    expected = str(profile.resolve()).casefold()
    # A lock left by a crashed browser can name a pid the OS has since given
    # to an unrelated process, so trust it only when that process uses the
    # profile, or when its command line cannot be read.
    pid = browser._running_pid(profile)
    if pid is not None:
        try:
            if _uses_profile(psutil.Process(pid).cmdline(), expected):
                return True
        except psutil.NoSuchProcess:
            pass
        except (psutil.Error, OSError):
            return True
    for process in psutil.process_iter(["cmdline"]):
        try:
            if _uses_profile(process.info.get("cmdline") or [], expected):
                return True
        except (psutil.Error, OSError):
            continue
    return False


def _target_open(profile: Path, browser_id: str) -> bool:
    return browser._firefox_running(profile) if browser_id == "firefox" else _chromium_running(profile)


def _target_ready(profile: Path, browser_id: str) -> bool:
    return (profile / "lanius-profile").is_file() and (
        browser_id != "firefox" or _target_database(profile, browser_id) is not None
    )


def state(data_dir: Path, custom_profile: Path | str | None = None) -> dict[str, object]:
    choices = {choice.id: choice for choice in browser.browser_choices()}
    return {
        "profiles": [
            {"id": item.id, "name": item.name, "browser_id": item.browser_id,
             "cookie_count": item.cookie_count}
            for item in source_profiles()
        ],
        "targets": [
            {
                "id": browser_id,
                "name": choices[browser_id].name,
                "available": choices[browser_id].path is not None,
                "ready": _target_ready(profile, browser_id),
                "open": _target_open(profile, browser_id),
            }
            for browser_id in _BROWSER_IDS
            if browser_id in choices
            for profile in [_target_profile(data_dir, custom_profile, browser_id)]
        ],
    }


def _derive_key(password: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", iterations, dklen=16)


def _mac_key(browser_id: str) -> bytes:
    account = "Chromium" if browser_id == "chromium" else "Chrome"
    try:
        completed = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", f"{account} Safe Storage",
             "-a", account, "-w"], capture_output=True, timeout=90, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CookieImportError("macOS Keychain access failed or timed out") from exc
    if completed.returncode != 0 or not completed.stdout.strip():
        raise CookieImportError("macOS Keychain access was denied or its browser key was not found")
    return _derive_key(completed.stdout.strip(), 1003)


def _linux_key(browser_id: str) -> bytes:
    application = "chromium" if browser_id == "chromium" else "chrome"
    try:
        completed = subprocess.run(
            ["secret-tool", "lookup", "application", application],
            capture_output=True, timeout=90, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CookieImportError(
            "Linux keyring access failed; install libsecret-tools and unlock the browser keyring"
        ) from exc
    if completed.returncode != 0 or not completed.stdout.strip():
        raise CookieImportError("the Linux browser keyring is locked or its key was not found")
    return _derive_key(completed.stdout.strip(), 1)


def _windows_dpapi(ciphertext: bytes) -> bytes:
    """Decrypt a current-user DPAPI blob without printing either buffer."""
    if sys.platform != "win32":
        raise CookieImportError("Windows DPAPI is only available on Windows")
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    data = (ctypes.c_ubyte * len(ciphertext)).from_buffer_copy(ciphertext)
    source = DataBlob(len(ciphertext), data)
    output = DataBlob()
    crypt32 = ctypes.windll.crypt32
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    if not crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)
    ):
        raise CookieImportError("Windows DPAPI could not decrypt this browser key")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        local_free = ctypes.windll.kernel32.LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free.restype = ctypes.c_void_p
        local_free(output.pbData)


def _windows_key(root: Path) -> bytes:
    try:
        state = json.loads((root / "Local State").read_text(encoding="utf-8"))
        encoded = state["os_crypt"]["encrypted_key"]
        encrypted = base64.b64decode(encoded, validate=True)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise CookieImportError("Windows browser encryption key was not found") from exc
    if not encrypted.startswith(b"DPAPI"):
        raise CookieImportError("this Windows browser encryption key is not supported")
    key = _windows_dpapi(encrypted[5:])
    if len(key) != 32:
        raise CookieImportError("Windows browser encryption key has an invalid length")
    return key


def _decrypt_chromium(
    encrypted: bytes, host: str, source: CookieProfile, db_version: int,
    keys: dict[str, bytes],
) -> str:
    system = platform.system()
    if encrypted.startswith(b"v20"):
        raise _ProtectedCookie("application-bound Chrome cookie")
    if system == "Windows":
        if encrypted.startswith(b"v10"):
            if len(encrypted) < 3 + 12 + 16:
                raise ValueError("invalid Windows cookie blob")
            if "v10" not in keys:
                keys["v10"] = _windows_key(source.root)
            plain = AESGCM(keys["v10"]).decrypt(encrypted[3:15], encrypted[15:], None)
        else:
            plain = _windows_dpapi(encrypted)
    else:
        prefix = encrypted[:3]
        if prefix not in (b"v10", b"v11") or (len(encrypted) - 3) % 16:
            raise ValueError("unsupported Chromium cookie encryption")
        version = prefix.decode("ascii")
        if version not in keys:
            if system == "Darwin":
                if version != "v10":
                    raise ValueError("unsupported macOS Chromium cookie encryption")
                keys[version] = _mac_key(source.browser_id)
            elif version == "v10":
                keys[version] = _derive_key(b"peanuts", 1)
            else:
                keys[version] = _linux_key(source.browser_id)
        decryptor = Cipher(algorithms.AES(keys[version]), modes.CBC(b" " * 16)).decryptor()
        padded = decryptor.update(encrypted[3:]) + decryptor.finalize()
        unpadder = PKCS7(128).unpadder()
        plain = unpadder.update(padded) + unpadder.finalize()
    if db_version >= 24:
        digest = hashlib.sha256(host.encode("utf-8")).digest()
        if not plain.startswith(digest):
            raise ValueError("Chromium cookie domain check failed")
        plain = plain[len(digest):]
    return plain.decode("utf-8")


def _read_chromium(source: CookieProfile) -> tuple[list[_Cookie], dict[str, int]]:
    now_ms = int(time.time() * 1000)
    counts = {"expired": 0, "partitioned": 0, "unsupported": 0,
              "protected": 0, "session_extended": 0}
    cookies: list[_Cookie] = []
    keys: dict[str, bytes] = {}
    try:
        with closing(sqlite3.connect(source.database.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
            row = db.execute("SELECT value FROM meta WHERE key='version'").fetchone()
            version = int(row[0]) if row else 0
            columns = {item[1] for item in db.execute("PRAGMA table_info(cookies)")}
            if not _CHROMIUM_COLUMNS <= columns:
                raise CookieImportError("this Chromium cookie database version is not supported")
            source_port = "source_port" if "source_port" in columns else "-1 AS source_port"
            for (host, partition, name, value, encrypted, path, expires, secure,
                 http_only, persistent, same_site, source_scheme, port) in db.execute(
                     "SELECT host_key, top_frame_site_key, name, value, encrypted_value, "
                     "path, expires_utc, is_secure, is_httponly, is_persistent, "
                     f"samesite, source_scheme, {source_port} FROM cookies"
                 ):
                if partition:
                    counts["partitioned"] += 1
                    continue
                temporary = not (persistent and expires)
                expiry = (now_ms + _SESSION_COOKIE_MS if temporary else
                          (int(expires) - _CHROME_EPOCH_US) // 1000)
                if expiry <= now_ms:
                    counts["expired"] += 1
                    continue
                if same_site not in (-1, 0, 1, 2):
                    counts["unsupported"] += 1
                    continue
                try:
                    cookie_value = _decrypt_chromium(encrypted, host, source, version, keys) if encrypted else value
                except _ProtectedCookie:
                    counts["protected"] += 1
                    continue
                except (ValueError, UnicodeError, InvalidTag):
                    counts["unsupported"] += 1
                    continue
                cookies.append(_Cookie(
                    name, cookie_value, host, path or "/", expiry, int(bool(secure)),
                    int(bool(http_only)), 256 if same_site == -1 else same_site,
                    source_scheme if source_scheme in (1, 2) else 0,
                    port if isinstance(port, int) and -1 <= port <= 65535 else -1,
                ))
                if temporary:
                    counts["session_extended"] += 1
    except sqlite3.Error as exc:
        raise CookieImportError("could not read the selected Chromium profile") from exc
    return cookies, counts


def _read_firefox(source: CookieProfile) -> tuple[list[_Cookie], dict[str, int]]:
    now_ms = int(time.time() * 1000)
    counts = {"expired": 0, "partitioned": 0, "unsupported": 0,
              "protected": 0, "session_extended": 0}
    cookies: list[_Cookie] = []
    try:
        with closing(sqlite3.connect(source.database.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            columns = {row[1] for row in db.execute("PRAGMA table_info(moz_cookies)")}
            if version not in _FIREFOX_SCHEMA_VERSIONS or not _FIREFOX_COLUMNS <= columns:
                raise CookieImportError("this Firefox cookie database version is not supported")
            for attrs, name, value, host, path, expiry, secure, http_only, same_site, scheme in db.execute(
                "SELECT originAttributes, name, value, host, path, expiry, isSecure, "
                "isHttpOnly, sameSite, schemeMap FROM moz_cookies"
            ):
                if attrs:
                    counts["partitioned" if "partitionKey" in attrs else "unsupported"] += 1
                    continue
                expiry_ms = expiry * 1000 if version == 15 else expiry
                if expiry_ms <= now_ms:
                    counts["expired"] += 1
                    continue
                if same_site not in (0, 1, 2, 256):
                    counts["unsupported"] += 1
                    continue
                cookies.append(_Cookie(
                    name, value, host, path or "/", expiry_ms, int(bool(secure)),
                    int(bool(http_only)), same_site, 2 if scheme & 2 else 1 if scheme & 1 else 0,
                    -1,
                ))
    except sqlite3.Error as exc:
        raise CookieImportError("could not read the selected Firefox profile") from exc
    return cookies, counts


def _write_firefox(profile: Path, cookies: list[_Cookie]) -> int:
    now_us = int(time.time() * 1_000_000)
    database = profile / "cookies.sqlite"
    try:
        with closing(sqlite3.connect(database, timeout=5)) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            columns = {row[1] for row in db.execute("PRAGMA table_info(moz_cookies)")}
            if version not in _FIREFOX_SCHEMA_VERSIONS or not _FIREFOX_COLUMNS <= columns:
                raise CookieImportError("this Firefox cookie database version is not supported")
            if _target_open(profile, "firefox"):
                raise CookieImportError("close the Lanius Firefox profile before importing cookies")
            with db:
                has_update_time = "updateTime" in columns
                update_column = ", updateTime" if has_update_time else ""
                update_value = ", ?" if has_update_time else ""
                update_assignment = ", updateTime=excluded.updateTime" if has_update_time else ""
                db.executemany(
                    "INSERT INTO moz_cookies (originAttributes, name, value, host, path, "
                    "expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite, "
                    f"schemeMap, isPartitionedAttributeSet{update_column}) "
                    f"VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0{update_value}) "
                    "ON CONFLICT(name, host, path, originAttributes) DO UPDATE SET "
                    "value=excluded.value, expiry=excluded.expiry, "
                    "lastAccessed=excluded.lastAccessed, isSecure=excluded.isSecure, "
                    "isHttpOnly=excluded.isHttpOnly, sameSite=excluded.sameSite, "
                    f"schemeMap=excluded.schemeMap{update_assignment}",
                    [
                        (item.name, item.value, item.host, item.path,
                         item.expiry // 1000 if version == 15 else item.expiry,
                         now_us, now_us, item.secure, item.http_only, item.same_site,
                         item.source_scheme, *((now_us,) if has_update_time else ()))
                        for item in cookies
                    ],
                )
    except sqlite3.Error as exc:
        raise CookieImportError("could not write the Lanius Firefox cookies") from exc
    return len(cookies)


def _cdp_cookie(item: _Cookie) -> dict[str, object]:
    scheme = "https" if item.secure or item.source_scheme == 2 else "http"
    host = item.host.lstrip(".")
    cookie: dict[str, object] = {
        "name": item.name, "value": item.value, "url": f"{scheme}://{host}/",
        "path": item.path, "expires": item.expiry / 1000,
        "secure": bool(item.secure), "httpOnly": bool(item.http_only),
    }
    if item.host.startswith("."):
        cookie["domain"] = item.host
    if item.same_site != 256:
        cookie["sameSite"] = {0: "None", 1: "Lax", 2: "Strict"}[item.same_site]
    if item.source_scheme in (1, 2):
        cookie["sourceScheme"] = "Secure" if item.source_scheme == 2 else "NonSecure"
    if item.source_port == -1 or 1 <= item.source_port <= 65535:
        cookie["sourcePort"] = item.source_port
    return cookie


def _cdp_call(ws: ClientConnection, request_id: int, method: str, params: dict[str, object] | None = None) -> dict:
    ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
    while True:
        response = json.loads(ws.recv(timeout=15))
        if response.get("id") == request_id:
            if "error" in response:
                raise CookieImportError(f"{method} failed in the destination browser")
            return response.get("result", {})


def _write_chromium(browser_id: str, profile: Path, cookies: list[_Cookie]) -> int:
    """Ask a temporary headless browser to store and encrypt its own cookies."""
    if _target_open(profile, browser_id):
        raise CookieImportError("close the Lanius destination browser before importing cookies")
    try:
        choice = browser.browser_by_id(browser_id)
        active_port = profile / "DevToolsActivePort"
        active_port.unlink(missing_ok=True)
    except (browser.BrowserError, OSError) as exc:
        raise CookieImportError("could not prepare the destination browser") from exc
    args = [
        choice.path, f"--user-data-dir={profile}", "--headless=new",
        "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-sync", "--disable-component-update",
        "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
        "about:blank",
    ]
    try:
        process = subprocess.Popen(
            args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        raise CookieImportError("could not start the destination browser") from exc
    try:
        deadline = time.monotonic() + 20
        while not active_port.is_file() and time.monotonic() < deadline:
            if process.poll() is not None:
                raise CookieImportError("the destination browser closed before cookie import started")
            time.sleep(0.1)
        if not active_port.is_file():
            raise CookieImportError("the destination browser did not start its local cookie interface")
        port_text, path = active_port.read_text(encoding="utf-8").splitlines()[:2]
        port = int(port_text)
        if not 1 <= port <= 65535 or not path.startswith("/devtools/browser/"):
            raise CookieImportError("the destination browser returned an invalid local interface")
        with connect(f"ws://127.0.0.1:{port}{path}", open_timeout=5, close_timeout=2) as ws:
            for index in range(0, len(cookies), 100):
                _cdp_call(ws, index + 1, "Storage.setCookies", {
                    "cookies": [_cdp_cookie(item) for item in cookies[index:index + 100]],
                })
            stored = _cdp_call(ws, len(cookies) + 1, "Storage.getCookies").get("cookies", [])
            try:
                _cdp_call(ws, len(cookies) + 2, "Browser.close")
            except (CookieImportError, OSError, WebSocketException):
                pass
        # Chrome writes its cookie store during shutdown. Killing it directly
        # after the CDP reply can lose a successful in-memory import.
        process.wait(timeout=10)
        matches = {
            (item.get("name"), item.get("domain"), item.get("path"), item.get("value"))
            for item in stored if not item.get("partitionKey")
        }
        return sum(
            (item.name, item.host, item.path, item.value) in matches for item in cookies
        )
    except (OSError, ValueError, IndexError, TimeoutError, subprocess.TimeoutExpired,
            WebSocketException) as exc:
        raise CookieImportError("could not use the destination browser's local cookie interface") from exc
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def _checked_target(
    target_browser: str, data_dir: Path, custom_profile: Path | str | None,
) -> Path:
    if target_browser not in _BROWSER_IDS:
        raise CookieImportError("the destination browser is not supported")
    try:
        browser.browser_by_id(target_browser)
    except browser.BrowserError as exc:
        raise CookieImportError("the destination browser is not installed") from exc
    target = _target_profile(data_dir, custom_profile, target_browser)
    if not _target_ready(target, target_browser):
        raise CookieImportError("open the destination browser from Lanius once, then close it")
    if _target_open(target, target_browser):
        raise CookieImportError("close the Lanius destination browser before importing cookies")
    return target


def _save_cookies(
    cookies: list[_Cookie], counts: dict[str, int], target_browser: str, target: Path,
) -> dict[str, int]:
    if not cookies:
        if counts["protected"]:
            raise CookieImportError(
                "this source browser protects its cookies from other applications; "
                "use the browser extension import option"
            )
        raise CookieImportError("no supported cookies could be imported from this profile")
    # Browsers expose one cookie per name/domain/path in this unpartitioned import.
    unique = {(item.name, item.host, item.path): item for item in cookies}
    cookies = list(unique.values())
    if target_browser in _CHROMIUM_IDS:
        valid = [item for item in cookies if not (item.same_site == 0 and not item.secure)]
        counts["unsupported"] += len(cookies) - len(valid)
        cookies = valid
        if not cookies:
            raise CookieImportError("no cookies accepted by the destination browser remain")
        imported = _write_chromium(target_browser, target, cookies)
        counts["unsupported"] += len(cookies) - imported
    else:
        imported = _write_firefox(target, cookies)
    if imported == 0:
        raise CookieImportError("the destination browser did not keep any imported cookies")
    return {"imported": imported, **counts}


def import_cookies(
    source_profile: str, target_browser: str, data_dir: Path,
    custom_profile: Path | str | None = None,
) -> dict[str, int]:
    """Import every transferable cookie from one selected source profile."""
    source = next((item for item in source_profiles() if item.id == source_profile), None)
    if source is None:
        raise CookieImportError("the selected source browser profile was not found")
    target = _checked_target(target_browser, data_dir, custom_profile)

    cookies, counts = (
        _read_firefox(source) if source.browser_id == "firefox" else _read_chromium(source)
    )
    return _save_cookies(cookies, counts, target_browser, target)


def import_exported_cookies(
    exported: object, target_browser: str, data_dir: Path,
    custom_profile: Path | str | None = None,
) -> dict[str, int]:
    """Accept cookies exported by the bundled extension in the source browser."""
    target = _checked_target(target_browser, data_dir, custom_profile)
    if not isinstance(exported, list) or len(exported) > 100_000:
        raise CookieImportError("the browser extension sent an invalid cookie list")
    counts = {"expired": 0, "partitioned": 0, "unsupported": 0,
              "protected": 0, "session_extended": 0}
    cookies: list[_Cookie] = []
    now_ms = int(time.time() * 1000)
    same_site_values = {"no_restriction": 0, "lax": 1, "strict": 2, "unspecified": 256}
    for item in exported:
        if not isinstance(item, dict):
            counts["unsupported"] += 1
            continue
        if item.get("partitionKey"):
            counts["partitioned"] += 1
            continue
        name, value, host, path = (item.get("name"), item.get("value"),
                                   item.get("domain"), item.get("path"))
        if (
            not isinstance(name, str) or not isinstance(value, str)
            or not isinstance(host, str) or not isinstance(path, str)
            or not host or not path.startswith("/") or len(name) + len(value) > 16_384
        ):
            counts["unsupported"] += 1
            continue
        same_site_name = item.get("sameSite")
        same_site = (same_site_values.get(same_site_name)
                     if isinstance(same_site_name, str) else None)
        if same_site is None:
            counts["unsupported"] += 1
            continue
        temporary = item.get("session") is True
        expiration = item.get("expirationDate")
        if temporary:
            expiry = now_ms + _SESSION_COOKIE_MS
        elif (isinstance(expiration, (int, float)) and not isinstance(expiration, bool)
              and math.isfinite(expiration)):
            expiry = int(expiration * 1000)
        else:
            counts["unsupported"] += 1
            continue
        if expiry <= now_ms:
            counts["expired"] += 1
            continue
        secure = int(item.get("secure") is True)
        cookies.append(_Cookie(
            name, value, host, path, expiry, secure,
            int(item.get("httpOnly") is True), same_site, 2 if secure else 1, -1,
        ))
        if temporary:
            counts["session_extended"] += 1
    return _save_cookies(cookies, counts, target_browser, target)
