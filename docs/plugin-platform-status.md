# Plugin platform status and next steps

This document describes the plugin platform after the phased implementation on
`feat/plugin-platform-v1`. The earlier
[research report](research/plugin-platform.md) remains the baseline that was
used to choose the implementation order.

## Current platform

| Area | Available now |
|---|---|
| Runtime | Legacy mitmproxy addons and SDK plugins; deterministic ordering; complete hot-load lifecycle; transactional rollback; package module cleanup; manual reload; optional file watching; startup safe mode |
| Discovery | Metadata and hook discovery without importing disabled loose-file plugins; package manifests expose metadata and compatibility before activation |
| SDK | Versioned `lanius_sdk` 1.2 with owner-scoped disposable registrations |
| Contributions | Context actions, codecs, Fuzzer payload generators and processors, typed settings, user/project storage, managed tasks, logging, bounded read-only flow pages, passive scanner checks, and active scanner checks with request-level input probes |
| Product surfaces | Plugin actions in Proxy history, Target, request/response details, Replay, Fuzzer, and the global Plugins toolbar |
| Package data | Read-only, path-confined `resources/` access with per-read size limits |
| Distribution | `.lanius-plugin` archives, integrity maps, SHA-256 verification, Ed25519 signatures, atomic install, uninstall, and development symlinks |
| Frontend | Installed/Catalogue management workspace; per-plugin overview, settings, live logs, diagnostics, and manifest-declared views in sandboxed iframes; a narrow host RPC bridge that can list and invoke actions owned by the same plugin |
| Scanner | Bounded passive and active execution, insertion points, scope/rate/concurrency/request limits, cancellation, deduplicated project issues, issue UI, and JSON export |
| Catalogue | User-configured signed catalogues, immutable releases, signer binding, compatibility checks, install/update, retained backup, rollback, and revocation enforcement |
| Operations | Per-plugin SDK/Python/stdout/stderr/host logs with incremental polling and independent clearing; contribution latency/error counters; automatic suspension after five consecutive scanner failures; manual diagnostic reset |

Registrations belong to the plugin that created them. Disable, reload,
activation failure, and deletion dispose registrations and managed tasks as one
lifecycle. Contribution IDs are qualified by plugin ID so independently
developed plugins cannot silently replace each other's entries.

## Trust and isolation boundary

Package verification protects distribution integrity. The iframe sandbox also
limits frontend access to the host application. A Python backend still runs in
the engine process with the authority of the application. Manifest permissions
describe requested access for review and display; they are not a security
boundary for that backend.

This means local or catalogue backend code must still be trusted. A hung hook,
native extension crash, or unrestricted file/process access cannot be contained
by the current runtime. SDK actions and payload handlers have time and output
limits, but ordinary mitmproxy hooks remain synchronous in-process callbacks.

## Coverage against the original phases

| Phase | Status | Notes |
|---|---|---|
| P0 loader hardening | Complete for lifecycle, rollback, ordering, metadata, reload, and safe mode | Raw traffic-hook timing and process containment remain future runtime work |
| P1 stable SDK | Complete for the v1.2 contribution set | Bounded read-only History pages are available; general HTTP send, scope, site-map, and tool facades are not exposed yet |
| P2 packages and UI | Complete for signed local packages, resources, sandboxed views, and action RPC | Custom message editors, columns, hotkeys, and richer host widgets are not available |
| P3 scanner and issues | Complete for bounded passive/active checks and persisted findings | Out-of-band testing and external scanner adapters are not included |
| P4 catalogue | Complete for signed-source lifecycle and recovery | There is no hosted public registry, review service, rating, or automatic update policy |
| P5 diagnostics | Complete for SDK calls, scanner circuit breaking, managed output capture, hook error capture, and plugin logs | CPU/memory accounting and raw traffic-hook latency are not collected |

The app bundles an installable **Request Marker** reference package. It modifies
a request header, declares settings and actions, emits lifecycle and per-request
logs, counts handled requests, and exposes a sandboxed statistics/reset view.
Installation is local and remains available in Lockdown Mode, while execution
continues to be suspended there. The sample is installed disabled so enabling
trusted code remains an explicit user action.

## Recommended next increments

### 1. Isolated backend workers

Add an optional worker runtime for analysis, import/export, and external-tool
plugins. Communicate through versioned, schema-validated RPC and enforce
wall-clock, memory, filesystem, network, and subprocess capabilities at the
worker boundary. Keep in-process execution only for trusted callbacks that must
modify live traffic synchronously.

This is the highest-value next step because it turns manifest permissions from
descriptive metadata into enforceable controls and keeps a plugin crash away
from the proxy process.

### 2. Typed host facades

Expose stable SDK services instead of requiring imports from application
internals:

- HTTP send/replay with timing and cancellation
- richer project flow queries and annotations
- scope reads and updates
- site-map and endpoint reads/writes
- Replay send/open operations
- WebSocket message reads and sends
- issue reads and report/export helpers

Each service should return immutable SDK data objects, check capability grants,
apply quotas, and remain disposable with the owning plugin.

### 3. Rich UI contributions

Build on the existing iframe and action bridge with explicit contribution
types for custom HTTP/WebSocket message editors, history columns, filters,
badges, command-palette entries, hotkeys, modals, notifications, and task
progress. Keep host data access behind typed RPC and send only the current
selection or message snapshot required by a view.

### 4. Runtime observability

Instrument raw traffic hooks with duration/error counters and slow-hook
warnings. Add worker CPU and memory limits once isolated workers exist. Surface
crash history and resource impact in catalogue release details so users can
judge operational cost before installation.

### 5. Ecosystem services

After isolation and host facades are stable, add a hosted registry submission
pipeline with source/license requirements, automated package validation,
human security review, compatibility results, staged update channels, incident
revocation, and reproducible release provenance. Ratings and popularity should
follow operational and review metadata rather than replace it.

## Plugin families enabled by the platform

The current contracts are sufficient for action and transform toolkits,
payload sources/processors, passive and active checks, issue exporters,
sandboxed dashboards, and signed catalogue delivery. The next increments would
enable deeper families such as structured message editors, authorization
matrices, schema importers, out-of-band checks, external scanner bridges, and
long-running collaboration integrations without coupling those plugins to
engine internals.
