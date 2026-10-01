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
      { "id": "main", "title": "Plugin", "entrypoint": "ui/index.html" }
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
are `contributions.list`, `actions.invoke`, `settings.get`, and
`settings.patch`. The latter three require their matching manifest permission,
and an iframe can invoke only an action owned by its own plugin.

## Bundled reference package

The Plugins onboarding screen offers a local, installable **Request Marker**
sample. It is a complete `.lanius-plugin` package with an integrity manifest,
trusted Python backend, SDK settings and actions, a mitmproxy request hook,
plugin-owned logs, and a sandboxed statistics view. Installation copies the
bundled files into the normal plugin directory and leaves the plugin disabled.
Because no network access is involved, installation is allowed in Lockdown
Mode; plugin execution remains suspended until Lockdown is left.

## Development mode

Set `LANIUS_PLUGIN_DEV_MODE=1` before starting the engine. The Plugins screen
then accepts a local package directory and installs a symbolic link rather than
copying it. Source changes are watched and automatic reload is enabled. Removing
the development plugin deletes only the link. Development mode skips integrity
hash checks so edited files can reload, and the plugin is visibly labelled
`development`.
