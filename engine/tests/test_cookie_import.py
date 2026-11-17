"""Browser cookie transfer tests use only synthetic values and profiles."""

from __future__ import annotations

import hashlib
import sqlite3
import time
from pathlib import Path
from unittest import mock

import pytest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.padding import PKCS7

from app import browser, cookie_import


def _cbc_blob(host: str, value: str, key: bytes, prefix: bytes = b"v10") -> bytes:
    plain = hashlib.sha256(host.encode()).digest() + value.encode()
    padder = PKCS7(128).padder()
    padded = padder.update(plain) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).encryptor()
    return prefix + encryptor.update(padded) + encryptor.finalize()


def _gcm_blob(host: str, value: str, key: bytes) -> bytes:
    return b"v10" + b"0" * 12 + AESGCM(key).encrypt(
        b"0" * 12, hashlib.sha256(host.encode()).digest() + value.encode(), None,
    )


def _chrome_source(tmp_path: Path, encrypted: bytes) -> cookie_import.CookieProfile:
    root = tmp_path / "Chrome"
    database = root / "Default" / "Cookies"
    database.parent.mkdir(parents=True)
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE meta (key TEXT, value INTEGER)")
        db.execute("INSERT INTO meta VALUES ('version', 24)")
        db.execute("CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT, "
                   "name TEXT, value TEXT, encrypted_value BLOB, path TEXT, "
                   "expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, "
                   "is_persistent INTEGER, samesite INTEGER, source_scheme INTEGER, "
                   "source_port INTEGER)")
        future = int((time.time() + 3600) * 1_000_000) + cookie_import._CHROME_EPOCH_US
        db.executemany("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            (".example.test", "", "auth", "", encrypted, "/", future,
             1, 1, 1, 1, 2, 443),
            ("example.test", "", "temporary", "short", b"", "/", 0,
             0, 0, 0, -1, 1, -1),
            ("third.test", "https://example.test", "partition", "", b"v20opaque", "/",
             future, 1, 0, 1, 0, 2, 443),
            ("broken.test", "", "invalid", "", b"v10bad", "/", 0,
             0, 0, 0, -1, 1, 80),
        ])
    return cookie_import.CookieProfile(
        "chrome:Default", "Google Chrome — Default", "chrome", 4, database, root,
    )


def _firefox_database(database: Path, version: int = 17) -> None:
    database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database) as db:
        db.execute(f"PRAGMA user_version={version}")
        db.execute("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT "
                   "NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, "
                   "expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, "
                   "isHttpOnly INTEGER, sameSite INTEGER, schemeMap INTEGER, "
                   "isPartitionedAttributeSet INTEGER DEFAULT 0, "
                   + ("updateTime INTEGER, " if version >= 17 else "") +
                   "UNIQUE(name,host,path,originAttributes))")


def _firefox_target(tmp_path: Path) -> Path:
    target = tmp_path / "browser-profile-firefox"
    _firefox_database(target / "cookies.sqlite")
    (target / "lanius-profile").touch()
    return target


def _import_to_firefox(
    source: cookie_import.CookieProfile, tmp_path: Path, system: str, key: bytes,
) -> dict[str, int]:
    with mock.patch.object(cookie_import.platform, "system", return_value=system), \
         mock.patch.object(cookie_import, "source_profiles", return_value=[source]), \
         mock.patch.object(cookie_import.browser, "browser_by_id", return_value=browser.Browser("Firefox", "firefox", "firefox")), \
         mock.patch.object(cookie_import.browser, "_firefox_running", return_value=False), \
         mock.patch.object(cookie_import, "_mac_key", return_value=key), \
         mock.patch.object(cookie_import, "_windows_key", return_value=key):
        return cookie_import.import_cookies(source.id, "firefox", tmp_path)


