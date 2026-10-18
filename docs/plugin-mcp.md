# Plugin MCP tools

SDK 1.3 lets trusted plugins add tools to Lanius's existing local HTTP MCP
endpoint. Agents use the same connection as built-in History, Intercept, and
Replay tools. No separate server, listener, or outbound connection is created.

## Try the bundled example

Open **Plugins**, install the bundled **MCP Notes** sample, and enable it.
In **Settings > AI agents**, check that these tools appear:

- `lanius.mcp-notes.read_note`: read a note from this project's plugin storage.
- `lanius.mcp-notes.write_note`: save a note in this project's plugin storage.

Connect an agent using the HTTP configuration shown in Settings. Ask it to
write a note using `write_note` with `{"text": "Check the login flow"}`, then
read it using `read_note` with `{}`. The default note key is `default`.
This sample only reads and writes local project storage.

Installation leaves the sample disabled. Notes survive disable and reload,
and project exports carry them. Lockdown Mode permits installing the bundled
sample locally but prevents executing it.

## Register a tool

Save this as `notes.py` in your configured plugins directory, refresh discovery,
and enable it. Loose files use their filename without `.py` as the plugin ID;
packages use the ID in `plugin.json`.

```python
from lanius_sdk import PluginContext


def activate(context: PluginContext) -> None:
    def read_note(key: str = "default") -> dict:
        return {"key": key, "text": context.storage.get(key, "")}

    def write_note(text: str, key: str = "default") -> dict:
        context.storage.set(key, text)
        return {"key": key, "saved": True}

    context.mcp.register_tool(
        "read_note", read_note,
        description="Read a project note.",
        read_only=True,
    )
    context.mcp.register_tool(
        "write_note", write_note,
        description="Save a project note.",
    )
```

The full signature is:

```python
context.mcp.register_tool(
    tool_id, handler, *, description=None, read_only=False
) -> Disposable
```

Handlers may be synchronous or asynchronous, and receive named arguments
directly: `handler(key="default")`, rather than an action-style payload mapping.
Every input parameter needs a type annotation. Defaults become optional
arguments in the published JSON schema. Positional-only parameters, `*args`,
`**kwargs`, MCP context injection, and protocol resolvers are unsupported.
Use JSON-compatible return data; annotating the return type also allows the MCP
SDK to publish and validate an output schema. Missing, invalid, and unknown
arguments are rejected before the handler runs.

`tool_id` follows the SDK contribution ID rules: start with a lowercase letter,
use lowercase letters and digits, and separate segments with dashes or
underscores. The host prefixes the plugin ID, so `read_note` in `notes` becomes
`notes.read_note`. Qualified names are limited to 128 characters. Duplicate
registrations fail activation, and plugins cannot replace built-in tools or
another plugin's tools. `description` overrides the handler docstring.

`read_only` defaults to `False`, which marks the tool as potentially writing.
Setting it to `True` adds the MCP read-only hint and changes the Settings badge.
It is a declaration by the plugin author, not an enforced permission.

Packages using this API should declare `"sdk": ">=1.3,<2"` in their manifest's
`compatibility` object. Older SDK APIs remain available.

## Editing, removal, and client refresh

Edit the handler or its annotations, then reload the plugin in Plugins. Auto
reload works as it does for other SDK contributions. The next `tools/list`
returns the current description and schema; calls resolve the current
registration. Cached wrappers from a previous registration refuse execution.

The returned `Disposable` removes one tool. Disabling, deleting, reloading, or
failing to activate a plugin removes all its tools and cancels managed calls.
Invocation metrics appear in the plugin's existing diagnostics; handler failures
and managed output appear in its log console.

The server publishes tool-list changes on the MCP SDK's `subscriptions/listen`
bus for clients using that subscription mechanism. Clients using an older
protocol or without subscription support must refresh their tool list or
reconnect. The Settings list updates over Lanius's local event stream.

These tools are available only through the running engine's HTTP MCP endpoint.
The standalone `python -m app.mcp` stdio process opens a database without
loading plugins and does not expose plugin tools.

## Execution limits and trust

Each call has a 30-second host timeout. Synchronous handlers run on worker
threads so they do not block the engine event loop. Results must serialize as
JSON, contain no non-finite numbers, and occupy at most 1 MiB when encoded as
UTF-8 JSON. Handler failures become MCP tool errors; unexpected exception
details stay in the plugin's local log rather than the agent response.

Safe mode and effective global/project Lockdown Mode hide plugin tools and
refuse execution. Calls recheck the shared `PluginManager.suspended` predicate
before invoking the handler and before returning a result. Unloading cancels
asynchronous calls and stops waiting for synchronous calls. On timeout the host
returns an error without waiting for a handler's cancellation cleanup; that
cleanup stays tracked until it finishes. Async handlers must cooperate with
cancellation so plugin unload and shutdown can finish. Python cannot
forcibly stop an already running worker thread: a timeout, reload, or Lockdown
transition does not terminate synchronous Python or native code already
executing. Plugins remain trusted in-process code, as described in
[Plugin Packages](plugin-packages.md).

Turning off **Allow agents to connect** refuses HTTP MCP access for built-in
and plugin tools alike. This adds no arbitrary HTTP sender or network
permission to the SDK.

Plugin results are arbitrary author-provided JSON and do not inherit the
built-in flow tools' sensitive-header masking. Do not return tokens, cookies,
raw captured headers, or secrets from settings/storage unless that exposure is
intentional. In particular, `context.flows.page()` returns captured snapshots;
authors must redact sensitive data before returning it over MCP.

See [Plugin SDK](plugins-sdk.md) for storage and lifecycle details, and
[AI Agents](ai-agents.md) for connection configuration.
