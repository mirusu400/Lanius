"""Test sites that speak one charset each.

Built to answer a specific question: does Lanius carry Korean and other
non-ASCII text through Repeater, Intruder and Intercept without mangling
it, when the site is not UTF-8?

Each route echoes back what it received, decoded with its own charset, so
a mismatch shows up as mojibake in the response rather than silently
passing.
"""

from __future__ import annotations

import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote_to_bytes

# The charset each path insists on. A real EUC-KR site will not accept
# UTF-8 bytes, and vice versa.
ROUTES = {
    "/euckr": "euc-kr",
    "/utf8": "utf-8",
    "/utf16": "utf-16",
    "/sjis": "shift_jis",
}

# Per charset, because they do not cover the same characters: EUC-KR has
# no kana, Shift_JIS has only a subset of Hangul, and a site that cannot
# encode its own sample would fail for the wrong reason.
SAMPLES = {
    "euc-kr": "한글 테스트 가나다 ①",
    "utf-8": "한글 테스트 ✓ 日本語 🎯",
    "utf-16": "한글 테스트 ✓ 日本語 🎯",
    "shift_jis": "日本語テスト カタカナ",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # quiet
        pass

    def _charset(self) -> str | None:
        path = self.path.split("?")[0]
        return ROUTES.get(path)

    def _send(self, body: str, charset: str, status: int = 200) -> None:
        encoded = body.encode(charset)
        self.send_response(status)
        self.send_header("Content-Type", f"text/html; charset={charset}")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        charset = self._charset()
        if charset is None:
            if self.path.split("?")[0] == "/multi":
                # Offers several, picks by Accept-Charset, and says which.
                accept = self.headers.get("Accept-Charset", "utf-8")
                chosen = next(
                    (c for c in ("euc-kr", "utf-16", "utf-8") if c in accept.lower()),
                    "utf-8",
                )
                self._send(f"<p>{SAMPLES[chosen]}</p><p>chosen={chosen}</p>", chosen)
                return
            self.send_error(404)
            return

        # Query strings are bytes on the wire; decode with our charset.
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        received = ""
        if query:
            for pair in query.split("&"):
                if pair.startswith("q="):
                    raw = unquote_to_bytes(pair[2:])
                    try:
                        received = raw.decode(charset)
                    except UnicodeDecodeError:
                        received = f"[undecodable as {charset}: {raw!r}]"
        self._send(
            f"<h1>{charset}</h1><p>sample={SAMPLES[charset]}</p>"
            f"<p>received={received}</p>",
            charset,
        )

    def do_POST(self) -> None:  # noqa: N802
        charset = self._charset()
        if charset is None:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""

        # Form bodies are percent-encoded bytes; anything else is raw.
        # parse_qs would decode as text and lose the original bytes, so
        # split by hand and unquote to bytes.
        if raw.startswith(b"q="):
            data = unquote_to_bytes(raw[2:].split(b"&")[0].replace(b"+", b" "))
        else:
            data = raw

        try:
            received = data.decode(charset)
            verdict = "ok"
        except UnicodeDecodeError as exc:
            received = repr(data)
            verdict = f"not valid {charset}: {exc.reason}"

        # Echo the exact bytes too, so a caller can prove what arrived
        # rather than trusting this server's own decoding.
        hexed = data.hex()

        self._send(
            f"<h1>{charset}</h1><p>received={received}</p>"
            f"<p>verdict={verdict}</p><p>hex={hexed}</p>",
            charset,
        )


def serve(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18400
    serve(port)
    print(f"charset test server on http://127.0.0.1:{port}", flush=True)
    print("  /euckr /utf8 /utf16 /sjis /multi", flush=True)
    threading.Event().wait()