def test_mac_chrome_to_closed_firefox_copies_whole_supported_profile(tmp_path) -> None:
    key = b"0123456789abcdef"
    source = _chrome_source(tmp_path, _cbc_blob(".example.test", "session-token", key))
    target = _firefox_target(tmp_path)
    result = _import_to_firefox(source, tmp_path, "Darwin", key)
    assert result == {"imported": 2, "expired": 0, "partitioned": 1,
                      "unsupported": 1, "protected": 0, "session_extended": 1}
    with sqlite3.connect(target / "cookies.sqlite") as db:
        rows = list(db.execute("SELECT name,value,host,isSecure,isHttpOnly,sameSite,expiry "
                               "FROM moz_cookies ORDER BY name"))
    assert rows[0][:6] == ("auth", "session-token", ".example.test", 1, 1, 1)
    assert rows[1][:6] == ("temporary", "short", "example.test", 0, 0, 256)
    assert rows[1][6] > int(time.time() * 1000)


def test_linux_basic_and_windows_dpapi_v10_sources_can_import(tmp_path) -> None:
    key = cookie_import._derive_key(b"peanuts", 1)
    linux = _chrome_source(tmp_path / "linux", _cbc_blob(".example.test", "linux-token", key))
    _firefox_target(tmp_path / "linux")
    linux_result = _import_to_firefox(linux, tmp_path / "linux", "Linux", key)
    assert linux_result["imported"] == 2
    with sqlite3.connect(tmp_path / "linux/browser-profile-firefox/cookies.sqlite") as db:
        assert db.execute("SELECT value FROM moz_cookies WHERE name='auth'").fetchone()[0] == "linux-token"

    windows_key = b"w" * 32
    windows = _chrome_source(tmp_path / "windows", _gcm_blob(".example.test", "win-token", windows_key))
    _firefox_target(tmp_path / "windows")
    windows_result = _import_to_firefox(windows, tmp_path / "windows", "Windows", windows_key)
    assert windows_result["imported"] == 2
    with sqlite3.connect(tmp_path / "windows/browser-profile-firefox/cookies.sqlite") as db:
        assert db.execute("SELECT value FROM moz_cookies WHERE name='auth'").fetchone()[0] == "win-token"


def test_windows_app_bound_cookie_is_reported_as_protected(tmp_path) -> None:
    source = _chrome_source(tmp_path, b"v20opaque")
    _firefox_target(tmp_path)
    result = _import_to_firefox(source, tmp_path, "Windows", b"w" * 32)
    assert result["imported"] == 1  # plaintext temporary cookie still transfers
    assert result["protected"] == 1


def test_firefox_source_can_target_chromium_via_browser_cookie_api(tmp_path) -> None:
    source_db = tmp_path / "Firefox/Profiles/test.default/cookies.sqlite"
    _firefox_database(source_db)
    future = int(time.time() * 1000) + 3_600_000
    with sqlite3.connect(source_db) as db:
        db.executemany(
            "INSERT INTO moz_cookies (originAttributes,name,value,host,path,expiry,isSecure,"
            "isHttpOnly,sameSite,schemeMap) VALUES (?,?,?,?,?,?,?,?,?,?)", [
                ("", "auth", "synthetic", ".example.test", "/", future, 1, 1, 256, 2),
                ("^partitionKey=%28https%2Cexample.test%29", "partition", "skip",
                 ".example.test", "/", future, 1, 0, 1, 2),
            ],
        )
    source = cookie_import.CookieProfile(
        "firefox:test.default", "Firefox — test.default", "firefox", 2,
        source_db, source_db.parent.parent,
    )
    target = tmp_path / "browser-profile-chromium"
    (target / "Default").mkdir(parents=True)
    (target / "Default/Cookies").touch()
    (target / "lanius-profile").touch()
    with mock.patch.object(cookie_import, "source_profiles", return_value=[source]), \
         mock.patch.object(cookie_import.browser, "browser_by_id", return_value=browser.Browser("Chromium", "chromium", "chromium")), \
         mock.patch.object(cookie_import, "_chromium_running", return_value=False), \
         mock.patch.object(cookie_import, "_write_chromium", return_value=1) as write:
        result = cookie_import.import_cookies(source.id, "chromium", tmp_path)
    assert result["imported"] == 1
    assert result["partitioned"] == 1
    assert write.call_args.args[0:2] == ("chromium", target)
    assert write.call_args.args[2][0].value == "synthetic"


