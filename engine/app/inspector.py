"""Read a selected value through its layers of encoding, and write it back.

A value in a request is often wrapped several times: a Base64 token inside
a URL-encoded parameter, or text in a legacy charset that was then
percent-encoded. The Inspector peels those layers off automatically so the
value can be read and edited as text, then wraps an edited value back up in
the same layers and the same style, so only what was changed changes.

The hard part is the charset. Percent-decoding yields bytes, and a short
run of bytes is often valid in several charsets. Statistics on the bytes
alone are unreliable at the length of a parameter, so the guess combines
what the bytes can be with what the request says about itself: its
Content-Type, the charset of the page it was sent from (browsers encode a
form in the charset of the page holding it), the other parameters in the
same request, and the user's own earlier choice for the host.
"""

from __future__ import annotations

import base64
import binascii
import gzip
import html
import json
import re
import unicodedata
import urllib.parse
import zlib
from dataclasses import dataclass, field
from typing import Any, Callable

from . import charset as charset_module


class InspectError(Exception):
    """The value cannot be written back as asked (mapped to HTTP 400)."""


# --- charsets ---------------------------------------------------------

# Candidates for detection, by Python codec name. The Windows supersets are
# used because they decode everything their standard counterparts do, and
# encode those characters to the same bytes.
CANDIDATES: dict[str, str] = {
    "utf-8": "UTF-8",
    "cp949": "EUC-KR / CP949",
    "cp932": "Shift_JIS / CP932",
    "euc_jp": "EUC-JP",
    "gb18030": "GB18030 / GBK",
    "cp950": "Big5 / CP950",
    "cp1251": "Windows-1251",
    "koi8-r": "KOI8-R",
    "cp1252": "Windows-1252 / Latin-1",
}

_LEGACY = ("cp949", "cp932", "gb18030", "cp950", "cp1251", "cp1252")

# How common each charset is on the web, used only to break ties that
# nothing else breaks. Small on purpose.
_USAGE_PRIOR = {
    "utf-8": 0.05,
    "cp1252": 0.03,
    "cp932": 0.025,
    "gb18030": 0.025,
    "cp1251": 0.02,
    "cp949": 0.02,
    "cp950": 0.015,
    "euc_jp": 0.01,
    "koi8-r": 0.005,
}

# Country-code TLDs and UI languages that make a charset more likely.
_TLD_CHARSETS = {
    "kr": "cp949",
    "jp": "cp932",
    "cn": "gb18030",
    "tw": "cp950",
    "hk": "cp950",
    "ru": "cp1251",
    "by": "cp1251",
    "ua": "cp1251",
    "bg": "cp1251",
    "kz": "cp1251",
    "de": "cp1252",
    "fr": "cp1252",
    "es": "cp1252",
    "it": "cp1252",
    "pt": "cp1252",
    "br": "cp1252",
    "nl": "cp1252",
}
_LANGUAGE_CHARSETS = {
    "ko": "cp949",
    "ja": "cp932",
    "zh-cn": "gb18030",
    "zh-sg": "gb18030",
    "zh-hans": "gb18030",
    "zh-tw": "cp950",
    "zh-hk": "cp950",
    "zh-hant": "cp950",
    "zh": "gb18030",
    "ru": "cp1251",
    "uk": "cp1251",
    "bg": "cp1251",
    "de": "cp1252",
    "fr": "cp1252",
    "es": "cp1252",
    "it": "cp1252",
    "pt": "cp1252",
    "nl": "cp1252",
}

# Evidence weights. A hint is scaled by how plausible the text is in that
# charset, so a declared charset that yields nonsense does not win.
_WEIGHTS = {
    "bom": 2.0,
    "content_type": 0.8,
    "referer": 0.8,
    "preferred": 0.5,
    "request": 0.4,
    "tld": 0.25,
    "locale": 0.2,
}


def canonical(name: str | None) -> str | None:
    """The detection name for a charset, or None if it is not one we offer."""
    if not name:
        return None
    try:
        resolved = charset_module.codecs.lookup(name.strip().strip("\"'").lower()).name
    except LookupError:
        return None
    aliases = {
        "utf-8-sig": "utf-8",
        "euc_kr": "cp949",
        "shift_jis": "cp932",
        "gb2312": "gb18030",
        "gbk": "gb18030",
        "big5": "cp950",
        "big5hkscs": "cp950",
        "iso8859-1": "cp1252",
        "latin-1": "cp1252",
        "ascii": "utf-8",
    }
    resolved = aliases.get(resolved, resolved)
    return resolved if resolved in CANDIDATES else None


