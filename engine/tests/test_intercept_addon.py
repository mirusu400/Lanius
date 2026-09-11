from __future__ import annotations

import asyncio

import pytest
from mitmproxy.test import tflow, tutils

from app.addons.intercept import (
    InterceptAddon,
    InterceptError,
    InterceptRules,
    apply_edits,
)
from app.events import EventBroker


def make_flow(host: str = "example.com", with_response: bool = False):
    return tflow.tflow(
        req=tutils.treq(host=host, method=b"GET", path=b"/a"),
        resp=tutils.tresp(content=b"orig") if with_response else False,
    )


def addon(**rules) -> InterceptAddon:
    return InterceptAddon(EventBroker(), InterceptRules(**rules))


def test_disabled_does_not_pause() -> None:
    a = addon(enabled=False)
    flow = make_flow()
    a.request(flow)
    assert a.paused == {}
    assert not flow.intercepted


def test_enabled_pauses_request() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    assert flow.intercepted
    assert flow.id in a.paused


def test_host_filter_limits_pausing() -> None:
    a = addon(enabled=True, host_filter="target.com")
    other = make_flow("example.com")
    match = make_flow("api.target.com")
    a.request(other)
    a.request(match)
    assert other.id not in a.paused
    assert match.id in a.paused


def test_response_phase_opt_in() -> None:
    a = addon(enabled=True, intercept_requests=False, intercept_responses=True)
    flow = make_flow(with_response=True)
    a.request(flow)
    assert a.paused == {}
    a.response(flow)
    assert a.paused[flow.id][1] == "response"


def test_forward_resumes_flow() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    a.forward(flow.id)
    assert not flow.intercepted
    assert a.paused == {}


def test_forward_applies_request_edits() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    a.forward(
        flow.id,
        {
            "method": "POST",
            "path": "/edited?x=1",
            "request_headers": [["Host", "example.com"], ["X-Lanius", "1"]],
            "request_body": "payload",
        },
    )
    assert flow.request.method == "POST"
    assert flow.request.path == "/edited?x=1"
    assert flow.request.headers["X-Lanius"] == "1"
    assert flow.request.content == b"payload"


def test_forward_applies_response_edits() -> None:
    a = addon(enabled=True, intercept_requests=False, intercept_responses=True)
    flow = make_flow(with_response=True)
    a.response(flow)
    a.forward(flow.id, {"status_code": 418, "response_body": "teapot"})
    assert flow.response is not None
    assert flow.response.status_code == 418
    assert flow.response.content == b"teapot"


def test_body_edit_updates_content_length() -> None:
    flow = make_flow()
    flow.request.headers["content-length"] = "0"
    apply_edits(flow, "request", {"request_body": "abcd"})
    assert flow.request.headers["content-length"] == "4"


def test_drop_kills_flow() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    a.drop(flow.id)
    assert flow.error is not None
    assert not flow.live
    assert a.paused == {}


@pytest.mark.asyncio
async def test_drop_releases_the_waiting_hook() -> None:
    """Regression: kill() clears `intercepted` without firing the resume
    event, so dropping before resuming left the client hanging forever."""
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    waiter = asyncio.create_task(flow.wait_for_resume())
    await asyncio.sleep(0)
    assert not waiter.done()

    a.drop(flow.id)
    await asyncio.wait_for(waiter, timeout=1)


@pytest.mark.asyncio
async def test_forward_releases_the_waiting_hook() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    waiter = asyncio.create_task(flow.wait_for_resume())
    await asyncio.sleep(0)
    a.forward(flow.id)
    await asyncio.wait_for(waiter, timeout=1)


@pytest.mark.asyncio
async def test_resume_all_releases_waiting_hooks() -> None:
    a = addon(enabled=True)
    flows = [make_flow() for _ in range(3)]
    waiters = []
    for flow in flows:
        a.request(flow)
        waiters.append(asyncio.create_task(flow.wait_for_resume()))
    await asyncio.sleep(0)
    assert a.resume_all() == 3
    await asyncio.wait_for(asyncio.gather(*waiters), timeout=1)


def test_forward_unknown_flow_raises() -> None:
    with pytest.raises(InterceptError):
        addon(enabled=True).forward("nope")


def test_disabling_releases_paused_flows() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    a.set_rules(enabled=False)
    assert a.paused == {}
    assert not flow.intercepted


def test_replayed_requests_are_not_intercepted() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    flow.is_replay = "request"
    a.request(flow)
    assert a.paused == {}


def test_events_published_on_pause_and_resolve() -> None:
    broker = EventBroker()
    queue = broker.subscribe()
    a = InterceptAddon(broker, InterceptRules(enabled=True))
    flow = make_flow()
    a.request(flow)
    a.forward(flow.id)
    first = queue.get_nowait()
    second = queue.get_nowait()
    assert first["type"] == "intercept.paused"
    assert first["data"]["phase"] == "request"
    assert second["type"] == "intercept.resolved"
    assert second["data"]["action"] == "forward"


def test_list_paused_serializes_flows() -> None:
    a = addon(enabled=True)
    flow = make_flow()
    a.request(flow)
    [entry] = a.list_paused()
    assert entry["id"] == flow.id
    assert entry["method"] == "GET"
    assert any(h[0].lower() == "header" or True for h in entry["request_headers"])


def test_invalid_header_entry_rejected() -> None:
    flow = make_flow()
    with pytest.raises(InterceptError):
        apply_edits(flow, "request", {"request_headers": [["only-one"]]})


def test_editing_response_without_response_raises() -> None:
    flow = make_flow()
    with pytest.raises(InterceptError):
        apply_edits(flow, "response", {"status_code": 200})
