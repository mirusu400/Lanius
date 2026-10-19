# Changelog

## Unreleased

- Switch HTTP History between side-by-side and history-above-detail layouts,
  remembering the layout and divider position on this machine.
- Add SDK 1.3 plugin-owned HTTP MCP tools with typed inputs, reload cleanup,
  execution limits, Lockdown/safe-mode guards, Settings ownership badges, and
  a bundled MCP Notes example. See [Plugin MCP Tools](docs/plugin-mcp.md).

## [0.4.0] — Persistent testing workflows and platform reliability

See the [v0.4.0 release notes](docs/releases/v0.4.0.md) for downloads and installation notes. Changes since v0.3.0:

- Preserve Fuzzer runs and multiple drafts, add stable request numbers and search-only progress in HTTP History, apply a default bookmark highlight, and restore workspace tabs on launch.
- Share editor undo history and request context menus, highlight HTTP details in Replay and Fuzzer, and add configurable shortcuts for sending requests to them.
- Search settings, configure media body storage limits, and import SQLite project databases with faster history access.
- Optionally record public IPv4 and IPv6 changes at one, three, or five minute intervals, inspect their history in Settings or over MCP, and use configurable HTTPS observers with no polling or observation writes during Lockdown Mode.
- Exclude `*.googleapis.com` from scope by default in every project while keeping the rule editable and removable.
- Trust platform certificate roots for upstream TLS on Linux and Windows, improve Windows CA detection, and help open macOS network extension settings when capture needs approval.
- Improve signed updates across release channels and installers, and fix startup in affected VMware WebKit environments.

## [0.3.0] — History, diagnostics, and plugin improvements

See the [v0.3.0 release notes](docs/releases/v0.3.0.md) for downloads and installation notes. Changes since v0.2.0:

- Bookmark and highlight HTTP history entries, filter by those annotations, and manage bookmarks through MCP. History can also display the local source IP for captured traffic.
- Keep Proxy history filters, selection, and position while switching tabs. Improve paging and navigation, and make intercepted flows available to history actions.
- Preserve Intercept drafts and show the original, automatically modified, and final request versions. Save up to 50 Replay sends per tab and browse previous request/response pairs.
- Add Dashboard Doctor checks for local engine, listener, browser, CA, system capture, and traffic readiness.
- Extend the plugin SDK with request-level active checks and targeted scanner runs. Show signed catalogue details and icons, with a clearer empty state.
- Add one-line MCP setup commands for Codex and Claude Code and guidance for read-only SQLite analysis.
- Publish a VitePress product website and feature wiki, also available in the app's Docs tab.
- Fix slow history clearing, improve its confirmation, and update `source-map-js` to a patched version.

## [0.2.0] — Initial stable release

Lanius 0.2.0 is the first stable desktop release. See the [release notes](docs/releases/v0.2.0.md) for features, downloads, and installation notes.

- Capture and edit HTTP traffic with projects, Intercept, Replay, Fuzzer, Target, Decoder, and Diff.
- Find text and highlight matches in HTTP history request and response details, source views, and HTML previews.
- Install plugins from signed catalogues, use the plugin SDK, and review scanner findings and diagnostics.
- Connect AI agents through MCP, with local access controls and secret redaction.
- Use global and project Lockdown Mode to stop product outbound requests and optionally enforce project scope for proxy traffic.
- Install signed in-app updates from separate stable and nightly channels.
