# Features

Lanius is a desktop web security testing proxy built on mitmproxy. It sits
between your browser and the web so you can see every request, stop it mid
flight, change it, and send it again. Each feature has its own page:

## Proxy

- [Dashboard](dashboard.md): live overview of the current capture.
- [Proxy History](proxy.md): every request and response, with search,
  filters, masking and version comparison.
- [Intercept](intercept.md): hold and edit requests and responses, plus
  Match &amp; Replace rules.
- [WebSockets](websockets.md): record, intercept and resend WebSocket
  messages.
- [Target](target.md): the site map, endpoint grouping and scope.
- [Raw TCP](raw-tcp.md): non-HTTP traffic as a byte-level hex dump.
- [Logger](logger.md): live and stored engine events.
- [Lockdown Mode](lockdown-mode.md): block Lanius-owned external requests
  on sensitive networks.

## Testing

- [Replay](replay.md): send captured requests again, with tabs and history.
- [Fuzzer](fuzzer.md): run wordlists against marked payload positions.
- [Decoder and Diff](decoder-diff.md): encoder/decoder chains and
  word- or byte-level comparison.
- [Issues](issues.md): findings from plugin passive and active checks.

## Platform

- [Projects](projects.md): separate databases, backups, exports and cleanup.
- [AI Agents](ai-agents.md): MCP and HTTP tools for coding agents.
- [Settings](settings.md): listener, upstream proxy, TLS fingerprint,
  system capture, appearance, language, shortcuts and updates.

## Plugins

- [Plugin SDK](plugins-sdk.md): authoring against the versioned SDK
  boundary.
- [Plugin Packages](plugin-packages.md): installable `.lanius-plugin`
  archives, signatures and sandboxed UI.
- [Plugin Catalogues](plugin-catalogues.md): signed catalogues, updates,
  rollbacks and revocations.
- [Plugin Scanner](plugin-scanner.md): passive and active checks.

The [README](https://github.com/mirusu400/Lanius) covers download and getting
started.
