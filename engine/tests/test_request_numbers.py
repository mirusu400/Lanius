"""Request allocation survives stale counters and capture batch retries."""

import pytest

from app.db.store import FlowRecord, FlowStore


def test_new_request_recovers_a_sequence_behind_existing_numbers() -> None:
    store = FlowStore()
    try:
        store.upsert(FlowRecord(id="collision", request_number=2801))
        store.upsert(FlowRecord(id="latest", request_number=3164))
        with store._conn:
            store._conn.execute("UPDATE flow_request_sequence SET next_value = 2801")

        assert store.upsert(FlowRecord(id="new")) == 3165
        assert store.get("collision").request_number == 2801
        assert store.get("latest").request_number == 3164
        assert store.upsert(FlowRecord(id="next")) == 3166
    finally:
        store.close()


def test_sequence_recovery_respects_implicit_legacy_numbers() -> None:
    store = FlowStore()
    try:
        store.upsert(FlowRecord(id="legacy"))
        with store._conn:
            store._conn.execute(
                "UPDATE flows SET rowid = 100, request_number = NULL WHERE id = 'legacy'"
            )
            store._conn.execute("UPDATE flow_request_sequence SET next_value = 1")

        assert store.upsert(FlowRecord(id="new")) == 101
        assert store.get("legacy").request_number == 100
        store.upsert(FlowRecord(id="legacy", status_code=201))
        assert store.get("legacy").request_number == 100
    finally:
        store.close()


def test_rolled_back_batch_can_retry_after_another_request_is_saved() -> None:
    store = FlowStore()
    pending = FlowRecord(id="pending")
    try:
        with pytest.raises(ValueError, match="request_number"):
            store.upsert_prepared_many([
                pending,
                FlowRecord(id="invalid", request_number=True),
            ])

        assert pending.request_number is None
        assert store.upsert(FlowRecord(id="interleaved")) == 1
        assert store.upsert_prepared_many([pending]) == [2]
        assert pending.request_number == 2
        assert store.get("interleaved").request_number == 1
    finally:
        store.close()