def _script(ch: str) -> str:
    code = ord(ch)
    if 0xAC00 <= code <= 0xD7A3 or 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F:
        return "hangul"
    if 0x3040 <= code <= 0x30FF or 0xFF66 <= code <= 0xFF9F:
        return "kana"
    if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF or 0xF900 <= code <= 0xFAFF:
        return "han"
    if 0x3100 <= code <= 0x312F:
        return "bopomofo"
    if 0x0400 <= code <= 0x04FF:
        return "cyrillic"
    if 0x0370 <= code <= 0x03FF:
        return "greek"
    category = unicodedata.category(ch)
    if category.startswith("L") and code <= 0x024F:
        return "latin"
    if category.startswith("L"):
        return "letter"
    return "symbol"


# Frequently used Han characters, simplified and traditional, including
# the vocabulary of web forms. Real Chinese and Japanese text draws most of
# its characters from a few hundred; bytes read in the wrong CJK charset
# land on valid characters spread evenly over thousands. Membership, not
# rank, is all that is used.
_COMMON_HAN = frozenset(
    "的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她"
    "里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老"
    "从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机"
    "给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产"
    "入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提"
    "感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛"
    "林题建南度统色字请交爱让认算论百吃义科怎元社术结六功指思非流每青管夫连远资队跟带花快条院变联言权"
    "往展该领传近留红治决周保达办运武半候七必城父强步完革深区即求品士转量空甚众技轻程告江语英基派满式"
    "李息写呢识极令黄德收脸钱党倒未持取设始版双历越史商千片容研像找友孩站广改议形委早房音火际则首单据"
    "导影失拿网香似斯专石若兵弟谁校读志飞观争究包组造落视济喜离虽坐集编宝谈府拉黑且随格尽剑讲布杀微怕"
    "母调局根曾准团段终乐切级克精哪官示冷域登录搜索户密码注册购物订单价助系欢迎深圳州败功错误提交确认"
    "取消返载陆称址邮箱验京都田村藤佐鈴木郎太店駅円県区様株式会社検索結果"
    "們個說這國會來時為對過後還點發經頭現動長樣種聲問給幾間業開與實無關從見麼東車書員場處報張難義應寫"
    "讓認誰語總號體親買賣網頁資訊電話碼請錯誤尋帳註價幫聯絡歡臺灣華陳劉楊吳鄭謝許"
)

# Relative frequency of each Hangul jamo position, coarse on purpose. A
# syllable's weight is the product of its initial, vowel and final. Bytes
# read as CP949 by mistake give valid syllables, but with rare parts such
# as ㅃ, ㅞ or a doubled final, which this catches without a word list.
_HANGUL_INITIAL = (1, .4, 1, 1, .35, 1, 1, 1, .3, 1, .6, 1, 1, .35, .8, .5, .7, .6, 1)
_HANGUL_VOWEL = (1, 1, .6, .2, 1, 1, 1, .6, 1, .7, .25, .6, .6, 1, .6, .2, .7, .5, 1, .7, 1)
_HANGUL_FINAL = (
    1, 1, .4, .15, 1, .2, .25, .6, 1, .35, .3, .3, .1, .15,
    .1, .25, 1, .8, .3, .7, .7, 1, .5, .45, .25, .45, .45, .3,
)


def _hangul_weight(ch: str) -> float:
    index = ord(ch) - 0xAC00
    if not 0 <= index < 11172:
        return 0.5
    initial, rest = divmod(index, 588)
    vowel, final = divmod(rest, 28)
    return _HANGUL_INITIAL[initial] * _HANGUL_VOWEL[vowel] * _HANGUL_FINAL[final]


def _double_byte(ch: str, codec: str) -> int | None:
    try:
        encoded = ch.encode(codec)
    except UnicodeEncodeError:
        return None
    return int.from_bytes(encoded, "big") if len(encoded) == 2 else None


