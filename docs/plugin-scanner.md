# Plugin scanner and issues

The scanner is a host service built on SDK contributions. A plugin registers a
passive check for captured responses, an active check for explicit probes, or
both. Findings become project data in the **Issues** tab and are included in
project export and import.

## Passive checks

`context.scanner.register_passive(id, title, handler)` receives a JSON
compatible snapshot after the response has passed through traffic plugins.
The snapshot contains request and response metadata, headers, text bodies,
timing, error, and flow ID. Each body is capped at 1 MiB for scanning. The
handler returns one `ScanIssue`, an iterable of issues, or `None`.

Passive checks run only for in-scope HTTP traffic. They execute off the proxy
event loop when synchronous. The host bounds pending scans at 1,000 and emits a
`scanner.dropped` event instead of growing memory without limit.

## Active checks

`context.scanner.register_active(id, title, handler)` receives an
`ActiveScanContext` for each insertion point. Query parameters, eligible
headers, path segments, form fields, top-level JSON scalar fields, and raw
bodies are supported.

```python
from lanius_sdk import ScanIssue

async def check(scan):
    response = await scan.send("probe-value")
    if response["status_code"] == 500:
        return ScanIssue(
            title="Probe caused a server error",
            severity="medium",
            detail="The selected insertion point caused a 500 response.",
            parameter=scan.insertion_point.name,
        )

def activate(context):
    context.scanner.register_active("server-error", "Server error probe", check)
```

`scan.send()` replaces only the current insertion point and sends the request
through the existing Replay/mitmproxy path. TLS, upstream routing, traffic
plugins, capture, and passive checks therefore behave the same as other Lanius
requests.

The host enforces at most 10 concurrent requests, 50 requests per second, and
1,000 requests per job. The user can choose lower values and cancel a running
job. Active scanning never starts automatically.

## Issue lifecycle

`ScanIssue` carries title, severity, confidence, detail, remediation, parameter,
evidence, and an optional stable fingerprint seed. The host combines plugin,
check, target, title, parameter, and custom seed into the final fingerprint.
Repeated findings update `last_seen` and `occurrences` instead of creating
duplicate rows.

Severity is `info`, `low`, `medium`, `high`, or `critical`. Confidence is
`tentative`, `firm`, or `certain`. Users can mark an issue open, resolved, or a
false positive, and the chosen status survives another matching observation.
Evidence must be JSON compatible and is capped at 256 KiB.

REST endpoints under `/api/issues` filter, inspect, update, and delete findings.
`/api/scanner` lists checks and jobs, toggles passive scanning, runs a passive
check for a stored flow, starts active jobs, and stops them.
