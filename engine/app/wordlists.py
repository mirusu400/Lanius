"""Fetching wordlists from SecLists.

Hunting down a wordlist, downloading it and pasting it in is most of the
work of setting up an attack, so Lanius can fetch the common ones.

Three deliberate constraints. The catalogue is a fixed list in this file
rather than a directory listing, so enabling this feature cannot be
turned into fetching arbitrary paths from a repository. Downloads are
capped, because SecLists also contains a 53MB rockyou archive that has no
business in a project database. And nothing is fetched until someone
asks: a proxy that phones home on startup is not a tool anyone should
trust.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# Pinned to a tag rather than master: a wordlist that changes underneath
# a saved set makes results from different days incomparable.
SECLISTS_REF = "2024.3"
RAW_BASE = "https://raw.githubusercontent.com/danielmiessler/SecLists"

# Comfortably above the largest list offered below, far under the
# archives in the repository that must never be pulled in.
MAX_BYTES = 8 * 1024 * 1024
TIMEOUT = 30.0


@dataclass(frozen=True, slots=True)
class Wordlist:
    """One list that can be fetched."""

    id: str
    name: str
    path: str
    category: str
    #: Roughly how many lines, so the size is known before downloading.
    approx_lines: int

    @property
    def url(self) -> str:
        return f"{RAW_BASE}/{SECLISTS_REF}/{self.path}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "approx_lines": self.approx_lines,
            "url": self.url,
        }


# The lists that actually get used, kept short on purpose. A picker with
# six useful entries beats one with six hundred.
CATALOGUE: tuple[Wordlist, ...] = (
    Wordlist(
        id="web-common",
        name="Common web content",
        path="Discovery/Web-Content/common.txt",
        category="discovery",
        approx_lines=4700,
    ),
    Wordlist(
        id="web-big",
        name="Web content (big)",
        path="Discovery/Web-Content/big.txt",
        category="discovery",
        approx_lines=20500,
    ),
    Wordlist(
        id="raft-dirs",
        name="Directories (raft, medium)",
        path="Discovery/Web-Content/raft-medium-directories.txt",
        category="discovery",
        approx_lines=30000,
    ),
    Wordlist(
        id="api-endpoints",
        name="API endpoints",
        path="Discovery/Web-Content/api/api-endpoints.txt",
        category="discovery",
        approx_lines=1600,
    ),
    Wordlist(
        id="top-usernames",
        name="Usernames (top 1000)",
        path="Usernames/top-usernames-shortlist.txt",
        category="credentials",
        approx_lines=17,
    ),
    Wordlist(
        id="common-passwords",
        name="Passwords (top 10k)",
        path="Passwords/Common-Credentials/10k-most-common.txt",
        category="credentials",
        approx_lines=10000,
    ),
    Wordlist(
        id="xss-payloads",
        name="XSS payloads",
        path="Fuzzing/XSS/human-friendly/XSS-Jhaddix.txt",
        category="fuzzing",
        approx_lines=110,
    ),
    Wordlist(
        id="sqli-payloads",
        name="SQL injection payloads",
        path="Fuzzing/SQLi/Generic-SQLi.txt",
        category="fuzzing",
        approx_lines=250,
    ),
    Wordlist(
        id="lfi-payloads",
        name="Path traversal payloads",
        path="Fuzzing/LFI/LFI-Jhaddix.txt",
        category="fuzzing",
        approx_lines=900,
    ),
)

_BY_ID = {entry.id: entry for entry in CATALOGUE}


class WordlistError(Exception):
    """A wordlist could not be fetched (mapped to HTTP 4xx/502)."""


def catalogue() -> list[dict[str, Any]]:
    return [entry.as_dict() for entry in CATALOGUE]


def find(list_id: str) -> Wordlist:
    entry = _BY_ID.get(list_id)
    if entry is None:
        raise WordlistError(f"unknown wordlist: {list_id!r}")
    return entry


async def fetch(list_id: str) -> tuple[Wordlist, list[str]]:
    """Download one catalogued wordlist.

    Reads in chunks and stops at the cap rather than trusting
    Content-Length, which a server is free to get wrong or omit.
    """
    entry = find(list_id)
    try:
        import httpx
    except ImportError as exc:  # pragma: no cover - httpx ships with us
        raise WordlistError("HTTP client unavailable") from exc

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            async with client.stream("GET", entry.url) as response:
                if response.status_code != 200:
                    raise WordlistError(
                        f"{entry.name}: server returned {response.status_code}"
                    )
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise WordlistError(
                            f"{entry.name} is larger than "
                            f"{MAX_BYTES // (1024 * 1024)}MB"
                        )
                    chunks.append(chunk)
    except WordlistError:
        raise
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # Offline is the common case, and worth saying plainly rather
        # than surfacing a transport exception.
        raise WordlistError(f"could not reach SecLists: {exc}") from exc

    body = b"".join(chunks)
    # SecLists is mostly ASCII but not entirely, and a single odd byte
    # should not lose the whole list.
    text = body.decode("utf-8", errors="replace")
    payloads = [
        line
        for line in (raw.rstrip("\r") for raw in text.split("\n"))
        # Comments are documentation in these files, not payloads.
        if line.strip() and not line.startswith("#")
    ]
    if not payloads:
        raise WordlistError(f"{entry.name} came back empty")
    return entry, payloads
