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

## Secrets and safety

Secrets are redacted in every response unless the agent explicitly asks for
them, so tokens do not leak into a transcript by accident.

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
