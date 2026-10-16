from __future__ import annotations

import base64
import json
import socket

import pytest
from fastapi.testclient import TestClient

from app import inspector
from app.api.server import create_app
from app.config import Settings
from app.db.store import FlowRecord, FlowStore
from app.inspector import Context, InspectError


def inspect(value: str, **kwargs) -> dict:
    charset = kwargs.pop("charset", None)
    return inspector.inspect(value, Context(**kwargs), charset)


def write(value: str, text: str, **kwargs) -> str:
    charset = kwargs.pop("charset", None)
    return inspector.write(value, text, Context(**kwargs), charset)


def kinds(result: dict) -> list[str]:
    return [layer["kind"] for layer in result["layers"]]


# --- charsets ----------------------------------------------------------


def test_percent_encoded_euc_kr_is_read_as_text_not_bytes() -> None:
    result = inspect("%C8%AB%B1%E6%B5%BF")

    assert result["text"] == "홍길동"
    assert kinds(result) == ["url", "charset"]
    assert result["charset"]["name"] == "cp949"


@pytest.mark.parametrize(
    ("text", "codec", "expected"),
    [
        ("こんにちは", "cp932", "cp932"),
        ("中华人民共和国", "gb18030", "gb18030"),
        ("中華民國", "cp950", "cp950"),
        ("Москва", "cp1251", "cp1251"),
        ("Москва", "koi8_r", "koi8-r"),
        ("naïve résumé", "cp1252", "cp1252"),
        ("서울특별시 강남구", "cp949", "cp949"),
    ],
)
def test_legacy_charsets_are_detected_without_any_context(text, codec, expected) -> None:
    from urllib.parse import quote_from_bytes

    result = inspect(quote_from_bytes(text.encode(codec)))

    assert result["text"] == text
    assert result["charset"]["name"] == expected


def test_utf8_wins_when_the_bytes_are_valid_utf8() -> None:
    result = inspect("%ED%95%98%EB%82%98")

    assert result["text"] == "하나"
    assert result["charset"]["name"] == "utf-8"
    assert result["charset"]["confidence"] == "high"
    assert {"code": "utf8_valid"} in result["charset"]["reasons"]


def test_ambiguous_short_value_offers_alternatives_with_low_confidence() -> None:
    # Two bytes that are a common Hangul syllable and a common hanzi alike.
    result = inspect("%C7%CF")

    names = [c["name"] for c in result["charset"]["candidates"]]
    assert len(names) > 1
    assert result["charset"]["confidence"] != "high"


def test_content_type_charset_is_preferred() -> None:
    request = "POST /s HTTP/1.1\nHost: example.com\nContent-Type: application/x-www-form-urlencoded; charset=Shift_JIS\n\nq=%93%8C%8B%9E"

    result = inspect("%93%8C%8B%9E", request=request, form=True)

    assert result["text"] == "東京"
    assert result["charset"]["name"] == "cp932"
    assert any(r["code"] == "content_type" for r in result["charset"]["reasons"])


def test_referer_page_charset_decides_an_ambiguous_value() -> None:
    request = "GET /search?q=%C7%CF HTTP/1.1\nHost: example.com\nReferer: https://example.com/form\n\n"
    asked = []

    def page_charset(url: str) -> str | None:
        asked.append(url)
        return "gb18030"

    result = inspect("%C7%CF", request=request, referer_charset=page_charset)

    assert asked == ["https://example.com/form"]
    assert result["charset"]["name"] == "gb18030"
    assert any(r["code"] == "referer" for r in result["charset"]["reasons"])


def test_other_parameters_in_the_request_inform_a_short_one() -> None:
    from urllib.parse import quote_from_bytes

    long_value = quote_from_bytes("日本語のテキストを検索します".encode("cp932"))
    short_value = quote_from_bytes("東京".encode("cp932"))
    request = f"GET /s?a={long_value}&b={short_value} HTTP/1.1\nHost: example.com\n\n"

    result = inspect(short_value, request=request)

    assert result["charset"]["name"] == "cp932"
    assert any(r["code"] == "request" for r in result["charset"]["reasons"])


