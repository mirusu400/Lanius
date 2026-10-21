# Changelog

## Unreleased

## [0.5.0] — Deeper inspection and scalable traffic workflows

See the [v0.5.0 release notes](docs/releases/v0.5.0.md) for downloads and installation notes. Changes since v0.4.0:

- Inspect selected request and response data with automatic or manual decoding,
  chain URL, Base64, hex, HTML, escape, gzip, and JWT steps, and re-encode
  Replay edits through the same chain while preserving their original style.
- Customize HTTP History with side-by-side or stacked layouts, reorderable and
  hideable columns, editable page sizes, stable request-number sorting, manual
  body charsets, and new viewer controls. Optionally record public IP changes
  and show the estimated address for each captured connection.
- Keep large projects responsive with batched capture writes, faster cancellable
  searches, bounded and virtualized body views, configurable document caching,
  streamed raw bodies, request-only editor transfers, and visible startup,
  migration, and cleanup progress.
- Run multiple proxy listeners, choose Auto or force HTTP/1.0, HTTP/1.1, or
  HTTP/2 upstream, inspect the protocol actually used, and diagnose upstream
  TLS failures with project-wide or exact-host verification overrides.
- Follow redirects safely in Replay, generate and transform numeric, character,
  and date payloads in Fuzzer, and use browser-emulation Match & Replace presets.
  Improve failed-run handling, request numbering, and Intercept draft safety.
- Advance the plugin SDK to 1.5 with plugin-owned HTTP MCP tools, workspace tabs,
  durable exchange access and atomic storage batches, clipboard and download
  permissions, and host-provided styles with live theme updates. See
  [Plugin MCP Tools](docs/plugin-mcp.md).
- Edit complete scope rules in Target, restrict capture to scope by default, and
  seed editable Google background-host exclusions. Tighten Lockdown scope egress
  so connection destinations cannot bypass the active HTTP/HTTPS scope.
- Add startup Doctor checks, project-size reporting, configurable action toasts,
  safer external-link handling, and fixed-name nightly downloads. Fix workspace
  restoration, stale Decoder results, plugin-view loading, and large-body errors.
- Update Vite, rustls, and web PKI dependencies for current security advisories,
  while keeping npm and Rust security audits enforced in CI.

## [0.4.0] — Persistent testing workflows and platform reliability

See the [v0.4.0 release notes](docs/releases/v0.4.0.md) for downloads and installation notes. Changes since v0.3.0:

- Preserve Fuzzer runs and multiple drafts, add progress while searching HTTP history and exporting projects, and restore workspace tabs on launch.
- Share editor undo history and request context menus, highlight HTTP details in Replay and Fuzzer, and add configurable shortcuts for sending requests to them.
- Search settings, configure media body storage limits, and import SQLite project databases with faster history access.
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
