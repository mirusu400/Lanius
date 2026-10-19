# Lanius plugin packages

A `.lanius-plugin` file is a ZIP archive with `plugin.json` at its root. The
installer rejects absolute paths, parent traversal, symbolic links, duplicate
paths, archives over 50 MiB, more than 2,000 files, and expanded content over
100 MiB. Installation extracts to a temporary directory, verifies every file,
then atomically moves the package into the plugin directory.

## Manifest schema 1

```json
{
  "schema": 1,
  "id": "publisher.plugin-name",
  "name": "Display name",
  "version": "1.0.0",
  "description": "One line summary",
  "author": { "name": "Publisher" },
  "compatibility": {
    "lanius": ">=0.1,<1",
    "sdk": ">=1,<2"
  },
  "backend": {
    "runtime": "trusted",
    "entrypoint": "backend/__init__.py"
  },
  "ui": {
    "views": [
      { "id": "main", "title": "Plugin", "entrypoint": "ui/index.html", "placement": "tab" }
    ]
  },
  "permissions": ["actions.invoke", "settings.read"],
  "integrity": {
    "files": {
      "backend/__init__.py": "<lowercase SHA-256>",
      "ui/index.html": "<lowercase SHA-256>"
    }
  }
}
```

Schema 1 backend code uses the trusted runtime. It runs in the engine process
and has the same operating system access as a legacy Python addon. The UI and
permissions do not turn that backend into a sandbox; the Plugins screen labels
the package trust state so this is visible before enabling it.

Every regular file except `plugin.json` is listed in `integrity.files`. Missing,
extra, or changed files stop installation. Installed archives are checked again
before discovery, and individual UI assets are checked when served.

Read-only data can be placed under `resources/`. It remains part of
`integrity.files` and is available to backend code through
`context.resources`; no extra manifest entry is required.

## Signatures and trusted keys

Signatures use Ed25519. Add this object to the manifest:

```json
{
  "signature": {
    "algorithm": "ed25519",
    "key_id": "publisher-key-2026",
    "value": "<base64 signature>"
  }
}
```

The signed bytes are UTF-8 JSON of the whole manifest with the `signature`
member removed, sorted keys, no insignificant whitespace, and non-ASCII text
left unescaped. Trusted public keys are a JSON object at
`plugin-trusted-keys.json` in the Lanius data directory:

```json
{ "publisher-key-2026": "<base64 raw Ed25519 public key>" }
```

The official Lanius package key is pinned in the application and is available
even when this file does not exist. A local key file may add trust roots but
cannot replace a built-in key ID with different key material.

A signature from an unknown key is rejected. Local installation accepts an
unsigned package and labels it `unsigned`; catalogue installation requires a
trusted signature.

Signed catalogue sources require trusted package signatures, pin immutable
release hashes, retain update backups, support rollback, and distribute
revocations. Their index format and trust boundary are documented in
[plugin-catalogues.md](plugin-catalogues.md).

## Sandboxed UI

Each view is loaded in an iframe with an opaque origin. The iframe and response
headers both apply a script-only sandbox. Fetch/WebSocket calls, external
subresources, nested frames, and forms are blocked by the response policy. A
view cannot navigate the host, receives no referrer, and can load only
integrity-listed assets under `ui/`.

SDK 1.4 supports `placement: "tab"` for a view in the main workspace
navigation. The default `"panel"` keeps the existing Plugins view launcher.
Only loaded plugins contribute tabs; disabling, removal, safe mode, and
Lockdown suspension remove their views. Tabs retain their frame while the user
visits other tabs, so drafts survive navigation. UI assets use `no-store` because
the installed URL is reused across package updates. The frame ancestor policy
permits only the same origin and the exact existing Vite/Tauri UI origins.
Script, stylesheet, image, and font sources also explicitly include the owning
package's loopback asset directory at the configured API port. This avoids
WKWebView's opaque-origin CSP `'self'` compatibility issue while retaining the
sandbox and `connect-src 'none'`; other plugins and external origins are not
added as sources. These addresses do not come from the request Host header.

An action may return a view request to open its own declared view:

```python
return {"ui": {"view": "main", "mode": "dialog", "context": {"exchange_ids": [flow_id]}}}
```