def _commonness(ch: str, name: str, script: str) -> float:
    """How usual this character is in text written in this charset.

    Each legacy CJK charset has a first level of common characters. A
    character outside it is valid but rare, which is what separates real
    text from bytes read in the wrong charset.
    """
    if 0x2500 <= ord(ch) <= 0x259F:
        # Box drawing and block elements: in the upper half of several
        # legacy code pages, and almost never in what anyone types.
        return 0.05
    if name == "utf-8":
        # UTF-8 can hold any language, so a character is as common as the
        # most fitting language makes it.
        return max(_commonness(ch, other, script) for other in _LEGACY)
    common_han = ch in _COMMON_HAN
    if name == "cp949":
        if script == "hangul":
            code = _double_byte(ch, "euc_kr")
            if code is not None and 0xB0A1 <= code <= 0xC8FE:
                return 0.3 + 0.7 * _hangul_weight(ch)
            return 0.2
        if script == "han":
            return 0.35
        return 0.1 if script in {"kana", "cyrillic", "greek", "latin"} else 0.4
    if name in {"cp932", "euc_jp"}:
        if script == "kana":
            # Half-width katakana is a legacy display form. Whole strings
            # of it are what EUC-style bytes look like read as Shift_JIS.
            return 0.2 if 0xFF66 <= ord(ch) <= 0xFF9F else 1.0
        if script == "han":
            if common_han:
                return 0.95
            code = _double_byte(ch, "cp932")
            if code is not None and 0x889F <= code <= 0x9872:
                return 0.7
            return 0.35
        return 0.1 if script in {"hangul", "cyrillic", "greek", "latin"} else 0.4
    if name == "gb18030":
        if script == "han":
            code = _double_byte(ch, "gb2312")
            if code is not None and code >> 8 <= 0xD7:
                return 0.95 if common_han else 0.6
            return 0.4 if code is not None else 0.2
        return 0.05 if script in {"hangul", "kana", "cyrillic", "greek", "latin", "letter"} else 0.4
    if name == "cp950":
        if script == "han":
            code = _double_byte(ch, "big5")
            if code is not None and 0xA440 <= code <= 0xC67E:
                return 0.95 if common_han else 0.6
            return 0.4 if code is not None else 0.2
        if script == "bopomofo":
            return 0.5
        return 0.05 if script in {"hangul", "kana", "cyrillic", "greek", "latin"} else 0.4
    if name in {"cp1251", "koi8-r"}:
        if script == "cyrillic":
            # The Russian alphabet; Ukrainian and other letters are valid
            # but much rarer, and are what CJK bytes tend to land on.
            return 1.0 if "\u0410" <= ch <= "\u044f" or ch in "Ёё" else 0.5
        return 0.1 if script in {"latin", "greek"} else 0.5
    if name == "cp1252":
        if script == "latin":
            return 1.0
        if ch in "€‘’“”–—…«»©®°·¿¡ºª™•":
            return 0.7
        return 0.2
    return 0.5


def _word_penalty(text: str, name: str) -> float:
    """Penalise words no language writes.

    An alphabetic word mixing ASCII Latin with Cyrillic, a word made almost
    entirely of accented letters, or one alternating case mid-word, is the
    signature of single-byte text read in the wrong code page.
    """
    penalty = 1.0
    for word in re.findall(r"[^\W\d_]+", text):
        letters = [c for c in word if ord(c) >= 0x80]
        if not letters:
            continue
        scripts = {_script(c) for c in letters}
        if word.isascii():
            continue
        if scripts & {"cyrillic", "greek"} and any(c.isascii() for c in word):
            penalty *= 0.5
        if name == "cp1252" and (
            (len(word) >= 3 and len(letters) / len(word) > 0.5)
            or (len(word) >= 2 and len(letters) == len(word))
        ):
            penalty *= 0.4
        if scripts <= {"latin", "cyrillic", "greek"} and len(word) >= 3:
            # Lower then upper inside a word: "ЗПіЄ", "ÇÏ³ª".
            shifts = sum(
                1 for a, b in zip(word, word[1:]) if a.islower() and b.isupper()
            )
            if shifts:
                penalty *= 0.5 ** shifts
            # "ЛСЛч": capitals then lower case, past the first letter.
            elif re.search(r"[^\W\d_][A-ZА-ЯЁÀ-Þ]{1,}[a-zа-яёß-ÿ]", word):
                penalty *= 0.5
            elif word.isupper() and scripts == {"cyrillic"}:
                # KOI8-R read as Windows-1251 turns lower case into capitals.
                penalty *= 0.8
    return penalty


