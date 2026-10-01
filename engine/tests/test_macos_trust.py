"""System trust must preserve policy checks and never fetch certificates."""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest import mock

import pytest
from cryptography.hazmat.primitives.serialization import Encoding
from mitmproxy import connection
from OpenSSL import SSL

from app.addons.system_trust import MacOSSystemTrustAddon
from app.macos_trust import MacOSTrust
from .test_tls_trust import certificate, pem


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS Security framework")
def test_native_ssl_policy_and_offline_evaluation():
    trust = MacOSTrust()
    ca = certificate()
    leaf, _ = certificate(ca=False, issuer=ca)
    chain = [leaf.public_bytes(Encoding.DER)]
    anchors = (ca[0].public_bytes(Encoding.DER),)
    with mock.patch.object(trust.security, "SecTrustSetNetworkFetchAllowed", wraps=trust.security.SecTrustSetNetworkFetchAllowed) as fetch, \
         mock.patch.object(trust.security, "SecPolicyCreateRevocation", wraps=trust.security.SecPolicyCreateRevocation) as revocation:
        assert trust.verify(chain, "localhost", anchors)
        assert not trust.verify(chain, "other.example", anchors)
        assert not trust.verify(chain, "localhost")
        expired, _ = certificate(ca=False, expired=True, issuer=ca)
        assert not trust.verify([expired.public_bytes(Encoding.DER)], "localhost", anchors)
        assert all(call.args[1] is False for call in fetch.call_args_list)
        assert fetch.call_count == 4
        assert revocation.call_args_list == [mock.call(0b10011)] * 4
    assert not trust.verify([], "localhost", anchors)
    assert not trust.verify(chain, "", anchors)
    assert not trust.verify(chain, "localhost\x00other.example", anchors)


def callback(addon):
    data = SimpleNamespace(
        conn=connection.Server(address=("localhost", 443), sni="localhost"),
        ssl_conn=mock.Mock(),
    )
    with mock.patch("app.addons.system_trust.ctx", SimpleNamespace(options=SimpleNamespace(ssl_insecure=False))):
        addon.tls_start_server(data)
    mode, verify = data.ssl_conn.set_verify.call_args.args
    assert mode == SSL.VERIFY_PEER
    return verify


def test_handshake_uses_full_chain_and_only_caches_for_this_connection():
    ca = certificate()
    leaf, _ = certificate(ca=False, issuer=ca)
    trust = mock.Mock()
    trust.verify.return_value = True
    with mock.patch("app.addons.system_trust.macos_trust", return_value=trust):
        addon = MacOSSystemTrustAddon(pem(ca[0]))
    conn = mock.Mock()
    conn.get_peer_cert_chain.return_value = [leaf, ca[0]]
    verify = callback(addon)
    # OpenSSL cannot find the private root, but native trust can verify it.
    assert verify(conn, None, 20, 0, 0)
    assert verify(conn, None, 0, 0, 1)
    trust.verify.assert_called_once_with(
        [cert.public_bytes(Encoding.DER) for cert in (leaf, ca[0])],
        "localhost", (ca[0].public_bytes(Encoding.DER),),
    )
    # A fresh handshake must observe a new deny decision, even if OpenSSL's
    # CA bundle would otherwise accept the certificate.
    trust.verify.return_value = False
    assert not callback(addon)(conn, None, 0, 0, 1)
    assert trust.verify.call_count == 2


@pytest.mark.parametrize("error", [9, 10, 62, 64])
def test_leaf_date_and_hostname_errors_cannot_be_overridden(error):
    trust = mock.Mock()
    trust.verify.return_value = True
    with mock.patch("app.addons.system_trust.macos_trust", return_value=trust):
        addon = MacOSSystemTrustAddon("")
    assert not callback(addon)(mock.Mock(), None, error, 0, 0)
    trust.verify.assert_not_called()


def test_native_verification_failure_is_closed():
    trust = mock.Mock()
    trust.verify.side_effect = OSError("Security framework unavailable")
    with mock.patch("app.addons.system_trust.macos_trust", return_value=trust):
        addon = MacOSSystemTrustAddon("")
    conn = mock.Mock()
    conn.get_peer_cert_chain.return_value = []
    assert not callback(addon)(conn, None, 0, 0, 1)
