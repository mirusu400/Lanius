"""Named payload lists for Intruder.

A wordlist is pasted once and used from then on, rather than pasted into
every attack. Sets are stored in the project database, so they travel
with a project export the way scope rules and Repeater tabs do.

Payloads are held as text with one per line rather than as JSON: a
wordlist is already that shape, it stays readable in the database, and a
50,000 line list does not pay for quoting every entry.
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any, List

# A wordlist bigger than this is a file to stream, not a set to keep in a
# project. rockyou is 14 million lines; nothing here should try to hold
# that in a database row.
MAX_PAYLOADS = 200_000
MAX_NAME = 120


class PayloadSetError(Exception):
    """Invalid payload set (mapped to HTTP 4xx)."""


@dataclass(slots=True)
class PayloadSet:
    id: str
    name: str
    payloads: list[str]
    source: str | None
    created_at: float
    updated_at: float

    def summary(self) -> dict[str, Any]:
        """Without the payloads: a picker needs the name and the size,
        and sending 50,000 entries to draw a list is wasteful."""
        return {
            "id": self.id,
            "name": self.name,
            "count": len(self.payloads),
            "source": self.source,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def as_dict(self) -> dict[str, Any]:
        return {**self.summary(), "payloads": self.payloads}


def parse_payloads(text: str) -> list[str]:
    """One payload per line.

    Blank lines are dropped, since they come from how a file ends rather
    than from anything anyone meant to send. Whitespace inside a line is
    kept: a payload may be testing exactly that.
    """
    lines = [line.rstrip("\r") for line in text.split("\n")]
    return [line for line in lines if line.strip()]


class PayloadSetStore:
    """Payload sets, in the project database."""

    def __init__(self, conn: sqlite3.Connection, lock: Any) -> None:
        self._conn = conn
        self._lock = lock

    def list(self) -> List[PayloadSet]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM payload_sets ORDER BY name"
            ).fetchall()
        return [_row_to_set(row) for row in rows]

    def get(self, set_id: str) -> PayloadSet | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM payload_sets WHERE id = ?", (set_id,)
            ).fetchone()
        return _row_to_set(row) if row else None

    def save(
        self, *, name: str, payloads: List[str], source: str | None = None
    ) -> PayloadSet:
        """Create a set, or replace the one with this name.

        Keyed by name rather than id so that re-importing a wordlist
        updates it instead of leaving two sets called the same thing.
        """
        name = name.strip()
        if not name:
            raise PayloadSetError("name is required")
        if len(name) > MAX_NAME:
            raise PayloadSetError(f"name must be {MAX_NAME} characters or fewer")
        if not payloads:
            raise PayloadSetError("a payload set needs at least one payload")
        if len(payloads) > MAX_PAYLOADS:
            raise PayloadSetError(
                f"{len(payloads)} payloads exceeds the limit of {MAX_PAYLOADS}"
            )

        now = time.time()
        body = "\n".join(payloads)
        with self._lock:
            existing = self._conn.execute(
                "SELECT id, created_at FROM payload_sets WHERE name = ?", (name,)
            ).fetchone()
            if existing:
                set_id, created = existing["id"], existing["created_at"]
                self._conn.execute(
                    "UPDATE payload_sets SET payloads = ?, source = ?,"
                    " updated_at = ? WHERE id = ?",
                    (body, source, now, set_id),
                )
            else:
                set_id, created = uuid.uuid4().hex[:12], now
                self._conn.execute(
                    "INSERT INTO payload_sets (id, name, payloads, source,"
                    " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (set_id, name, body, source, now, now),
                )
            self._conn.commit()
        return PayloadSet(
            id=set_id,
            name=name,
            payloads=payloads,
            source=source,
            created_at=created,
            updated_at=now,
        )

    def rename(self, set_id: str, name: str) -> PayloadSet:
        """Change a set's name, keeping its id and payloads.

        Saving under a new name would create a second set, since save is
        keyed by name; this is how a set gets renamed rather than copied.
        """
        name = name.strip()
        if not name:
            raise PayloadSetError("name is required")
        if len(name) > MAX_NAME:
            raise PayloadSetError(f"name must be {MAX_NAME} characters or fewer")
        with self._lock:
            clash = self._conn.execute(
                "SELECT id FROM payload_sets WHERE name = ? AND id != ?",
                (name, set_id),
            ).fetchone()
            if clash:
                raise PayloadSetError(f"a set called {name!r} already exists")
            cur = self._conn.execute(
                "UPDATE payload_sets SET name = ?, updated_at = ? WHERE id = ?",
                (name, time.time(), set_id),
            )
            self._conn.commit()
        if cur.rowcount == 0:
            raise PayloadSetError("payload set not found")
        found = self.get(set_id)
        if found is None:  # pragma: no cover - deleted between the two
            raise PayloadSetError("payload set not found")
        return found

    def delete(self, set_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM payload_sets WHERE id = ?", (set_id,)
            )
            self._conn.commit()
        return cur.rowcount > 0


def _row_to_set(row: sqlite3.Row) -> PayloadSet:
    return PayloadSet(
        id=row["id"],
        name=row["name"],
        payloads=parse_payloads(row["payloads"]),
        source=row["source"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