def test_country_tld_and_locale_break_ties() -> None:
    # "大" in GB18030 and "댕" in CP949: both read as ordinary text.
    value = "%B4%F3"
    korean = "GET /?q=%B4%F3 HTTP/1.1\nHost: shop.example.kr\n\n"
    chinese = "GET /?q=%B4%F3 HTTP/1.1\nHost: shop.example.cn\n\n"

    assert inspect(value, request=korean)["charset"]["name"] == "cp949"
    assert inspect(value, request=chinese)["charset"]["name"] == "gb18030"
    assert inspect(value, locale="zh-CN")["charset"]["name"] == "gb18030"
    assert inspect(value, locale="ko-KR")["charset"]["name"] == "cp949"


def test_a_declared_charset_that_yields_nonsense_does_not_win() -> None:
    from urllib.parse import quote_from_bytes

    value = quote_from_bytes("안녕하세요 반갑습니다".encode("cp949"))
    request = "POST / HTTP/1.1\nContent-Type: text/plain; charset=koi8-r\n\n"

    assert inspect(value, request=request)["charset"]["name"] == "cp949"


def test_manual_charset_overrides_detection() -> None:
    result = inspect("%C7%CF", charset="cp950")

    assert result["charset"]["name"] == "cp950"
    assert result["text"] == bytes.fromhex("c7cf").decode("cp950")
    assert result["charset"]["confidence"] == "high"


# --- layers and re-encoding ----------------------------------------------


def test_unchanged_text_returns_the_original_byte_for_byte() -> None:
    value = "%c8%ab%b1%e6%b5%bf"

    assert write(value, "홍길동") == value


def test_edit_is_encoded_in_the_detected_charset_and_original_style() -> None:
    assert write("%c8%ab%b1%e6%b5%bf", "김철수") == "%b1%e8%c3%b6%bc%f6"
    assert write("%C8%AB%B1%E6%B5%BF", "김철수") == "%B1%E8%C3%B6%BC%F6"


def test_form_values_keep_plus_for_space_and_literal_characters() -> None:
    value = "%ED%99%8D+%EA%B8%B8%EB%8F%99-1"
    read = inspect(value, form=True)
    assert read["text"] == "홍 길동-1"

    assert write(value, "김 철수-2", form=True) == "%EA%B9%80+%EC%B2%A0%EC%88%98-2"


def test_reserved_characters_added_by_an_edit_are_encoded() -> None:
    assert write("%ED%95%98", "a&b=c#d%") == "a%26b%3Dc%23d%25"


def test_a_selected_query_string_keeps_its_separators() -> None:
    value = "a=%ED%95%98&b=1"
    assert inspect(value)["text"] == "a=하&b=1"
    assert write(value, "a=나&b=2") == "a=%EB%82%98&b=2"


def test_base64_inside_url_encoding_is_peeled_and_rewrapped() -> None:
    inner = base64.b64encode("관리자1".encode()).decode()
    assert inner.endswith("=")
    value = inner.replace("=", "%3D").replace("+", "%2B").replace("/", "%2F")

    result = inspect(value)
    assert result["text"] == "관리자1"
    assert kinds(result)[:2] == ["url", "base64"]

    rewritten = write(value, "사용자")
    from urllib.parse import unquote

    assert base64.b64decode(unquote(rewritten)).decode() == "사용자"


def test_double_url_encoding() -> None:
    result = inspect("%25ED%2595%2598")

    assert result["text"] == "하"
    assert kinds(result) == ["url", "url", "charset"]
    assert write("%25ED%2595%2598", "나") == "%25EB%2582%2598"


@pytest.mark.parametrize("word", ["username", "test", "abcd", "deadbeef", "1234", "password1"])
def test_ordinary_words_are_not_mistaken_for_base64_or_hex(word: str) -> None:
    result = inspect(word)

    assert result["layers"] == []
    assert result["text"] == word
    assert result["editable"] is False


def test_hex_dump_bytes_are_read_as_text() -> None:
    # What Burp shows for URL-encoded UTF-8: the bytes, not the text.
    result = inspect("ed 95 98 eb 82 98")

    assert result["text"] == "하나"
    assert kinds(result) == ["hex", "charset"]
    assert write("ed 95 98 eb 82 98", "한글") == "ed 95 9c ea b8 80"


def test_unicode_escapes() -> None:
    value = "\\uD55C\\uAE00 ok"

    assert inspect(value)["text"] == "한글 ok"
    assert write(value, "하나 ok") == "\\uD558\\uB098 ok"
    assert write(value, "😀") == "\\uD83D\\uDE00"