def plausibility(text: str, name: str) -> float:
    """0 to 1: how much this decoding looks like something a person wrote."""
    non_ascii = [c for c in text if ord(c) >= 0x80]
    if not non_ascii:
        return 1.0
    for c in text:
        category = unicodedata.category(c)
        if c == "�" or category in {"Cn", "Co", "Cs"}:
            return 0.0
        if category == "Cc" and c not in "\t\r\n":
            return 0.0
    scripts = [_script(c) for c in non_ascii]
    base = sum(_commonness(c, name, s) for c, s in zip(non_ascii, scripts)) / len(non_ascii)

    # One writing system, not a scattering of several. Japanese mixes kana
    # and kanji, and Korean occasionally uses hanja, so those count as one.
    merged = []
    for s in scripts:
        if s == "symbol":
            continue
        if s == "han" and name in {"cp932", "euc_jp"}:
            s = "kana"
        if s == "han" and name == "cp949":
            s = "hangul"
        if s == "han" and name == "utf-8" and ("kana" in scripts or "hangul" in scripts):
            s = "kana" if "kana" in scripts else "hangul"
        merged.append(s)
    if merged:
        dominant = max(merged.count(s) for s in set(merged)) / len(merged)
        base *= 0.4 + 0.6 * dominant
        if name == "cp949" and set(scripts) == {"han"}:
            # Korean written entirely in hanja is rare; Chinese read as
            # CP949 often lands there.
            base *= 0.6
    else:
        base *= 0.5
    if any(unicodedata.category(c) == "Cf" for c in non_ascii):
        base *= 0.3
    return base * _word_penalty(text, name)


def _utf8_bonus(data: bytes) -> float:
    """UTF-8 is self-validating: each multibyte sequence that parses is
    evidence, because other charsets rarely produce valid UTF-8 by chance."""
    sequences = sum(1 for b in data if b >= 0xC0)
    return min(0.9, 0.35 + 0.2 * sequences)


@dataclass(slots=True)
class Hint:
    charset: str
    source: str
    detail: str = ""


@dataclass(slots=True)
class Candidate:
    name: str
    text: str
    plausibility: float
    score: float
    reasons: list[dict[str, str]] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": CANDIDATES.get(self.name, self.name),
            "text": self.text,
            "score": round(self.score, 3),
        }


def _decode_all(data: bytes) -> dict[str, str]:
    results = {}
    for name in CANDIDATES:
        try:
            results[name] = data.decode(name)
        except UnicodeDecodeError:
            continue
    return results


def rank(data: bytes, hints: list[Hint], corpus: list[bytes] | None = None) -> list[Candidate]:
    """Every charset these bytes decode in, best first."""
    if data.startswith(charset_module.codecs.BOM_UTF8):
        try:
            text = data[3:].decode("utf-8")
        except UnicodeDecodeError:
            pass
        else:
            return [Candidate("utf-8", text, 1.0, 3.0, [{"code": "bom"}])]

    decoded = _decode_all(data)
    corpus_scores: dict[str, float] = {}
    if corpus:
        # The other encoded values in the same request were almost always
        # written by the same page, so how well each charset reads them is
        # evidence for this one too. Longer values say more.
        total = 0
        for other in corpus:
            weight = len(other)
            total += weight
            for name, text in _decode_all(other).items():
                score = plausibility(text, name)
                if name == "utf-8":
                    score = max(score, _utf8_bonus(other))
                corpus_scores[name] = corpus_scores.get(name, 0.0) + score * weight
        if total:
            corpus_scores = {k: v / total for k, v in corpus_scores.items()}

    candidates = []
    for name, text in decoded.items():
        plaus = plausibility(text, name)
        if plaus <= 0:
            continue
        reasons: list[dict[str, str]] = []
        score = plaus + _USAGE_PRIOR.get(name, 0.0)
        if name == "utf-8" and not data.isascii():
            score += _utf8_bonus(data)
            reasons.append({"code": "utf8_valid"})
        for hint in hints:
            if hint.charset == name:
                score += _WEIGHTS[hint.source] * plaus
                reasons.append({"code": hint.source, "detail": hint.detail})
        if name in corpus_scores and corpus_scores[name] > 0:
            # Relative to the best reading of the other values, so a charset
            # that merely decodes them does not gain as much as the one that
            # reads them well.
            best = max(corpus_scores.values())
            share = corpus_scores[name] / best if best else 0.0
            if share > 0.5:
                score += _WEIGHTS["request"] * share * plaus
                if share >= 0.99:
                    reasons.append({"code": "request"})
        candidates.append(Candidate(name, text, plaus, score, reasons))
    candidates.sort(key=lambda c: c.score, reverse=True)
    return candidates


def _confidence(candidates: list[Candidate], data: bytes) -> str:
    if not candidates:
        return "low"
    top = candidates[0]
    codes = {r["code"] for r in top.reasons}
    if "bom" in codes:
        return "high"
    second = candidates[1].score if len(candidates) > 1 else 0.0
    margin = top.score - second
    non_ascii = sum(1 for b in data if b >= 0x80)
    if top.name == "utf-8" and non_ascii >= 4 and margin > 0.3:
        return "high"
    if codes & {"content_type", "referer", "preferred"} and top.plausibility >= 0.6:
        return "high" if margin > 0.3 else "medium"
    if margin > 0.5 and non_ascii >= 6:
        return "high"
    if margin > 0.2:
        return "medium"
    return "low"


