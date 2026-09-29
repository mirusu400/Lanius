# Plugin SDK 1.1

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

Contribution IDs use lowercase letters, digits, dots, dashes, and underscores.
The host qualifies them with the plugin ID. A local action ID `inspect` from a
plugin named `headers` becomes `headers.inspect`. This prevents two plugins
from silently replacing each other.

## Actions

`context.actions.register` adds a command with one or more UI locations:
`global`, `history`, `flow`, `request`, `response`, `repeater`, or `intruder`.
Handlers receive a JSON compatible context mapping and may return a value or an
awaitable. The contribution catalogue is available at
`GET /api/plugin-contributions`; actions run through
`POST /api/plugin-actions/{id}/invoke`.

The declared locations are rendered in HTTP history, Target, request and
response details, Repeater, Intruder, or the global Plugins toolbar. Synchronous
handlers run outside the engine event loop. Actions and payload handlers have a
30 second host timeout, and action results must be JSON compatible and no more
than 1 MiB.

Flow locations include `flow_id` and a serializable flow summary. Request and
response detail menus also include the loaded detail and a `message` field.
Repeater and Intruder include their current raw request and parsed request when
valid. The host adds the exact `location` chosen by the UI before invocation.

## Codecs

`context.codecs.register` adds an encoder, a decoder, or both to Decoder. A
codec is exposed under its qualified ID and participates in the same decoder
chain as built in codecs. An ID collision rejects activation instead of
overwriting an existing transform.

## Intruder payload extensions

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

The host retains the latest 500 log entries per plugin and measures SDK action,
payload, and scanner contribution calls. The Plugins diagnostics panel shows
call and error counts, average and maximum duration, the last error, and output.
Resetting diagnostics also resumes a suspended scanner check. A passive or
active scanner check is suspended after five consecutive errors so one broken
check cannot fail for every captured request indefinitely.

## Package resources

Files stored under a package's `resources/` directory are available through
`context.resources.list()`, `read_bytes(path)`, and `read_text(path)`. Paths
are relative to `resources/`, cannot escape that directory, and a single read
is capped at 10 MiB. Resource files remain covered by the package manifest's
integrity map. Legacy loose-file plugins do not receive a resource directory.

## Scanner checks and issues

`context.scanner.register_passive` analyzes captured responses without sending
traffic. `register_active` receives bounded insertion points and a rate-limited
request sender. Checks return `ScanIssue` values, which the host validates,
deduplicates, persists, and displays. The full scheduler contract is in
[plugin-scanner.md](plugin-scanner.md).

## Compatibility

`lanius_sdk.API_VERSION` and `context.api_version` currently report `1.1`.
Minor additions remain backward compatible. A future breaking API uses a new
major version and package manifests declare which major versions they accept.

Distribution, compatibility fields, integrity, signatures, sandboxed UI, and
development linking are specified in [plugin-packages.md](plugin-packages.md).
