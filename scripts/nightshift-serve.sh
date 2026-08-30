#!/bin/sh
set -eu

: "${SWAMP_SERVE_ADMIN:?set SWAMP_SERVE_ADMIN to the token principal, for example user:nightshift-orchestrator}"

exec swamp serve \
  --repo-dir "$(git rev-parse --show-toplevel)" \
  --host 127.0.0.1 \
  --port "${SWAMP_SERVE_PORT:-9090}" \
  --auth-mode token \
  --admins "$SWAMP_SERVE_ADMIN" \
  --hot-reload
