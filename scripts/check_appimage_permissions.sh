#!/usr/bin/env bash

# Inspect the SquashFS metadata rather than `--appimage-extract`: extraction
# can normalize permissions and hide a broken launcher from this check.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 path/to/application.AppImage" >&2
  exit 2
fi

appimage="$1"
if [ ! -f "$appimage" ]; then
  echo "AppImage not found: $appimage" >&2
  exit 1
fi

offset="$("$appimage" --appimage-offset)"
listing="$(unsquashfs -o "$offset" -ll "$appimage" AppRun AppRun.wrapped)"
printf '%s\n' "$listing"

for entry in AppRun AppRun.wrapped; do
  mode="$(printf '%s\n' "$listing" | awk -v entry="$entry" '
    {
      count = split($NF, parts, "/")
      if (parts[count] == entry) {
        print $1
        exit
      }
    }
  ')"

  if [[ ! "$mode" =~ ^-.{6}r-x$ ]]; then
    echo "$entry must be readable and executable by every user; found '${mode:-missing}'" >&2
    exit 1
  fi
done

echo "AppImage launchers are readable and executable by every user"
