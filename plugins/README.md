# Lanius plugin examples

A plugin is an ordinary mitmproxy addon. Put a single `.py` file, or a
directory with an `__init__.py`, into your plugin directory (by default
`~/.lanius/plugins`) and Lanius will find it.

## Minimal plugin

```python
DESCRIPTION = "One line summary"   # optional
VERSION = "1.0.0"                  # optional
AUTHOR = "you"                     # optional

class Plugin:
    def request(self, flow):
        flow.request.headers["X-Example"] = "1"
```

Instead of a `Plugin` class or instance you can expose a list:
`addons = [obj1, obj2]`.

For actions, codecs, settings, storage, payload extensions, and managed tasks,
use the versioned [`lanius_sdk`](../docs/plugins-sdk.md). SDK registrations are
owned by the plugin and are removed automatically on disable or reload.
Installable archives and sandboxed UI views use the
[`plugin.json` package format](../docs/plugin-packages.md).

The Plugins onboarding screen can install the bundled **Request Marker**
package without a network request. It is deliberately installed disabled. Once
enabled it adds `X-Lanius-Sample`, exposes header and request-log settings,
counts requests, and provides actions plus a sandboxed statistics view. This is
the reference example for a complete `.lanius-plugin`; the files in this
directory remain smaller loose-file examples intended for local development.

## Available hooks

The complete mitmproxy addon hook set is available, including lifecycle,
client/server connection, HTTP, WebSocket, TCP, UDP, DNS, TLS and QUIC events.
The Plugins tab discovers declared hooks without executing disabled plugins.
See the [mitmproxy event hook reference](https://docs.mitmproxy.org/stable/api/events.html)
for signatures and event ordering.

## Managing plugins

The Plugins tab controls the order in which enabled plugins see traffic. It
can also watch an individual plugin and reload it after any Python source file
in the plugin changes. Loading, unloading and reloading are serialized on the
engine event loop, and plugin registrations are removed when the plugin is
disabled. Its Logs detail view captures managed `print()`, stderr,
`logging.getLogger(__name__)`, SDK logger messages, and host-reported load or
hook failures without mixing them into the application Logger tab.

Start the engine with `LANIUS_DISABLE_PLUGINS=1` to open a project in safe
mode. Installed plugins remain listed and retain their enabled state, but no
plugin code is executed. Lockdown Mode applies the same execution suspension.
The bundled sample is a local install and can still be installed in Lockdown;
it cannot execute until Lockdown is left.

## A note on trust

Plugins run inside the engine process, not a sandbox. Only enable code you
trust. Keep heavy work off the event loop by handing it to a worker. Safe mode
prevents execution; it does not make an enabled plugin sandboxed.

## Examples

- `header_tagger.py` comments on responses that are missing security headers
- `request_stamp.py` adds an `X-Lanius` header to every request
