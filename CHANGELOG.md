# Changelog

## Unreleased

## [0.7.0] — Pinned egress and bulk history workflows

See the [v0.7.0 release notes](docs/releases/v0.7.0.md) for downloads and installation notes. Changes since v0.6.0:

- Pin proxy, Replay, Fuzzer, and raw TCP/UDP/DNS traffic to the observed public
  IP. The guard refuses before DNS or socket creation, fails closed on expiry,
  observer failure, address mismatch, or interface and route changes, and
  closes live connections when the pin is no longer confirmed.
- Select several HTTP History rows with Ctrl/Cmd and Shift, then send them to
  Replay, bookmark, highlight, copy URLs, or delete them together.
- Label Replay and Fuzzer requests in a History **Tool** column and hide them
  from the filter, split extension presets into inspected formats and static
  assets, and search History by full request URL.
- Encode and decode selected text from the Replay, Fuzzer, and Intercept editor
  menus.
- Advance the plugin SDK to 1.7 with plugin message view tabs beside Pretty,
  Raw, and Hex, and re-read plugin manifests on reload.
- Pick interface and editor fonts from the fonts installed on this machine, and
  keep the Lanius browser profile in a chosen data folder.
- Show Replay response time in the response header, let toasts be dismissed
  directly, and build macOS Apple Silicon releases on the macos-15 runner.

## [0.6.0] — Visual target mapping and portable testing workflows

See the [v0.6.0 release notes](docs/releases/v0.6.0.md) for downloads and installation notes. Changes since v0.5.0:

- Explore captured attack surfaces with bounded interactive Target graphs across
  multiple hosts, including zoom, draggable nodes, pausable layouts, child-path
  navigation, and request inspection. Plugin SDK 1.6 also adds Target host
  context actions.
- Find and replace text directly in Replay requests, highlight valid Fuzzer
  payload markers, and preserve stray closing braces in JSON, GraphQL, and other
  request content.
- Export project settings without captured traffic and import Lanius or Burp
  settings through the file picker or drag and drop. Convert supported scope,
  Match & Replace, listener, HTTP protocol, capture, and SOCKS settings while
  excluding credentials and unsupported routes.
- Add username and password authentication to individual upstream proxy hops,
  keep credentials out of shareable JSON exports, and manage supported TLS
  cipher suites through a searchable and reorderable interface.
- Control Intercept toggling, forwarding, and dropping with configurable
  shortcuts, reorder Replay and Fuzzer tabs, identify newly transferred
  requests, and improve clipboard, toast, project, and engine-status feedback.
- Repair one layer of double-encoded UTF-8 in read-only response displays without
  changing captured bytes, use a native Save As dialog for CA certificates, and
  prevent the built-in browser from silently reusing an obsolete listener.
- Harden Lockdown Mode so plugin actions, scanners, codecs, generators, and
  background tasks cannot execute while plugins are suspended. Improve Windows
  and Linux System Capture validation and save only settings the platform can
  apply.
- Update mitmproxy and security-sensitive Python and UI dependencies, fix
  AppImage launcher permissions, and improve native window, settings, and
  destructive-action reliability.

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