# --- context ----------------------------------------------------------


@dataclass(slots=True)
class Context:
    """What is known about where the selected value came from."""

    request: str = ""
    form: bool = False
    locale: str = ""
    preferred: str = ""
    referer_charset: Callable[[str], str | None] | None = None
    hints: list[Hint] = field(default_factory=list)
    corpus: list[bytes] = field(default_factory=list)
    _prepared: bool = False

    def prepare(self, selection: str) -> None:
        if self._prepared:
            return
        self._prepared = True
        head, _, _ = self.request.partition("\n\n")
        if "\r\n\r\n" in self.request:
            head = self.request.split("\r\n\r\n", 1)[0]
        headers: dict[str, str] = {}
        for line in head.splitlines()[1:]:
            name, sep, value = line.partition(":")
            if sep:
                headers.setdefault(name.strip().lower(), value.strip())

        declared = canonical(charset_module.charset_from_headers(headers.get("content-type")))
        if declared:
            self.hints.append(Hint(declared, "content_type", declared))
        referer = headers.get("referer")
        if referer and self.referer_charset:
            found = canonical(self.referer_charset(referer))
            if found:
                self.hints.append(Hint(found, "referer", referer))
        preferred = canonical(self.preferred)
        if preferred:
            self.hints.append(Hint(preferred, "preferred", preferred))
        host = headers.get("host", "")
        if not host:
            first = head.splitlines()[0] if head else ""
            parts = first.split()
            if len(parts) >= 2 and "://" in parts[1]:
                host = urllib.parse.urlsplit(parts[1]).hostname or ""
        tld = host.split(":")[0].rsplit(".", 1)[-1].lower() if host else ""
        if tld in _TLD_CHARSETS:
            self.hints.append(Hint(_TLD_CHARSETS[tld], "tld", "." + tld))
        language = self.locale.lower().replace("_", "-")
        locale_charset = _LANGUAGE_CHARSETS.get(language) or _LANGUAGE_CHARSETS.get(
            language.split("-")[0]
        )
        if locale_charset:
            self.hints.append(Hint(locale_charset, "locale", self.locale))

        # Every other percent-encoded run with non-ASCII bytes.
        for match in _PERCENT_RUN.finditer(self.request):
            run = match.group(0)
            if run in selection:
                continue
            data = urllib.parse.unquote_to_bytes(run)
            if not data.isascii():
                self.corpus.append(data)


_PERCENT_RUN = re.compile(r"(?:%[0-9A-Fa-f]{2})+")


# --- layers -----------------------------------------------------------


@dataclass(slots=True)
class Layer:
    """One layer of encoding, with what is needed to put it back.

    `kind` names it; `style` records how the original was written so the
    re-encoded value looks the same as the original wherever the text is
    unchanged.
    """

    kind: str
    style: dict[str, Any] = field(default_factory=dict)
    # The value as it was before this layer was removed.
    before: str | bytes = ""

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind}
        if self.kind == "charset":
            out["charset"] = self.style["charset"]
            out["label"] = CANDIDATES.get(self.style["charset"], self.style["charset"])
        return out


_UNRESERVED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")
_HTML_ENTITY = re.compile(r"&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]{1,31});")
_JS_ESCAPE = re.compile(r"\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}")
_HEX = re.compile(r"^(?:0x)?[0-9A-Fa-f]{2}(?:([\s:,-]?)[0-9A-Fa-f]{2})+$")
_B64 = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
_B64URL = re.compile(r"^[A-Za-z0-9_-]+={0,2}$")
_JWT = re.compile(r"^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?$")
MAX_LAYERS = 8


def _url_style(value: str, plus_space: bool) -> dict[str, Any]:
    literal = set(_ESCAPE.sub("", value))
    escapes = _ESCAPE.findall(value)
    encoded_ascii = {chr(int(e[1:], 16)) for e in escapes if int(e[1:], 16) < 0x80}
    hexdigits = "".join(e[1:] for e in escapes)
    lower = any(c in "abcdef" for c in hexdigits) and not any(c in "ABCDEF" for c in hexdigits)
    return {
        "plus": plus_space and "+" in literal,
        "space": "+" if plus_space and "+" in literal else "%20",
        "literal": "".join(sorted(literal - {"%", "+"} if plus_space else literal - {"%"})),
        "encoded": "".join(sorted(encoded_ascii)),
        "lower": lower,
    }


