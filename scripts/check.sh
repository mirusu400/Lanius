#!/usr/bin/env bash
# Everything CI would check, run locally.
#
# CI takes minutes to answer and the macOS runner is far slower than this
# machine, so waiting on it after every commit wastes both time and the
# project's Actions minutes. This gives the same answer in well under a
# minute, which means push once the checks pass rather than pushing to
# find out.
#
#   scripts/check.sh          engine, ui and shell
#   scripts/check.sh engine   just one of them
#   scripts/check.sh quick    skip the slowest parts, for a tight loop

set -uo pipefail
cd "$(dirname "$0")/.."

target="${1:-all}"
failed=0
start=$(date +%s)

step() {
  local name="$1"; shift
  local dir="."
  if [ "$1" = "--in" ]; then dir="$2"; shift 2; fi
  local out
  local began
  began=$(date +%s)
  if out=$(cd "$dir" && "$@" 2>&1); then
    printf '  ok   %-28s %ss\n' "$name" "$(( $(date +%s) - began ))"
  else
    printf '  FAIL %-28s %ss\n' "$name" "$(( $(date +%s) - began ))"
    printf '%s\n' "$out" | tail -25 | sed 's/^/       /'
    failed=1
  fi
}

if [ "$target" = "all" ] || [ "$target" = "quick" ] || [ "$target" = "engine" ]; then
  echo "engine"
  if [ "$target" = "quick" ]; then
    # -x stops at the first failure: in a tight loop the first one is the
    # one being worked on, and the rest is noise.
    step "tests" --in engine .venv/bin/python -m pytest -q -x
  else
    step "tests" --in engine .venv/bin/python -m pytest -q
  fi
  step "types" --in engine .venv/bin/python -m mypy
fi

if [ "$target" = "all" ] || [ "$target" = "quick" ] || [ "$target" = "ui" ]; then
  echo "ui"
  step "types" npm --prefix ui run typecheck
  step "lint" npm --prefix ui run lint
  step "css" node ui/scripts/check-css.mjs
  if [ "$target" = "quick" ]; then
    step "tests" npm --prefix ui run test -- --run
  else
    # Both locales: assertions look strings up by key, so a hardcoded one
    # passes in English and fails in Korean.
    step "tests (both locales)" npm --prefix ui run test:locales
    step "build" npm --prefix ui run build
  fi
fi

if [ "$target" = "all" ] || [ "$target" = "shell" ]; then
  echo "shell"
  # tauri resolves bundle resources at compile time, so clippy cannot run
  # without a frozen engine. CI writes a placeholder; do the same here
  # rather than freezing the real thing for a lint pass.
  if [ ! -e engine/dist/lanius-engine ]; then
    mkdir -p engine/dist
    : > engine/dist/lanius-engine
    placeholder=1
  fi
  step "format" cargo fmt --manifest-path shell/src-tauri/Cargo.toml --check
  step "clippy" cargo clippy --manifest-path shell/src-tauri/Cargo.toml --all-targets -- -D warnings
  step "tests" cargo test --manifest-path shell/src-tauri/Cargo.toml
  if [ "${placeholder:-0}" = "1" ]; then
    rm -f engine/dist/lanius-engine
  fi
fi

if [ "$target" = "all" ]; then
  echo "workflows"
  step "actionlint" actionlint
fi

echo
if [ "$failed" = "0" ]; then
  echo "all checks passed in $(( $(date +%s) - start ))s"
else
  echo "checks failed in $(( $(date +%s) - start ))s"
fi
exit "$failed"