`mode` is `"dialog"` or `"tab"` (the latter requires tab placement). The host
binds the request to the action owner, resolves its current loaded view, and
passes the JSON context only to that frame. Views use `context.get` to read it
and `ui.close` to close their dialog. A view cannot open another plugin's UI.

Views can call `clipboard.write` with `{text: "..."}` when their manifest
declares `clipboard.write`. The host uses its cross-platform clipboard writer
and limits text to 65,536 characters. Clipboard reads are not exposed.

A package can explicitly declare `ui.downloads` to allow local file downloads
from its frame. Both the iframe sandbox and response CSP add `allow-downloads`
only for that permission. The frame retains its opaque origin and cannot fetch
or open sockets. Undeclared packages keep the script-only sandbox.

The page can request a host operation with `postMessage`:

```js
parent.postMessage({
  type: "lanius.request",
  plugin: "publisher.plugin-name",
  id: "request-1",
  method: "settings.get",
  params: {}
}, "*");
```

The host replies with `lanius.response` and the same `id`. Supported methods
are `theme.get`, `context.get`, `ui.close`, `clipboard.write`, `contributions.list`, `actions.invoke`,
`settings.get`, and `settings.patch`. The last three require their matching manifest permission,
and an iframe can invoke only an action owned by its own plugin.

## Shared appearance (SDK 1.5)

A sandboxed view requests `theme.get` through the existing message bridge.
No permission is required: the result contains public UI appearance only:

- `version: 1`, the resolved `theme` name, and `colorScheme`.
- `css`: the same shared control/dialog/typography stylesheet imported by the
  main application. There is no separate plugin palette or control implementation.
- `variables`: an allowlisted mapping of resolved color roles and the interface
  and monospace font families/sizes (`--bg`, `--fg`, `--accent`, `--font-ui`, etc.).

Insert `css` into a `<style>` element before your own layout stylesheet. Apply
`variables` with `document.documentElement.style.setProperty(name, value)` and
set `document.documentElement.style.colorScheme`. Never concatenate host settings
into HTML or a CSS string. After the request, the host sends
`{type: "lanius.theme.changed", theme: <same result shape>}` whenever palette or
font settings change, including system-theme changes. Check `event.source ===
parent` for both bridge responses and appearance events. Apply these events
without reloading the document so editor drafts and selected evidence survive.

Shared primitives include standard `button`, `input`, `select` and body styles;
`.mono`, `.muted`, `.spacer`, `.dialog`, `.dialog-head`, `.dialog-body`, and
`.dialog-foot`, `.ui-toolbar`; and `.ui-form-field`, `.ui-input` (framed textarea/full-width
input), `.ui-list-item`/`.active`, `.ui-code`, `.ui-accent` and `.ui-error`.
Plugin styles should define layout and reference host role variables for layout
separators. Avoid local palettes, font stacks, and fixed font sizes. Declare
`"sdk": ">=1.5,<2"` for views that require this contract. The iframe keeps its
opaque origin, asset integrity checks, and existing network restrictions.

## Bundled reference package

The Plugins onboarding screen offers a local, installable **Request Marker**
sample. It is a complete `.lanius-plugin` package with an integrity manifest,
trusted Python backend, SDK settings and actions, a mitmproxy request hook,
plugin-owned logs, and a sandboxed statistics view. Installation copies the
bundled files into the normal plugin directory and leaves the plugin disabled.
Because no network access is involved, installation is allowed in Lockdown
Mode; plugin execution remains suspended until Lockdown is left.

The bundled **MCP Notes** package demonstrates SDK 1.3 tools for reading and
writing local project notes through the running engine's HTTP MCP endpoint.
See [Plugin MCP Tools](plugin-mcp.md) for installation and authoring examples.

## Development mode

Set `LANIUS_PLUGIN_DEV_MODE=1` before starting the engine. The Plugins screen
then accepts a local package directory and installs a symbolic link rather than
copying it. Source changes are watched and automatic reload is enabled. Removing
the development plugin deletes only the link. Development mode skips integrity
hash checks so edited files can reload, and the plugin is visibly labelled
`development`.