def _url_encode(data: bytes, style: dict[str, Any]) -> str:
    literal = set(style["literal"])
    encoded = set(style["encoded"])
    fmt = "%{:02x}" if style["lower"] else "%{:02X}"
    out = []
    for b in data:
        c = chr(b)
        if b >= 0x80 or b < 0x20 or b == 0x7F:
            out.append(fmt.format(b))
        elif c == " ":
            out.append("+" if style["space"] == "+" else fmt.format(b))
        elif c in encoded or c in "%+&=#?":
            # These stay encoded even if the original happened to leave one
            # literal, unless that is exactly what it did with this
            # character: a whole query string selected keeps its & and =.
            out.append(c if c in literal and c not in encoded and c != "%" else fmt.format(b))
        elif c in _UNRESERVED or c in literal:
            out.append(c)
        else:
            out.append(fmt.format(b))
    return "".join(out)


def _try_text(data: bytes, ctx: Context) -> list[Candidate]:
    """Candidates for bytes that should be text, or [] if they are not."""
    if data.isascii():
        text = data.decode("ascii")
        printable = sum(1 for c in text if c.isprintable() or c in "\t\r\n")
        return [Candidate("utf-8", text, 1.0, 1.0)] if text and printable == len(text) else []
    return rank(data, ctx.hints, ctx.corpus)


def _looks_like_payload(data: bytes, ctx: Context) -> bool:
    """Whether bytes from a speculative decode (Base64, hex) are worth showing.

    A word like "test" is valid Base64, so a decode alone proves nothing.
    The result has to be readable text or a compressed stream.
    """
    if len(data) < 2:
        return False
    if data[:2] == b"\x1f\x8b":
        return True
    candidates = _try_text(data, ctx)
    if not candidates or candidates[0].plausibility < 0.6:
        return False
    if data.isascii():
        return True
    # A few random bytes are often a valid CJK character in some legacy
    # charset, so "test" would read as Base64 of one. Non-ASCII results
    # must be UTF-8, which random bytes almost never are, or a charset the
    # request itself names.
    top = candidates[0]
    if top.name == "utf-8":
        return True
    strong = {"content_type", "referer", "preferred", "manual"}
    return any(r["code"] in strong for r in top.reasons) and top.plausibility >= 0.8


def _peel(value: str, ctx: Context) -> tuple[Layer | None, str | bytes]:
    """Remove the outermost layer of a text value, if there is one."""
    stripped = value.strip()
    if _JWT.match(stripped):
        parts = stripped.split(".")
        try:
            header = json.loads(_b64url(parts[0]))
            payload = json.loads(_b64url(parts[1]))
        except (ValueError, binascii.Error):
            pass
        else:
            text = json.dumps({"header": header, "payload": payload}, indent=2, ensure_ascii=False)
            return Layer("jwt", {"signature": parts[2] if len(parts) > 2 else None}, value), text

    if _ESCAPE.search(value):
        plus = ctx.form and "+" in value
        source = value.replace("+", " ") if plus else value
        data = urllib.parse.unquote_to_bytes(source)
        return Layer("url", _url_style(value, ctx.form), value), data

    if _HTML_ENTITY.search(value):
        decoded = html.unescape(value)
        if decoded != value:
            entities = _HTML_ENTITY.findall(value)
            numeric = [e for e in entities if e.startswith("&#")]
            style = {
                "escaped": "".join(sorted({html.unescape(e) for e in entities})),
                "hex": any(e[2:3] in "xX" for e in numeric),
                "named": len(numeric) < len(entities),
            }
            return Layer("html", style, value), decoded

    if _JS_ESCAPE.search(value):
        escapes = _JS_ESCAPE.findall(value)
        if all(e.startswith("\\x") for e in escapes):
            # \xNN escapes are bytes; what charset they are is decided next.
            escaped_bytes = bytearray()
            i = 0
            while i < len(value):
                if value.startswith("\\x", i) and _JS_ESCAPE.match(value, i):
                    escaped_bytes.append(int(value[i + 2:i + 4], 16))
                    i += 4
                else:
                    escaped_bytes.extend(value[i].encode("utf-8"))
                    i += 1
            lower = not any(c in "ABCDEF" for e in escapes for c in e[2:])
            return Layer("bytes_escape", {"lower": lower}, value), bytes(escaped_bytes)
        try:
            decoded_json = json.loads('"' + value.replace('"', '\\"') + '"')
        except ValueError:
            decoded_json = None
        if isinstance(decoded_json, str) and decoded_json != value:
            lower = not any(c in "ABCDEF" for e in escapes for c in e[2:])
            return Layer("unicode_escape", {"lower": lower}, value), decoded_json

    hex_match = _HEX.match(stripped)
    if hex_match and len(stripped) >= 4:
        separator = hex_match.group(1) or ""
        digits = re.sub(r"[^0-9A-Fa-f]", "", stripped.removeprefix("0x"))
        if len(digits) % 2 == 0:
            data = bytes.fromhex(digits)
            if _looks_like_payload(data, ctx):
                letters = [c for c in digits if c.isalpha()]
                style = {
                    "separator": separator,
                    "upper": bool(letters) and all(c.isupper() for c in letters),
                    "prefix": stripped.startswith("0x"),
                }
                return Layer("hex", style, value), data

    if len(stripped) >= 4 and len(stripped.rstrip("=")) % 4 != 1:
        for kind, pattern in (("base64", _B64), ("base64url", _B64URL)):
            if not pattern.match(stripped):
                continue
            try:
                data = (_b64url if kind == "base64url" else _b64)(stripped)
            except (ValueError, binascii.Error):
                continue
            if _looks_like_payload(data, ctx):
                return Layer(kind, {"padding": stripped.endswith("=")}, value), data
    return None, value


