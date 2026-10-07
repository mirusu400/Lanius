# Changelog

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
