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

## Available hooks

`request`, `response`, `error`, `tcp_start`, `tcp_message`, `tcp_end`,
`tcp_error`, `websocket_message`, `running`, `done`. In other words, the whole
mitmproxy addon hook set is available.

## A note on trust

Plugins run inside the engine process, not a sandbox. Only enable code you
trust. Keep heavy work off the event loop by handing it to a worker.

## Examples

- `header_tagger.py` comments on responses that are missing security headers
- `request_stamp.py` adds an `X-Lanius` header to every request
