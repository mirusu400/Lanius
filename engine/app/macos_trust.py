"""Offline TLS server verification using macOS Keychain trust decisions.

Use SecTrust rather than exporting every Keychain certificate: an installed
certificate is not necessarily trusted, and trust can be denied or restricted
to a policy, host or application. No intermediate/OCSP/CRL downloads are allowed
here, including outside Lockdown Mode.
"""

from __future__ import annotations

import ctypes
from functools import lru_cache
from typing import Any


class MacOSTrust:
    def __init__(self) -> None:
        self.security = ctypes.CDLL(
            "/System/Library/Frameworks/Security.framework/Security"
        )
        self.cf = ctypes.CDLL(
            "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
        )
        ref = ctypes.c_void_p
        size = ctypes.c_long
        boolean = ctypes.c_ubyte
        status = ctypes.c_int32
        signatures = (
            (self.cf, "CFRelease", None, [ref]),
            (self.cf, "CFDataCreate", ref, [ref, ctypes.c_char_p, size]),
            (self.cf, "CFStringCreateWithCString", ref, [ref, ctypes.c_char_p, ctypes.c_uint32]),
            (self.cf, "CFArrayCreate", ref, [ref, ctypes.POINTER(ref), size, ref]),
            (self.security, "SecCertificateCreateWithData", ref, [ref, ref]),
            (self.security, "SecPolicyCreateSSL", ref, [boolean, ref]),
            (self.security, "SecPolicyCreateRevocation", ref, [ctypes.c_ulong]),
            (self.security, "SecTrustCreateWithCertificates", status, [ref, ref, ctypes.POINTER(ref)]),
            (self.security, "SecTrustSetNetworkFetchAllowed", status, [ref, boolean]),
            (self.security, "SecTrustSetAnchorCertificates", status, [ref, ref]),
            (self.security, "SecTrustSetAnchorCertificatesOnly", status, [ref, boolean]),
        )
        for library, name, result, args in signatures:
            function = getattr(library, name)
            function.restype = result
            function.argtypes = args
        self.evaluate_with_error = getattr(self.security, "SecTrustEvaluateWithError", None)
        if self.evaluate_with_error is not None:
            self.evaluate_with_error.restype = boolean
            self.evaluate_with_error.argtypes = [ref, ctypes.POINTER(ref)]
        else:  # macOS 10.13
            self.security.SecTrustEvaluate.restype = status
            self.security.SecTrustEvaluate.argtypes = [ref, ctypes.POINTER(ctypes.c_uint32)]

    def verify(self, chain: list[bytes], hostname: str, anchors: tuple[bytes, ...] = ()) -> bool:
        if not chain or not hostname or "\x00" in hostname:
            return False
        owned: list[Any] = []

        def own(value: Any) -> Any:
            if not value:
                raise OSError("macOS could not create a certificate trust object")
            owned.append(value)
            return value

        def check(status: int) -> None:
            if status:
                raise OSError(f"macOS certificate trust operation failed ({status})")

        def array(values: list[Any]) -> Any:
            # No callbacks: the objects stay alive in 'owned' until evaluation
            # finishes. Release arrays before the objects they reference.
            refs = (ctypes.c_void_p * len(values))(*values)
            return own(self.cf.CFArrayCreate(None, refs, len(values), None))

        def certificates(values: list[bytes] | tuple[bytes, ...]) -> Any:
            refs = []
            for der in values:
                data = own(self.cf.CFDataCreate(None, der, len(der)))
                refs.append(own(self.security.SecCertificateCreateWithData(None, data)))
            return array(refs)

        trust = ctypes.c_void_p()
        error = ctypes.c_void_p()
        try:
            name = own(self.cf.CFStringCreateWithCString(
                None, hostname.encode("idna"), 0x08000100  # UTF-8
            ))
            ssl_policy = own(self.security.SecPolicyCreateSSL(True, name))
            # Cached revocation responses may be checked, but this must not
            # create outbound requests that bypass the scope/Lockdown guards.
            revocation_policy = own(self.security.SecPolicyCreateRevocation(
                (1 << 0) | (1 << 1) | (1 << 4)  # OCSP | CRL | network disabled
            ))
            policies = array([ssl_policy, revocation_policy])
            certs = certificates(chain)
            check(self.security.SecTrustCreateWithCertificates(certs, policies, ctypes.byref(trust)))
            if anchors:
                check(self.security.SecTrustSetAnchorCertificates(trust, certificates(anchors)))
                check(self.security.SecTrustSetAnchorCertificatesOnly(trust, False))
            check(self.security.SecTrustSetNetworkFetchAllowed(trust, False))
            if self.evaluate_with_error is not None:
                return bool(self.evaluate_with_error(trust, ctypes.byref(error)))
            result = ctypes.c_uint32()
            check(self.security.SecTrustEvaluate(trust, ctypes.byref(result)))
            return result.value in (1, 4)  # Proceed or Unspecified (trusted)
        finally:
            if error:
                self.cf.CFRelease(error)
            if trust:
                self.cf.CFRelease(trust)
            for value in reversed(owned):
                self.cf.CFRelease(value)


@lru_cache(maxsize=1)
def macos_trust() -> MacOSTrust:
    return MacOSTrust()
