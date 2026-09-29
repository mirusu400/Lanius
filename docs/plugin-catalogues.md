# Signed plugin catalogues

The Plugins tab can browse any catalogue whose URL and Ed25519 public key the
user has added as a source. Catalogue access is explicit: opening the tab reads
the last verified cache, while **Refresh catalogue** performs network requests.
HTTPS is required except for loopback development servers.

Catalogue packages still use the manifest signature described in
[plugin-packages.md](plugin-packages.md). The catalogue signature authenticates
the index; the package signature authenticates the code. The package signer
must be present in `plugin-trusted-keys.json` before catalogue installation.

## Source configuration

Sources can be managed in the Plugins tab or in `plugin-catalogues.json` under
the Lanius data directory:

```json
{
  "schema": 1,
  "sources": [
    {
      "id": "community",
      "title": "Community plugins",
      "url": "https://plugins.example/catalogue.json",
      "public_key": "<base64 raw Ed25519 public key>",
      "key_id": "catalogue-2026",
      "enabled": true
    }
  ]
}
```

The public key is pinned locally. A catalogue cannot replace its own key.
Changing a source key is an explicit local configuration change.

## Catalogue schema 1

```json
{
  "schema": 1,
  "generated_at": "2026-09-29T00:00:00Z",
  "plugins": [
    {
      "id": "publisher.plugin-name",
      "name": "Plugin name",
      "description": "One line summary",
      "author": "Publisher",
      "categories": ["scanner"],
      "releases": [
        {
          "version": "1.0.0",
          "url": "https://plugins.example/publisher.plugin-name-1.0.0.lanius-plugin",
          "sha256": "<lowercase SHA-256>",
          "package_key_id": "publisher-key-2026",
          "compatibility": {
            "lanius": ">=0.1,<1",
            "sdk": ">=1,<2"
          },
          "published_at": "2026-09-29T00:00:00Z"
        }
      ]
    }
  ],
  "revoked": [
    {
      "plugin": "publisher.plugin-name",
      "version": "0.9.0",
      "reason": "security issue"
    }
  ],
  "signature": {
    "algorithm": "ed25519",
    "key_id": "catalogue-2026",
    "value": "<base64 signature>"
  }
}
```

The signed bytes are canonical UTF-8 JSON of the catalogue with `signature`
removed: keys sorted, no insignificant whitespace, and non-ASCII text left
unescaped. Every plugin ID and version is unique within the catalogue.

## Release guarantees

Once a source has published a plugin version, later refreshes cannot change
any metadata for that version. To correct or replace a release, publish a new
version. A refresh that changes an existing URL, digest, compatibility range,
or other release field is rejected and the previous verified cache remains in
use.

Installation checks the downloaded archive against the catalogue SHA-256,
then checks the package manifest, every package file digest, the package ID and
version, compatibility ranges, and the package signature. `package_key_id`
also binds each release to its expected package signing key. Downloads are
capped at 50 MiB and catalogue indexes at 5 MiB.

Updating keeps the previous verified package under the plugin backup directory.
The Plugins tab offers rollback to the most recent retained version. Rolling
back swaps the two verified package directories atomically, so the replaced
version remains available for a later rollback.

Revocations are scoped to the catalogue source that installed the package. A
revoked version disappears from runtime discovery and cannot be installed or
used as a rollback target. The package remains on disk for investigation or
manual removal.
