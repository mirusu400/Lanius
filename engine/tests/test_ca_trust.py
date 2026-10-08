"""Windows client trust diagnostics use local stores, never a test website."""

from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app import ca_trust


def certificate(*, expired=False):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "mitmproxy")])
    now = datetime.now(timezone.utc)
    return (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=2))
        .not_valid_after(now + timedelta(days=-1 if expired else 1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )


@pytest.fixture
def current_ca(tmp_path):
    cert = certificate()
    (tmp_path / "mitmproxy-ca-cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert.public_bytes(serialization.Encoding.DER)


def inspect(tmp_path, roots, disallowed=()):
    with mock.patch.object(ca_trust.platform, "system", return_value="Windows"):
        with mock.patch.object(ca_trust.ssl, "enum_certificates", create=True) as enum:
            enum.side_effect = lambda store: {"ROOT": roots, "Disallowed": disallowed}[store]
            result = ca_trust.system_trust(tmp_path)
            assert enum.call_args_list == [mock.call("Disallowed"), mock.call("ROOT")]
            return result


@pytest.mark.parametrize("purpose", [True, {ca_trust.SERVER_AUTH}])
def test_installed_current_ca_is_trusted_for_https(tmp_path, current_ca, purpose):
    result = inspect(tmp_path, [(current_ca, "x509_asn", purpose)])
    assert result["status"] == "trusted"
    assert result["platform"] == "Windows"
    assert len(result["fingerprint_sha256"]) == 64


def test_old_ca_with_the_same_subject_does_not_match(tmp_path, current_ca):
    old = certificate().public_bytes(serialization.Encoding.DER)
    assert old != current_ca
    assert inspect(tmp_path, [(old, "x509_asn", True)])["status"] == "not_trusted"


@pytest.mark.parametrize("roots", [[], [("current", "x509_asn", set())], [("current", "x509_asn", {"1.3.6.1.5.5.7.3.2"})], [("current", "pkcs_7_asn", True)]])
def test_missing_or_wrong_purpose_ca_is_not_trusted(tmp_path, current_ca, roots):
    roots = [(current_ca if data == "current" else data, encoding, purpose) for data, encoding, purpose in roots]
    assert inspect(tmp_path, roots)["status"] == "not_trusted"


def test_explicit_distrust_wins_over_root_installation(tmp_path, current_ca):
    cert = (current_ca, "x509_asn", True)
    with mock.patch.object(ca_trust.platform, "system", return_value="Windows"):
        with mock.patch.object(ca_trust.ssl, "enum_certificates", create=True, return_value=[cert]):
            assert ca_trust.system_trust(tmp_path)["status"] == "not_trusted"


@pytest.mark.parametrize("failed_store", ["Disallowed", "ROOT"])
def test_store_access_failure_is_unknown_not_an_untrusted_certificate(tmp_path, current_ca, failed_store):
    def enum(store):
        if store == failed_store:
            raise PermissionError("store denied")
        return []

    with mock.patch.object(ca_trust.platform, "system", return_value="Windows"):
        with mock.patch.object(ca_trust.ssl, "enum_certificates", create=True, side_effect=enum):
            result = ca_trust.system_trust(tmp_path)
    assert result["status"] == "unknown"
    assert result["detail"] == "store denied"


def test_other_platforms_do_not_inspect_windows_stores(tmp_path, current_ca):
    with mock.patch.object(ca_trust.platform, "system", return_value="Darwin"):
        with mock.patch.object(ca_trust.ssl, "enum_certificates", create=True) as enum:
            assert ca_trust.system_trust(tmp_path)["status"] == "unsupported"
            enum.assert_not_called()


@pytest.mark.parametrize("contents", [b"not a certificate", b""])
def test_invalid_ca_is_reported_without_querying_stores(tmp_path, contents):
    (tmp_path / "mitmproxy-ca-cert.pem").write_bytes(contents)
    with mock.patch.object(ca_trust.ssl, "enum_certificates", create=True) as enum:
        assert ca_trust.system_trust(tmp_path)["status"] == "invalid"
        enum.assert_not_called()


def test_expired_ca_is_not_reported_as_ready(tmp_path):
    cert = certificate(expired=True)
    (tmp_path / "mitmproxy-ca-cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    assert ca_trust.system_trust(tmp_path)["status"] == "invalid"
