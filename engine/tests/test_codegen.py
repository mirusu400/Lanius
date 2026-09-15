"""Tests for turning a captured request into runnable code.

The point of these is that the output is usable: a command that drops the
headers and body does not reproduce the request it came from, and a
redaction that misses a token is worse than none because it looks safe.
"""

from __future__ import annotations

import json

import pytest

from app import codegen
from app.codegen import RequestSpec


@pytest.fixture
def post() -> RequestSpec:
    return RequestSpec(
        method="POST",
        url="https://api.example.com/login?token=abc123&page=2",
        headers=[
            ("Host", "api.example.com"),
            ("Content-Type", "application/json"),
            ("Cookie", "session=s3cr3t; theme=dark"),
            ("Authorization", "Bearer eyJhbGciOi.payload.sig"),
            ("Content-Length", "31"),
        ],
        body='{"user":"alice","password":"hunter2"}',
    )


class TestCurl:
    def test_carries_the_headers_and_body(self, post: RequestSpec) -> None:
        """A command without them sends a different request."""
        command = codegen.as_curl(post)
        assert "-X POST" in command
        assert "Content-Type: application/json" in command
        assert '{"user":"alice","password":"hunter2"}' in command

    def test_leaves_out_headers_the_client_sets(self, post: RequestSpec) -> None:
        """A copied Content-Length goes stale as soon as the body is edited."""
        command = codegen.as_curl(post)
        assert "Content-Length" not in command
        assert "Host:" not in command

    def test_quotes_so_the_shell_does_not_split_the_url(self) -> None:
        spec = RequestSpec("GET", "https://x.test/a?b=1&c=2")
        assert "'https://x.test/a?b=1&c=2'" in codegen.as_curl(spec)

    def test_escapes_a_quote_in_the_body(self) -> None:
        spec = RequestSpec("POST", "https://x.test/", body="it's")
        command = codegen.as_curl(spec)
        assert "'\\''" in command


class TestFetch:
    def test_is_valid_json_in_the_options(self, post: RequestSpec) -> None:
        code = codegen.as_fetch(post)
        options = json.loads(code[code.index("{") : code.rindex("}") + 1])
        assert options["method"] == "POST"
        assert options["headers"]["Content-Type"] == "application/json"
        assert options["body"] == post.body

    def test_does_not_let_the_browser_add_its_own_cookies(
        self, post: RequestSpec
    ) -> None:
        """Cookies are in the headers; a second set would differ."""
        assert '"credentials": "omit"' in codegen.as_fetch(post)


class TestPython:
    def test_sends_json_as_json(self, post: RequestSpec) -> None:
        code = codegen.as_python_requests(post)
        assert "json=payload" in code
        assert '"password": "hunter2"' in code

    def test_json_literals_are_python_ones(self) -> None:
        spec = RequestSpec(
            "POST",
            "https://x.test/",
            [("Content-Type", "application/json")],
            '{"a":true,"b":false,"c":null}',
        )
        code = codegen.as_python_requests(spec)
        assert "True" in code and "False" in code and "None" in code
        assert "true" not in code and "null" not in code

    def test_a_non_json_body_is_sent_as_data(self) -> None:
        spec = RequestSpec(
            "POST",
            "https://x.test/",
            [("Content-Type", "application/x-www-form-urlencoded")],
            "a=1&b=2",
        )
        assert "data=" in codegen.as_python_requests(spec)

    def test_a_body_that_lies_about_being_json_still_produces_code(self) -> None:
        """A JSON content type with a broken body should not raise."""
        spec = RequestSpec(
            "POST", "https://x.test/", [("Content-Type", "application/json")], "{oops"
        )
        assert "data=" in codegen.as_python_requests(spec)

    def test_korean_survives(self) -> None:
        spec = RequestSpec("POST", "https://x.test/", body="한글 본문")
        assert "한글 본문" in codegen.as_python_requests(spec)