def _b64(value: str) -> bytes:
    return base64.b64decode(value + "=" * (-len(value) % 4), validate=True)


def _b64url(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    if not _B64URL.match(padded):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(padded)


@dataclass(slots=True)
class Reading:
    layers: list[Layer]
    text: str | None
    data: bytes | None
    candidates: list[Candidate]
    charset_data: bytes | None


def read(value: str, ctx: Context, charset: str | None = None) -> Reading:
    """Peel every layer off `value`.

    `charset`, when given, is used for the bytes-to-text step instead of the
    detected one.
    """
    ctx.prepare(value)
    layers: list[Layer] = []
    current: str | bytes = value
    candidates: list[Candidate] = []
    charset_data: bytes | None = None
    for _ in range(MAX_LAYERS):
        if isinstance(current, bytes):
            if current[:2] == b"\x1f\x8b":
                try:
                    inflated = gzip.decompress(current)
                except (OSError, EOFError, zlib.error):
                    break
                layers.append(Layer("gzip", {}, current))
                current = inflated
                continue
            ranked = _try_text(current, ctx)
            forced = canonical(charset) if charset else None
            if forced and not current.isascii():
                try:
                    text = current.decode(forced)
                except UnicodeDecodeError:
                    text = None
                if text is not None:
                    chosen = next((c for c in ranked if c.name == forced), None)
                    if chosen is None:
                        chosen = Candidate(forced, text, plausibility(text, forced), 0.0)
                    chosen.reasons = [{"code": "manual"}]
                    ranked = [chosen] + [c for c in ranked if c.name != forced]
            if not ranked or (not current.isascii() and ranked[0].plausibility < 0.15 and not forced):
                return Reading(layers, None, current, ranked, current)
            if not current.isascii():
                candidates = ranked
                charset_data = current
                layers.append(Layer("charset", {"charset": ranked[0].name}, current))
            current = ranked[0].text
            continue
        layer, inner = _peel(current, ctx)
        if layer is None:
            break
        layers.append(layer)
        current = inner
    if isinstance(current, bytes):
        return Reading(layers, None, current, candidates, charset_data)
    return Reading(layers, current, None, candidates, charset_data)


def _rewrap(layer: Layer, inner: str | bytes) -> str | bytes:
    style = layer.style
    if layer.kind == "charset":
        assert isinstance(inner, str)
        name = style["charset"]
        try:
            return inner.encode(name)
        except UnicodeEncodeError as exc:
            bad = exc.object[exc.start:exc.end]
            raise InspectError(
                f"CHARSET_UNENCODABLE:{CANDIDATES.get(name, name)}:{bad}"
            ) from exc
    if layer.kind == "url":
        data = inner if isinstance(inner, bytes) else inner.encode("utf-8")
        return _url_encode(data, style)
    if layer.kind in {"base64", "base64url"}:
        data = inner if isinstance(inner, bytes) else inner.encode("utf-8")
        encoded = (
            base64.urlsafe_b64encode(data) if layer.kind == "base64url" else base64.b64encode(data)
        ).decode("ascii")
        return encoded if style["padding"] else encoded.rstrip("=")
    if layer.kind == "hex":
        data = inner if isinstance(inner, bytes) else inner.encode("utf-8")
        pairs = [f"{b:02X}" if style["upper"] else f"{b:02x}" for b in data]
        return ("0x" if style["prefix"] else "") + style["separator"].join(pairs)
    if layer.kind == "gzip":
        data = inner if isinstance(inner, bytes) else inner.encode("utf-8")
        return gzip.compress(data, mtime=0)
    if layer.kind == "html":
        assert isinstance(inner, str)
        escaped = set(style["escaped"]) | set("&<>")
        out = []
        for c in inner:
            if c in escaped or (ord(c) >= 0x80 and any(ord(e) >= 0x80 for e in style["escaped"])):
                named = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}
                if style["named"] and c in named:
                    out.append(named[c])
                else:
                    out.append(f"&#x{ord(c):x};" if style["hex"] else f"&#{ord(c)};")
            else:
                out.append(c)
        return "".join(out)
    if layer.kind == "unicode_escape":
        assert isinstance(inner, str)
        fmt = "\\u{:04x}" if style["lower"] else "\\u{:04X}"
        out = []
        for c in inner:
            if ord(c) < 0x80:
                out.append(c)
            else:
                # Characters outside the BMP become a surrogate pair, as in JSON.
                units = c.encode("utf-16-be")
                for i in range(0, len(units), 2):
                    out.append(fmt.format(int.from_bytes(units[i:i + 2], "big")))
        return "".join(out)
    if layer.kind == "bytes_escape":
        data = inner if isinstance(inner, bytes) else inner.encode("utf-8")
        fmt = "\\x{:02x}" if style["lower"] else "\\x{:02X}"
        return "".join(chr(b) if 0x20 <= b < 0x7F else fmt.format(b) for b in data)
    if layer.kind == "jwt":
        assert isinstance(inner, str)
        try:
            parsed = json.loads(inner)
            header, payload = parsed["header"], parsed["payload"]
        except (ValueError, KeyError, TypeError) as exc:
            raise InspectError("JWT_INVALID_JSON") from exc

        def segment(obj: Any) -> str:
            raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

        parts = [segment(header), segment(payload)]
        if style["signature"] is not None:
            parts.append(style["signature"])
        return ".".join(parts)
    raise InspectError(f"cannot re-encode {layer.kind}")