def test_refuses_open_or_unowned_target_before_reading_source(tmp_path) -> None:
    source = _chrome_source(tmp_path, b"v10opaque")
    target = _firefox_target(tmp_path)
    with mock.patch.object(cookie_import, "source_profiles", return_value=[source]), \
         mock.patch.object(cookie_import.browser, "browser_by_id", return_value=browser.Browser("Firefox", "firefox", "firefox")), \
         mock.patch.object(cookie_import, "_read_chromium") as read:
        with mock.patch.object(cookie_import.browser, "_firefox_running", return_value=True):
            with pytest.raises(cookie_import.CookieImportError, match="close"):
                cookie_import.import_cookies(source.id, "firefox", tmp_path)
        (target / "lanius-profile").unlink()
        with mock.patch.object(cookie_import.browser, "_firefox_running", return_value=False):
            with pytest.raises(cookie_import.CookieImportError, match="open"):
                cookie_import.import_cookies(source.id, "firefox", tmp_path)
    read.assert_not_called()


def test_discovers_chromium_and_firefox_profile_names(tmp_path) -> None:
    chrome = _chrome_source(tmp_path, b"v10opaque")
    (chrome.root / "Local State").write_text(
        '{"profile":{"info_cache":{"Default":{"name":"Work"}}}}', encoding="utf-8",
    )
    firefox_db = tmp_path / "Firefox/Profiles/abc.default/cookies.sqlite"
    _firefox_database(firefox_db)
    with mock.patch.object(cookie_import.browser, "browser_choices", return_value=[]):
        found = cookie_import.source_profiles({"chrome": chrome.root, "firefox": firefox_db.parent.parent})
    assert [(item.id, item.name) for item in found] == [
        ("chrome:Default", "Google Chrome — Work"),
        ("firefox:abc.default", "Firefox — abc.default"),
    ]


def test_discovers_distinct_linux_firefox_roots(tmp_path) -> None:
    legacy = tmp_path / "legacy"
    xdg = tmp_path / "xdg"
    _firefox_database(legacy / "default/cookies.sqlite")
    _firefox_database(xdg / "default/cookies.sqlite")
    with mock.patch.object(cookie_import.browser, "browser_choices", return_value=[]):
        found = cookie_import.source_profiles({"firefox": (legacy, xdg)})
    assert [item.id for item in found] == ["firefox:default", "firefox@1:default"]


def test_chromium_destination_encrypts_with_its_own_cookie_store(tmp_path) -> None:
    choice = next((item for item in browser.browser_choices()
                   if item.id == "chrome" and item.path), None)
    if choice is None:
        pytest.skip("Chrome is not installed on this test host")
    profile = tmp_path / "lanius-chrome"
    profile.mkdir()
    cookie = cookie_import._Cookie(
        "synthetic", "test-value", "example.test", "/",
        int(time.time() * 1000) + 3_600_000, 0, 0, 256, 1, -1,
    )
    assert cookie_import._write_chromium("chrome", profile, [cookie]) == 1
    database = cookie_import._chromium_database(profile / "Default")
    assert database is not None
    with sqlite3.connect(database) as db:
        value, encrypted = db.execute(
            "SELECT value, encrypted_value FROM cookies WHERE name='synthetic'"
        ).fetchone()
    assert value == ""
    assert encrypted


def test_extension_export_imports_session_cookies_without_a_plaintext_file(tmp_path) -> None:
    target = _firefox_target(tmp_path)
    future = time.time() + 3600
    exported = [
        {"name": "session", "value": "synthetic-token", "domain": ".example.test",
         "path": "/", "secure": True, "httpOnly": True, "sameSite": "lax",
         "session": True},
        {"name": "persistent", "value": "other", "domain": "example.test",
         "path": "/", "secure": False, "httpOnly": False, "sameSite": "unspecified",
         "session": False, "expirationDate": future},
        {"name": "partition", "value": "skip", "domain": "third.test",
         "path": "/", "sameSite": "lax", "partitionKey": {"topLevelSite": "https://example.test"}},
    ]
    with mock.patch.object(cookie_import.browser, "browser_by_id", return_value=browser.Browser("Firefox", "firefox", "firefox")), \
         mock.patch.object(cookie_import.browser, "_firefox_running", return_value=False):
        result = cookie_import.import_exported_cookies(exported, "firefox", tmp_path)
    assert result["imported"] == 2
    assert result["partitioned"] == 1
    assert result["session_extended"] == 1
    with sqlite3.connect(target / "cookies.sqlite") as db:
        assert db.execute("SELECT value FROM moz_cookies WHERE name='session'").fetchone()[0] == "synthetic-token"


