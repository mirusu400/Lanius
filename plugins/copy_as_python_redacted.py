"""Example plugin: copy a request as Python with the credentials removed.

Sharing a request in a ticket or a report means handing over whatever it
was carrying: the session cookie, the bearer token, the API key. This
adds a menu entry that produces the same Python as the built-in one, with
those values replaced by ``[redacted]``.

It is also the smallest example of a plugin that adds a menu entry rather
than touching traffic: declare ``codegen_formats`` and the entry appears
in the right-click menu of Repeater, Intruder and the history, with no UI
code here.

Copy this file into your plugins directory (default ``~/.lanius/plugins``)
and enable it from the Plugins tab.
"""

from app.codegen import RequestSpec, as_python_requests, redacted

DESCRIPTION = "인증 정보를 [redacted]로 가린 Python 코드로 복사"
VERSION = "1.0.0"
AUTHOR = "Lanius"


def python_redacted(spec: RequestSpec) -> str:
    """Python for this request, with its secrets taken out.

    Cookie names, the auth scheme and the shape of the body are kept,
    because a request stripped down to nothing is not worth sharing. Only
    the values that authenticate someone are replaced.
    """
    return as_python_requests(redacted(spec))


class Plugin:
    """Contributes one entry to the copy-as menus."""

    codegen_formats = {
        "python-redacted": ("Python requests (redacted)", python_redacted),
    }