class TestRedaction:
    def test_hides_the_bearer_token_but_keeps_the_scheme(
        self, post: RequestSpec
    ) -> None:
        """Knowing it was a bearer token is the useful part."""
        code = codegen.as_python_requests(codegen.redacted(post))
        assert "Bearer [redacted]" in code
        assert "eyJhbGciOi" not in code

    def test_hides_a_session_cookie_and_keeps_a_harmless_one(
        self, post: RequestSpec
    ) -> None:
        """Redacting theme=dark protects nothing and hurts readability."""
        value = codegen.redact_value("Cookie", "session=s3cr3t; theme=dark")
        assert value == "session=[redacted]; theme=dark"

    def test_hides_a_token_whose_name_gives_nothing_away(self) -> None:
        """Session cookies are often named 's' or '_id'."""
        value = codegen.redact_value("Cookie", "s=aB3xY9kLmNpQrStUvWxYz012345; lang=ko")
        assert value == "s=[redacted]; lang=ko"

    def test_hides_a_token_in_the_query_string(self, post: RequestSpec) -> None:
        url = codegen.redact_query(post.url)
        assert "token=[redacted]" in url
        assert "page=2" in url
        assert "abc123" not in url

    def test_hides_a_password_in_a_json_body(self, post: RequestSpec) -> None:
        spec = codegen.redacted(post)
        assert "hunter2" not in spec.body
        assert "alice" in spec.body

    def test_hides_a_password_in_a_form_body(self) -> None:
        spec = RequestSpec(
            "POST",
            "https://x.test/",
            [("Content-Type", "application/x-www-form-urlencoded")],
            "user=alice&password=hunter2",
        )
        redacted = codegen.redacted(spec)
        assert "hunter2" not in redacted.body
        assert "user=alice" in redacted.body

    def test_leaves_a_body_it_does_not_understand_alone(self) -> None:
        """A half-redacted body is worse than an obviously untouched one."""
        spec = RequestSpec(
            "POST", "https://x.test/", [("Content-Type", "text/xml")], "<a>secret</a>"
        )
        assert codegen.redacted(spec).body == "<a>secret</a>"

    def test_the_plain_python_output_is_not_redacted(self, post: RequestSpec) -> None:
        """Redaction is a separate choice; the default reproduces the request."""
        assert "hunter2" in codegen.as_python_requests(post)


class TestWhatCountsAsASecret:
    """A fixed list of header names is always out of date.

    These names came off real captured traffic, where an API key sat in
    the 'redacted' output because nobody had listed x-goog-api-key.
    """

    @pytest.mark.parametrize(
        "name",
        [
            "authorization",
            "cookie",
            "x-api-key",
            "x-goog-api-key",
            "x-browser-validation",
            "x-csrf-token",
            "proxy-authorization",
            "x-session-token",
            "x-amz-security-token",
            "x-signature",
        ],
    )
    def test_is_hidden(self, name: str) -> None:
        assert codegen.is_secret_header(name) is True

    @pytest.mark.parametrize(
        "name",
        [
            "user-agent",
            "content-type",
            "accept",
            "accept-language",
            "origin",
            "referer",
            "sec-ch-ua",
            "x-client-data",
            "sec-fetch-storage-access",
            "host",
        ],
    )
    def test_is_kept(self, name: str) -> None:
        """Hiding these makes the request harder to reproduce for no gain."""
        assert codegen.is_secret_header(name) is False

    def test_an_unknown_key_header_is_hidden(self) -> None:
        """An internal service will carry something nobody listed."""
        assert codegen.is_secret_header("x-acme-internal-api-key") is True

    def test_redaction_uses_it(self) -> None:
        spec = RequestSpec(
            "GET", "https://x.test/", [("X-Goog-Api-Key", "AIzaSyCbsbvGCe")]
        )
        text = codegen.as_python_requests(codegen.redacted(spec))
        assert "AIzaSyCbsbvGCe" not in text
        assert "[redacted]" in text