def test_byte_escapes_go_through_charset_detection() -> None:
    value = "\\xc8\\xab\\xb1\\xe6\\xb5\\xbf"

    result = inspect(value)
    assert result["text"] == "홍길동"
    assert kinds(result) == ["bytes_escape", "charset"]
    assert write(value, "김철수") == "\\xb1\\xe8\\xc3\\xb6\\xbc\\xf6"


def test_html_entities() -> None:
    value = "&#54620;&#44544; &amp; more"

    assert inspect(value)["text"] == "한글 & more"
    assert write(value, "하나 & <b>") == "&#54616;&#45208; &amp; &lt;b&gt;"


def test_jwt_is_decoded_and_resigned_with_the_original_signature() -> None:
    def seg(obj) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    token = f"{seg({'alg': 'HS256'})}.{seg({'sub': 'user', 'name': '홍길동'})}.sig"

    result = inspect(token)
    assert kinds(result) == ["jwt"]
    parsed = json.loads(result["text"])
    assert parsed["payload"]["name"] == "홍길동"

    parsed["payload"]["sub"] = "admin"
    rewritten = write(token, json.dumps(parsed))
    header, payload, signature = rewritten.split(".")
    assert signature == "sig"
    assert json.loads(base64.urlsafe_b64decode(payload + "==")) == {"sub": "admin", "name": "홍길동"}


def test_gzip_inside_base64() -> None:
    import gzip

    value = base64.b64encode(gzip.compress("압축된 값".encode(), mtime=0)).decode()

    result = inspect(value)
    assert result["text"] == "압축된 값"
    assert kinds(result) == ["base64", "gzip", "charset"]
    rewritten = write(value, "바뀐 값")
    assert gzip.decompress(base64.b64decode(rewritten)).decode() == "바뀐 값"


def test_characters_the_charset_cannot_hold_are_refused_not_mangled() -> None:
    with pytest.raises(InspectError, match="CHARSET_UNENCODABLE"):
        write("%C8%AB%B1%E6%B5%BF", "홍길동😀")


def test_binary_is_shown_as_a_hex_dump_and_not_editable() -> None:
    result = inspect("%00%01%02%FF%FE")

    assert result["text"] is None
    assert result["editable"] is False
    assert result["hex"].startswith("00000000  00 01 02 ff fe")


# --- store and API ------------------------------------------------------


def test_page_charset_reads_the_captured_page(tmp_path) -> None:
    store = FlowStore(tmp_path / "flows.sqlite")
    store.upsert(
        FlowRecord(
            id="page",
            scheme="https",
            host="example.com",
            port=443,
            path="/form",
            query="",
            started_at=1,
            status_code=200,
            response_headers=[("Content-Type", "text/html; charset=Shift_JIS")],
            response_body=b"<html></html>",
        )
    )

    assert store.page_charset("https://example.com/form") == "shift_jis"
    assert store.page_charset("https://example.com/form?x=1") == "shift_jis"
    assert store.page_charset("https://example.com/other") is None
    assert store.page_charset("not a url") is None


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path,
        db_path=tmp_path / "inspect.sqlite",
        confdir=tmp_path / "mitm",
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_inspect_endpoints_round_trip(client) -> None:
    read = client.post("/api/inspect", json={"value": "%C8%AB%B1%E6%B5%BF"}).json()
    assert read["text"] == "홍길동"

    applied = client.post(
        "/api/inspect/apply",
        json={"value": "%C8%AB%B1%E6%B5%BF", "text": "김철수", "charset": read["charset"]["name"]},
    ).json()
    assert applied == {"value": "%B1%E8%C3%B6%BC%F6"}


def test_inspect_apply_reports_unencodable_text(client) -> None:
    res = client.post(
        "/api/inspect/apply",
        json={"value": "%C8%AB%B1%E6%B5%BF", "text": "😀", "charset": "cp949"},
    )

    assert res.status_code == 400
    assert res.json()["detail"].startswith("CHARSET_UNENCODABLE")


def test_inspect_rejects_huge_values(client) -> None:
    res = client.post("/api/inspect", json={"value": "a" * (inspector_limit() + 1)})

    assert res.status_code == 413


def inspector_limit() -> int:
    from app.api.server import INSPECT_LIMIT

    return INSPECT_LIMIT
