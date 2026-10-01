# Plugin SDK 1.2

`lanius_sdk` is the stable boundary between a plugin and the engine. Engine
modules under `app` are internal and can change without an SDK compatibility
promise.

An SDK plugin exports a synchronous `activate(context)` function. Activation
may register capabilities, return one mitmproxy addon, return a list of addons,
or return a `Disposable`. A plugin can also keep using the legacy `Plugin` or
`addons` entry point while it migrates.

```python
from lanius_sdk import PluginContext, SettingDefinition

def activate(context: PluginContext) -> None:
    context.settings.define(
        SettingDefinition("prefix", "Prefix", default="test-")
    )
    context.actions.register(
        "tag",
        "Tag selected flow",
        lambda event: {"flow_id": event.get("flow_id")},
        locations=("flow", "history"),
    )
```

Activation itself is synchronous so loading remains transactional. Long lived
asynchronous work starts through `context.tasks.create(...)`. The host cancels
and awaits those tasks when the plugin is disabled or reloaded.

## Owned registrations

Every registration belongs to the plugin that created it. Disabling, reloading,
deleting, or failing to activate a plugin removes all of its registrations.
Calling the returned `Disposable.dispose()` removes an individual registration
earlier.

Contribution IDs use lowercase letters, digits, dashes, and underscores.
The host qualifies them with the plugin ID. A local action ID `inspect` from a
plugin named `headers` becomes `headers.inspect`. Plugin IDs may contain dots
but contribution IDs may not, so the owner is always everything before the
last dot and two plugins such as `acme` and `acme.demo` cannot claim each
other's IDs.

## Actions

`context.actions.register` adds a command with one or more UI locations:
`global`, `history`, `flow`, `request`, `response`, `replay`, `fuzzer`, or
`plugin`. The `plugin` location is for a sandboxed plugin view's own actions.
Handlers receive a JSON compatible context mapping and may return a value or an
awaitable. The contribution catalogue is available at
`GET /api/plugin-contributions`; actions run through
`POST /api/plugin-actions/{id}/invoke`.

The declared locations are rendered in HTTP history, Target, request and
response details, Replay, Fuzzer, or the global Plugins toolbar. Synchronous
handlers run outside the engine event loop. Actions and payload handlers have a
30 second host timeout, and action results must be JSON compatible and no more
than 1 MiB.

Flow locations include `flow_id` and a serializable flow summary. Request and
response detail menus also include the loaded detail and a `message` field.
Replay and Fuzzer include their current raw request and parsed request when
valid. The host adds the exact `location` chosen by the UI before invocation.

## Codecs

`context.codecs.register` adds an encoder, a decoder, or both to Decoder. A
codec is exposed under its qualified ID and participates in the same decoder
chain as built in codecs. An ID collision rejects activation instead of
overwriting an existing transform.

## Fuzzer payload extensions

`context.payloads.register_generator` produces payload strings from a JSON
options mapping. `register_processor` transforms a payload before use. Both
forms may be synchronous or asynchronous. The host limits a single generator
call to 100,000 values.

The HTTP bridge exposes generators and processors at:

- `POST /api/plugin-payload-generators/{id}/generate`
- `POST /api/plugin-payload-processors/{id}/process`

## Settings and storage

`context.settings.define` declares typed fields. Supported kinds are `string`,
`boolean`, `integer`, `number`, and `enum`. Project settings live in the project
database and are included in project export. User settings live in
`plugin-values.json` under the Lanius data directory. The Plugins tab renders
the schema and edits values through `/api/plugins/{plugin}/settings`.

`context.storage` stores arbitrary JSON compatible values without exposing the
database. Keys are automatically namespaced by plugin. Project and user scopes
are supported, and a value is limited to 1 MiB. Stored values survive plugin
disable and reload; uninstall can explicitly remove them later.

## Logging and tasks

`context.log` is a logger named `lanius.plugin.{plugin_id}`. Use
`context.tasks.create(awaitable)` for background work so shutdown, reload, and
failure cleanup can cancel it deterministically.

The host combines five sources in a plugin-owned, in-memory log stream:

- `sdk`: `context.log`
- `logging`: the plugin module's standard Python logger and descendants
- `stdout`: `print()` and direct stdout writes, recorded at `info`
- `stderr`: direct stderr writes, recorded at `error`
- `host`: load, activation, managed task, action, scanner, and traffic-hook
  failures observed by Lanius

Each entry contains `sequence`, `timestamp`, `plugin`, `source`, `level`, and
`message`. The host retains the latest 500 entries per plugin and limits each
message to 16 KiB. Buffers exist only for the current engine session: they are
not persisted in the project, exported, or copied to the Logger tab. Incremental
clients use `GET /api/plugins/{id}/logs?after={sequence}&limit=500`, and
`DELETE /api/plugins/{id}/logs` clears only that plugin's log buffer.

Output attribution covers host-managed import, activation, mitmproxy hooks,
SDK actions and payload handlers, scanner handlers, and managed tasks. File
descriptor output from a subprocess and output from unmanaged native threads
are outside this contract. Writes made outside a plugin execution context pass
through to the engine's original stdout or stderr.

The performance panel measures SDK action, payload, and scanner contribution
calls. It shows call and error counts, average and maximum duration, and the
last error. Resetting diagnostics resets those counters and resumes a suspended
scanner check without deleting logs. A passive or active scanner check is
suspended after five consecutive errors so one broken check cannot fail for
every captured request indefinitely.

## Package resources

Files stored under a package's `resources/` directory are available through
`context.resources.list()`, `read_bytes(path)`, and `read_text(path)`. Paths
are relative to `resources/`, cannot escape that directory, and a single read
is capped at 10 MiB. Resource files remain covered by the package manifest's
integrity map. Legacy loose-file plugins do not receive a resource directory.

## Captured flows

`context.flows.page(limit=50, cursor=None, anchor=None, in_scope_only=True,
body_limit=32768)` reads a bounded page of captured HTTP snapshots. The host
limits pages to 100 flows and each rendered request/response body to 65,536
characters.
Pages include `items`, `has_more`, `anchor`, and `next_cursor`; pass the first
page's anchor and each next cursor to traverse a stable History snapshot. Scope
rules are applied before items are returned by default. This is read-only and
uses the project store without opening a network connection.

## Scanner checks and issues

`context.scanner.register_passive` analyzes captured responses without sending
traffic. `register_active` receives bounded insertion points and a rate-limited
request sender. Checks return `ScanIssue` values, which the host validates,
deduplicates, persists, and displays. The full scheduler contract is in
[plugin-scanner.md](plugin-scanner.md).

An active check registered with `request_level=True` runs once for a selected
flow and can call `scan.send_with(kind, name, value)` to append a query,
header, cookie, form, or top-level JSON input. Calling `scan.send_with()` sends
the unchanged control request. All such requests share the active job's limits
and Replay/scope egress path. `await context.scanner.start(check_id, flow_id)`
starts the plugin's own check from an explicit UI action and returns job status.

## Compatibility

`lanius_sdk.API_VERSION` and `context.api_version` currently report `1.2`.
Minor additions remain backward compatible. A future breaking API uses a new
major version and package manifests declare which major versions they accept.

Distribution, compatibility fields, integrity, signatures, sandboxed UI, and
development linking are specified in [plugin-packages.md](plugin-packages.md).