@pytest.mark.parametrize("version", [15, 16])
def test_firefox_older_schema_reads_and_writes_expiry_units(tmp_path, version) -> None:
    source_db = tmp_path / "source/cookies.sqlite"
    _firefox_database(source_db, version)
    future_ms = int(time.time() * 1000) + 3_600_000
    source_expiry = future_ms // 1000 if version == 15 else future_ms
    with sqlite3.connect(source_db) as db:
        db.execute(
            "INSERT INTO moz_cookies (name,value,host,path,expiry,isSecure,isHttpOnly,"
            "sameSite,schemeMap) VALUES (?,?,?,?,?,?,?,?,?)",
            ("auth", "synthetic-token", "example.test", "/", source_expiry, 0, 0, 1, 1),
        )
    target = tmp_path / "browser-profile-firefox"
    _firefox_database(target / "cookies.sqlite", version)
    (target / "lanius-profile").touch()
    source = cookie_import.CookieProfile(
        "firefox:source", "Firefox — source", "firefox", 1, source_db, source_db.parent,
    )
    with mock.patch.object(cookie_import, "source_profiles", return_value=[source]), \
         mock.patch.object(cookie_import.browser, "browser_by_id", return_value=browser.Browser("Firefox", "firefox", "firefox")), \
         mock.patch.object(cookie_import.browser, "_firefox_running", return_value=False):
        result = cookie_import.import_cookies(source.id, "firefox", tmp_path)
    assert result["imported"] == 1
    with sqlite3.connect(target / "cookies.sqlite") as db:
        imported_expiry = db.execute("SELECT expiry FROM moz_cookies").fetchone()[0]
    assert imported_expiry == source_expiry


def test_extension_skips_nonfinite_cookie_expiry(tmp_path) -> None:
    _firefox_target(tmp_path)
    exported = [
        {"name": "bad", "value": "synthetic", "domain": "example.test", "path": "/",
         "sameSite": "lax", "session": False, "expirationDate": float("inf")},
        {"name": "good", "value": "synthetic", "domain": "example.test", "path": "/",
         "sameSite": "lax", "session": True},
    ]
    with mock.patch.object(cookie_import.browser, "browser_by_id", return_value=browser.Browser("Firefox", "firefox", "firefox")), \
         mock.patch.object(cookie_import.browser, "_firefox_running", return_value=False):
        result = cookie_import.import_exported_cookies(exported, "firefox", tmp_path)
    assert result["imported"] == 1
    assert result["unsupported"] == 1


def test_windows_and_linux_source_roots_cover_all_requested_browsers(tmp_path) -> None:
    with mock.patch.dict(cookie_import.os.environ, {
        "LOCALAPPDATA": str(tmp_path / "local"),
        "APPDATA": str(tmp_path / "roaming"),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
    }):
        windows = cookie_import._source_roots("Windows")
        linux = cookie_import._source_roots("Linux")
    assert windows["chrome-beta"] == tmp_path / "local/Google/Chrome Beta/User Data"
    assert windows["chromium"] == tmp_path / "local/Chromium/User Data"
    assert windows["firefox"] == tmp_path / "roaming/Mozilla/Firefox/Profiles"
    assert linux["chrome-beta"] == tmp_path / "config/google-chrome-beta"
    assert linux["chromium"][0] == tmp_path / "config/chromium"
    assert linux["chromium"][1] == Path.home() / "snap/chromium/common/chromium"
    assert linux["firefox"][1] == tmp_path / "config/mozilla/firefox"
    assert linux["firefox"][2] == Path.home() / "snap/firefox/common/.mozilla/firefox"