class TestCsrf:
    def test_builds_a_self_submitting_form(self) -> None:
        spec = RequestSpec(
            "POST",
            "https://bank.test/transfer",
            [("Content-Type", "application/x-www-form-urlencoded")],
            "to=attacker&amount=1000",
        )
        html = codegen.as_csrf_html(spec)
        assert 'name="to" value="attacker"' in html
        assert "submit()" in html

    def test_escapes_a_value_that_would_break_out_of_the_attribute(self) -> None:
        spec = RequestSpec(
            "POST",
            "https://bank.test/x",
            [("Content-Type", "application/x-www-form-urlencoded")],
            'note="><script>alert(1)</script>',
        )
        html = codegen.as_csrf_html(spec)
        assert "<script>alert(1)</script>" not in html
        assert "&quot;" in html

    def test_refuses_when_a_form_cannot_send_the_content_type(self) -> None:
        spec = RequestSpec(
            "POST", "https://api.test/x", [("Content-Type", "application/json")], "{}"
        )
        html = codegen.as_csrf_html(spec)
        assert "cannot be forged" in html
        assert "application/json" in html
        assert "<form" not in html

    def test_refuses_when_the_request_needs_a_custom_header(self) -> None:
        spec = RequestSpec(
            "POST",
            "https://api.test/x",
            [
                ("Content-Type", "application/x-www-form-urlencoded"),
                ("X-Requested-With", "XMLHttpRequest"),
            ],
            "a=1",
        )
        assert "X-Requested-With" in codegen.as_csrf_html(spec)
        assert "<form" not in codegen.as_csrf_html(spec)

    def test_refuses_a_method_a_form_cannot_send(self) -> None:
        spec = RequestSpec("DELETE", "https://api.test/account/7")
        assert "DELETE cannot be sent" in codegen.as_csrf_html(spec)

    def test_a_get_takes_its_fields_from_the_query_string(self) -> None:
        """A GET form puts the query in the fields; leaving it in the
        action as well would send it twice."""
        spec = RequestSpec("GET", "https://bank.test/transfer?to=attacker")
        html = codegen.as_csrf_html(spec)
        assert 'action="https://bank.test/transfer"' in html
        assert 'name="to" value="attacker"' in html

    def test_a_cookie_does_not_block_forgery(self) -> None:
        """Cookies are the whole premise: the browser sends them itself."""
        spec = RequestSpec(
            "POST",
            "https://bank.test/x",
            [
                ("Content-Type", "application/x-www-form-urlencoded"),
                ("Cookie", "session=abc"),
            ],
            "a=1",
        )
        assert "<form" in codegen.as_csrf_html(spec)


class TestFormatRegistry:
    def test_an_unknown_format_is_refused(self) -> None:
        with pytest.raises(ValueError):
            codegen.generate("perl", RequestSpec("GET", "https://x.test/"))

    def test_a_plugin_can_add_a_format(self) -> None:
        codegen.register_format("demo", "shout", "Shout", lambda s: s.url.upper())
        try:
            assert (
                codegen.generate("shout", RequestSpec("GET", "https://x.test/"))
                == "HTTPS://X.TEST/"
            )
            assert any(f["kind"] == "shout" for f in codegen.available_formats())
        finally:
            codegen.unregister_owner("demo")

    def test_unloading_a_plugin_takes_its_formats_away(self) -> None:
        codegen.register_format("demo", "shout", "Shout", lambda s: s.url)
        codegen.unregister_owner("demo")
        assert not any(f["kind"] == "shout" for f in codegen.available_formats())
        with pytest.raises(ValueError):
            codegen.generate("shout", RequestSpec("GET", "https://x.test/"))

    def test_a_plugin_cannot_replace_a_built_in(self) -> None:
        """Otherwise enabling a plugin could quietly change what curl means."""
        with pytest.raises(ValueError):
            codegen.register_format("demo", "curl", "Mine", lambda s: "")

    def test_formats_say_where_they_came_from(self) -> None:
        codegen.register_format("demo", "shout", "Shout", lambda s: s.url)
        try:
            entry = next(
                f for f in codegen.available_formats() if f["kind"] == "shout"
            )
            assert entry["source"] == "demo"
        finally:
            codegen.unregister_owner("demo")
