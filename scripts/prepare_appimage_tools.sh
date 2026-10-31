#!/usr/bin/env bash

# Tauri CLI 2.11.4 caches its AppImage launcher with mode 0770. linuxdeploy
# preserves that mode as AppRun.wrapped, so users outside the build runner's
# owner/group cannot start the finished AppImage. Seed the same upstream
# launcher with distribution-safe permissions before Tauri prepares its tools.

set -euo pipefail

readonly apprun_url="https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64"
readonly apprun_sha256="f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f"

tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
launcher="$tools_dir/AppRun-x86_64"
mkdir -p "$tools_dir"

if [ -f "$launcher" ] && printf '%s  %s\n' "$apprun_sha256" "$launcher" | sha256sum --check --status; then
  chmod 0755 "$launcher"
else
  download="$(mktemp "$tools_dir/AppRun-x86_64.download.XXXXXX")"
  trap 'rm -f "$download"' EXIT INT TERM

  curl --fail --location --retry 3 "$apprun_url" --output "$download"
  printf '%s  %s\n' "$apprun_sha256" "$download" | sha256sum --check
  chmod 0755 "$download"
  mv -f "$download" "$launcher"
  trap - EXIT INT TERM
fi

mode="$(stat -c '%a' "$launcher")"
if [ "$mode" != "755" ]; then
  echo "AppImage launcher has mode $mode, expected 755" >&2
  exit 1
fi

echo "Prepared verified AppImage launcher at $launcher (mode $mode)"