def write(value: str, text: str, ctx: Context, charset: str | None = None) -> str:
    """Put `text` back inside the layers `value` was read through."""
    reading = read(value, ctx, charset)
    if reading.text is None:
        raise InspectError("NOT_TEXT")
    if text == reading.text:
        return value
    current: str | bytes = text
    for layer in reversed(reading.layers):
        current = _rewrap(layer, current)
    if isinstance(current, bytes):
        # A layer stack that ends in bytes started from a str, so this only
        # happens if the outermost layer is gzip, which is never peeled
        # from a str.
        raise InspectError("NOT_TEXT")
    # Whitespace the outer layers ignored (e.g. around a Base64 token).
    lead = value[: len(value) - len(value.lstrip())]
    trail = value[len(value.rstrip()):]
    if reading.layers and reading.layers[0].kind in {"hex", "base64", "base64url", "jwt"}:
        current = lead + current + trail
    return current


def hex_dump(data: bytes, width: int = 16) -> str:
    lines = []
    for offset in range(0, len(data), width):
        chunk = data[offset:offset + width]
        hexes = " ".join(f"{b:02x}" for b in chunk)
        text = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in chunk)
        lines.append(f"{offset:08x}  {hexes:<{width * 3}} {text}")
    return "\n".join(lines)


def inspect(value: str, ctx: Context, charset: str | None = None) -> dict[str, Any]:
    reading = read(value, ctx, charset)
    result: dict[str, Any] = {
        "layers": [layer.public() for layer in reading.layers],
        "text": reading.text,
        "hex": hex_dump(reading.data) if reading.data is not None and reading.text is None else None,
        "editable": reading.text is not None and bool(reading.layers),
        "charset": None,
    }
    if reading.candidates and reading.charset_data is not None:
        top = reading.candidates[0]
        result["charset"] = {
            "name": top.name,
            "label": CANDIDATES.get(top.name, top.name),
            "confidence": "high" if any(r["code"] == "manual" for r in top.reasons)
            else _confidence(reading.candidates, reading.charset_data),
            "reasons": top.reasons,
            "candidates": [c.public() for c in reading.candidates[:6]],
        }
    return result


__all__ = [
    "CANDIDATES",
    "Context",
    "InspectError",
    "canonical",
    "inspect",
    "plausibility",
    "rank",
    "read",
    "write",
]
