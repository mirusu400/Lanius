"""Upstream TLS profiles."""

from __future__ import annotations

import pytest

from app.tls import (
    DEFAULT_PROFILE,
    PROFILES,
    options_for,
    patch_version_probe,
    validate_ciphers,
)


def test_every_profile_is_accepted_by_openssl() -> None:
    """A profile OpenSSL rejects would turn every upstream request into a
    502, so they are checked here rather than discovered in the field."""
    for name, profile in PROFILES.items():
        if profile["ciphers"]:
            validate_ciphers(profile["ciphers"])
        assert profile["label"], f"{name} needs a label"


def test_profiles_differ_from_the_default() -> None:
    """A browser profile that matched mitmproxy's own list would be
    pointless."""
    default = PROFILES[DEFAULT_PROFILE]["ciphers"]
    for name in ("chrome", "firefox", "safari"):
        assert PROFILES[name]["ciphers"] != default


def test_browser_profiles_lead_with_tls13_suites() -> None:
    """Browsers offer the TLS 1.3 suites first; a list that did not would
    not resemble one."""
    for name in ("chrome", "firefox", "safari"):
        first = PROFILES[name]["ciphers"].split(":")[0]
        assert first.startswith("TLS_"), f"{name} starts with {first}"


def test_options_for_maps_a_profile_to_mitmproxy_options() -> None:
    opts = options_for("chrome")
    assert set(opts) == {
        "ciphers_server",
        "tls_ecdh_curve_server",
        "tls_version_server_min",
        "tls_version_server_max",
    }
    assert opts["ciphers_server"] == PROFILES["chrome"]["ciphers"]


def test_custom_ciphers_override_the_profile() -> None:
    opts = options_for("chrome", "AES256-SHA")
    assert opts["ciphers_server"] == "AES256-SHA"


def test_an_unknown_profile_falls_back_to_the_default() -> None:
    """Reading a stale setting must not take the engine down."""
    assert options_for("nonsense") == options_for(DEFAULT_PROFILE)


def test_tls12_profile_pins_both_ends_of_the_range() -> None:
    opts = options_for("tls12")
    assert opts["tls_version_server_min"] == "TLS1_2"
    assert opts["tls_version_server_max"] == "TLS1_2"


def test_validate_ciphers_rejects_an_unusable_list() -> None:
    with pytest.raises(ValueError):
        validate_ciphers("NOT-A-REAL-CIPHER")


def test_validate_ciphers_accepts_a_real_one() -> None:
    validate_ciphers("ECDHE-RSA-AES128-GCM-SHA256")


def test_version_probe_patch_survives_an_openssl_that_raises() -> None:
    """mitmproxy builds a warning by asking OpenSSL about every TLS
    version, and OpenSSL 3.5 raises when asked about SSL3 instead of
    answering False. That crash would surface as a 500 from our API."""
    from mitmproxy.net import tls as net_tls

    patch_version_probe()
    # Must answer rather than raise, whatever this build supports.
    assert net_tls.is_supported_version(net_tls.Version.SSL3) in (True, False)
    assert net_tls.is_supported_version(net_tls.Version.TLS1_2) is True


def test_patching_twice_is_harmless() -> None:
    patch_version_probe()
    assert patch_version_probe() is False, "already patched"
