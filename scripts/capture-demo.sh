#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"

usage() { printf 'Usage: scripts/capture-demo.sh tui|web\n'; }

case "$MODE" in
  # Headless: VHS records a virtual terminal; no window, display, or
  # screen-recording permission is involved.
  tui) exec node "$ROOT/scripts/capture-tui-media.mjs" ;;
  web) exec node "$ROOT/scripts/capture-readme-media.mjs" ;;
  *) usage >&2; exit 64 ;;
esac
