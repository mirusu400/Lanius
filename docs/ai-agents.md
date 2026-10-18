# AI Agents

Lanius speaks [MCP](https://modelcontextprotocol.io/), so a coding agent can
browse your captured traffic, manage scope, hold and edit intercepted requests,
and replay them.

```jsonc
{
  "mcpServers": {
    "lanius": {
      "command": "/path/to/Lanius/engine/.venv/bin/python",
      "args": ["-m", "app.mcp"],
      "cwd": "/path/to/Lanius/engine"
    }
  }
}
```

While the app is running you can also connect over HTTP, which additionally
exposes the interception and replay tools. **Settings > AI agents** shows the
endpoint, lists every tool with whether it only reads or actually acts, and
has a configuration you can copy straight into your client.

Enabled plugins can add tools to this HTTP endpoint through SDK 1.3. Settings
shows the owning plugin and its declared read/write behavior. See
[Plugin MCP Tools](plugin-mcp.md) for the bundled MCP Notes sample and authoring
instructions. The standalone stdio process does not load plugins.

## Choosing MCP or SQLite

When an agent connects, Lanius tells it the database path for that MCP server
and the core `flows` columns. Use `list_flows` and `get_flow` for ordinary
capture lookup, and MCP tools for Replay, Intercept, scope changes and
bookmarks. For large aggregations or time ranges that those tools cannot
express, an agent running on the same machine can query the project SQLite
file directly. Open it read-only, for example:

```bash
sqlite3 -readonly -header -column '/path/to/project.sqlite' \
  'SELECT host, COUNT(*) AS flows FROM flows GROUP BY host ORDER BY flows DESC LIMIT 20'
```

Direct SQL returns raw headers and bodies, without MCP's header redaction.
It also remains possible for a filesystem-capable agent when MCP connections
are disabled. Do not edit the live database directly; use Lanius or its MCP
tools for changes. The in-memory test database has no file to query.

## Secrets and safety

Built-in flow tools redact sensitive headers unless the agent explicitly asks
to reveal them. Plugin tool results are author-provided JSON and do not inherit
that masking; only enable trusted plugins. Lockdown Mode and safe mode suspend
plugin tools while built-in tools retain their existing traffic policies.

An agent with these tools can send traffic through your proxy, change your
scope and release held requests. Untick **Allow agents to connect** and
connections are refused. The endpoint listens on this machine only, even when
the proxy itself is bound to the network.

## Port

The API and MCP share a local port (default `12954`). Change it in
**Settings > AI agents**; Lanius restarts the active project's engine on the
new port. The project picker also lets you change it before opening a project
if the current port is busy. A launch-time override is also available:

```bash
LANIUS_API_PORT=8091 open -a Lanius
```
