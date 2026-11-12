# Development

## Building from source

You need Python 3.13 or newer, Node 22 and a Rust toolchain. Builds run on macOS,
Linux and Windows.

```bash
# Engine
cd engine
python3.13 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
# Temporary security override until mitmproxy allows Brotli 1.2.1.
python -m pip install --no-deps "Brotli>=1.2.1"

# Desktop app
.venv/bin/pyinstaller --clean --noconfirm lanius-engine.spec
cd ../shell && npm ci && npx tauri build
```

To run the pieces separately while developing:

```bash
cd engine && python -m app.main    # proxy on :8080, API/MCP on :12954
cd ui && npm run dev               # interface on :5173
```

## Checks

Everything CI checks also runs locally, in well under a minute:

```bash
scripts/check.sh          # engine, ui and shell, as CI would
scripts/check.sh quick    # the fast subset, for a tight loop
scripts/check.sh engine   # one part only
```

To repeat the disposable database benchmark after installing engine dependencies:

```bash
engine/.venv/bin/python scripts/benchmark_large_project.py --rows 2000000
```

It creates a temporary project database, measures its upgrade and common
queries, then removes it. It does not measure proxy network throughput or UI
frame rate.

## Releasing with the in-app updater

Signed builds can install themselves: Settings, About offers **Install and
restart**, which downloads the new bundle, verifies its signature, replaces
the app (engine included) and comes back up. It is off until the repository
has a signing key, and until then the app only links to the download.

One-time setup:

```bash
cd shell && npx tauri signer generate -w ~/.tauri/lanius.key
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/lanius.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # the password you chose
```

Then paste the public half into `pubkey` in
`shell/src-tauri/tauri.updater.conf.json` and commit it. The private key
never leaves your machine and the secrets; anyone holding it can publish a
build that every installation will accept, so treat it as the release key it
is. Nightly builds then carry a version of the form
`0.7.1-nightly.20261112T1009.42`, and each published channel has a `latest.json`
for the in-app updater. Stable builds check the latest stable release;
nightly builds check the rolling nightly release.

To publish a stable version, update the engine, Tauri, shell package and lock
file versions, write `docs/releases/vX.Y.Z.md` and update `CHANGELOG.md`, then
push a matching `vX.Y.Z` tag. The stable workflow reuses successful `main` CI
for the exact tagged commit, or runs CI on the tag when no main run exists. It
builds all four desktop targets, requires signed updater bundles for each,
and publishes the GitHub Release only when every job succeeds.

Debian packages cannot replace themselves, so `.deb` installs keep using the
download link. macOS builds are still unsigned by Apple, so the first launch
after an update can show the usual unidentified-developer warning.
