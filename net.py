"""HTTPS requests that still work on PCs where Python can't verify a site's certificate.

Python checks certificates against the roots already sitting in Windows' certificate store, but
Windows only downloads many root certificates the first time something asks for them. A PC that
hasn't visited the site in a browser can therefore fail with "CERTIFICATE_VERIFY_FAILED ... unable
to get local issuer certificate" (seen on a second PC, Oct 2026).

When that happens we retry with:
  1. truststore - asks Windows itself to check the certificate, the same way the browser does
     (installed automatically the first time it's needed; pip has its own certificates, so it works);
  2. certifi - Mozilla's list of root certificates, if it's installed.
Certificates are always checked; nothing here turns checking off.
"""
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

_ctx = None            # the SSL setup that worked last time (None = Python's default)
_tried_install = False


def _is_cert_error(e):
    reason = getattr(e, "reason", e)
    return isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason)


def _truststore_ctx():
    import truststore
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


def _certifi_ctx():
    import certifi
    return ssl.create_default_context(cafile=certifi.where())


def _install_truststore():
    global _tried_install
    if _tried_install:
        return False
    _tried_install = True
    print("Fixing the secure connection (one-time): installing truststore...")
    try:
        subprocess.call([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "truststore"])
    except Exception:
        return False
    try:
        import importlib
        importlib.invalidate_caches()
        _truststore_ctx()
        return True
    except Exception:
        return False


def urlopen(req, timeout):
    """urllib.request.urlopen, retrying with Windows' own certificate check if Python's fails."""
    global _ctx
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=_ctx)
    except urllib.error.URLError as e:
        if not _is_cert_error(e):
            raise
        first = e
    for make in (_truststore_ctx, _certifi_ctx, "install", _truststore_ctx):
        if make == "install":
            if not _install_truststore():
                break
            continue
        try:
            ctx = make()
        except Exception:
            continue
        try:
            r = urllib.request.urlopen(req, timeout=timeout, context=ctx)
        except urllib.error.URLError as e:
            if _is_cert_error(e):
                continue
            raise
        _ctx = ctx
        return r
    raise first
