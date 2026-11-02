#!/usr/bin/env bash
# Capture live/demo, blocked, and compact TUI screenshots using VHS and the
# release binary. Demo sockets are isolated; --connect-herdr explicitly opts
# into the user's live source. Existing images require --force.
# Usage: npm run media -- capture tui-states [--force] [--connect-herdr]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS="${ROOT}/docs/assets"
BINARY="${ROOT}/target/release/herdr-mise"
TMPDIR_CAPTURE="$(mktemp -d -t herdr-mise-tui-states.XXXXXX)"
METADATA="${ROOT}/scripts/media/tui-states.capture.json"

LIVE_PNG="${ASSETS}/herdr-mise-tui-live.png"
BLOCKED_PNG="${ASSETS}/herdr-mise-tui-blocked.png"
COMPACT_PNG="${ASSETS}/herdr-mise-tui-compact.png"

# Live/blocked capture envelope (width x height in pixels).
# 1100x560 is the tape Set Width/Height. The captured PNG is 1100x800
# because ttyd adds the 28-pixel WindowBar + padding to the GIF frame;
# the actual terminal grid is ~110 cols x 28 rows, above the 80x24 scene
# minimum and wide enough for the 3x2 station grid. Chef sprites fit at
# this envelope (the L1 envelope loss only kicks in when ≥4 agents dilute
# station height below 14+6=20 half-rows).
LIVE_ENV_WIDTH=1100
LIVE_ENV_HEIGHT=560
# Compact capture envelope: below the 80x24 scene minimum so the binary
# renders the Kitchen status table fallback. 660x352 ≈ 66 cols x 18 rows —
# view.rs:130 enters the compact branch when height < 20, and layout.rs's
# MIN_SCENE_PIXEL_HEIGHT=48 (24 cell rows) also falls back. The PNG is
# genuine compact-fallback evidence, not a small render of the scene.
COMPACT_ENV_WIDTH=660
COMPACT_ENV_HEIGHT=352

DEADLINE_LIVE_SECONDS=10
DEADLINE_DEMO_SECONDS=8
DEADLINE_COMPACT_SECONDS=4

FORCE=0
CONNECT_HERDR=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --connect-herdr) CONNECT_HERDR=1 ;;
    -h|--help)
      sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "capture-tui-states.sh: unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

log() { printf 'capture-tui-states: %s\n' "$*"; }
fail() { local code="$1"; shift; printf 'capture-tui-states: %s\n' "$*" >&2; exit "$code"; }

# Detect the user's Herdr socket. The client's capture contract defaults to
# ~/.config/herdr/herdr.sock; the Herdr CLI exposes the same path. If the
# socket is missing AND --connect-herdr was passed, the live capture fails
# closed so we never claim a "live" image we did not actually capture.
HERDR_SOCKET_CANDIDATES=(
  "${HERDR_SOCKET_PATH:-}"
  "${XDG_CONFIG_HOME:-$HOME/.config}/herdr/herdr.sock"
  "$HOME/.config/herdr/herdr.sock"
)
ORIG_HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-}"
DEMO_SOCKET="${TMPDIR_CAPTURE}/herdr.sock"
LIVE_SOCKET="$DEMO_SOCKET"
for cand in "${HERDR_SOCKET_CANDIDATES[@]}"; do
  if [[ -n "$cand" && -S "$cand" ]]; then
    LIVE_SOCKET="$cand"
    break
  fi
done

cleanup() {
  set +e
  if [[ -n "$ORIG_HERDR_SOCKET_PATH" ]]; then
    export HERDR_SOCKET_PATH="$ORIG_HERDR_SOCKET_PATH"
  else
    unset HERDR_SOCKET_PATH
  fi
  if [[ -n "${VHS_PID:-}" ]] && kill -0 "$VHS_PID" 2>/dev/null; then
    kill "$VHS_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_CAPTURE"
}
trap cleanup EXIT INT TERM

if ! command -v vhs >/dev/null 2>&1; then
  fail 2 "vhs is not on PATH. Install via 'brew install vhs' and re-run."
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  fail 2 "ffmpeg is not on PATH. Install via 'brew install ffmpeg' and re-run."
fi
if ! command -v sips >/dev/null 2>&1; then
  fail 2 "sips is not on PATH (macOS only)."
fi
if ! command -v identify >/dev/null 2>&1; then
  fail 2 "identify (ImageMagick) is not on PATH. Install via 'brew install imagemagick' and re-run."
fi
if ! command -v tesseract >/dev/null 2>&1; then
  fail 2 "tesseract is not on PATH. Install via 'brew install tesseract' and re-run."
fi
VHS_VERSION="$(vhs --version 2>&1 | head -n 1 || true)"
log "vhs detected: $VHS_VERSION"

mkdir -p "$ASSETS"
if [[ -e "$LIVE_PNG" && "$FORCE" -ne 1 ]]; then
  fail 5 "$LIVE_PNG already exists (pass --force to overwrite)"
fi
if [[ -e "$BLOCKED_PNG" && "$FORCE" -ne 1 ]]; then
  fail 5 "$BLOCKED_PNG already exists (pass --force to overwrite)"
fi
if [[ -e "$COMPACT_PNG" && "$FORCE" -ne 1 ]]; then
  fail 5 "$COMPACT_PNG already exists (pass --force to overwrite)"
fi

# Build the release binary if missing. The script does not fall back to a
# debug binary, a mock, or the browser.
if [[ ! -x "$BINARY" ]]; then
  log "release binary missing; building (this may take ~30s)..."
  if ! (cd "$ROOT" && cargo build --release --bin herdr-mise --locked) >"$TMPDIR_CAPTURE/build.log" 2>&1; then
    log "build failed; tail of build.log:"
    tail -n 20 "$TMPDIR_CAPTURE/build.log" >&2
    fail 3 "cargo build --release failed"
  fi
fi
if [[ ! -x "$BINARY" ]]; then
  fail 4 "release binary still missing after build: $BINARY"
fi
BIN_SHA="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
log "release binary: target/release/herdr-mise"
log "sha256: $BIN_SHA"

# write_tape <out-tape> <width> <height> <sleep-seconds> <output-gif>
write_tape() {
  local tape="$1" width="$2" height="$3" sleep="$4" out_gif="$5"
  cat >"$tape" <<EOF
Output "$out_gif"

Require bash
Require ./target/release/herdr-mise
Require vhs

Set Shell bash
Set FontSize 14
Set FontFamily "DejaVu Sans Mono, monospace"
Set Width $width
Set Height $height
Set Padding 24
Set MarginFill "#0b141a"
Set Margin 0
Set BorderRadius 0
Set WindowBar Colorful
Set WindowBarSize 28
Set TypingSpeed 0ms
Set Framerate 20

Type "./target/release/herdr-mise --tui"
Enter

Sleep ${sleep}s

Type "q"
Sleep 500ms
EOF
}

# extract_middle_frame <input-gif> <output-png>
# Pick the frame at ~70% of the timeline so the chrome has stabilized and any
# blocked banner has had time to render a non-zero MM:SS timer.
extract_middle_frame() {
  local in_gif="$1" out_png="$2"
  local probe
  probe="$(identify "$in_gif" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ -z "$probe" || "$probe" -lt 1 ]]; then
    fail 7 "identify returned no frames for $in_gif"
  fi
  local target=$(( probe * 70 / 100 ))
  if [[ "$target" -lt 1 ]]; then target=1; fi
  if [[ "$target" -gt "$probe" ]]; then target=$probe; fi
  log "  extracting frame ${target} of ${probe} from $in_gif"
  if ! ffmpeg -y -i "$in_gif" -vf "select=eq(n\\,$((target - 1)))" -vframes 1 "$out_png" >"$TMPDIR_CAPTURE/ffmpeg.log" 2>&1; then
    log "  ffmpeg failed; tail of ffmpeg.log:"
    tail -n 10 "$TMPDIR_CAPTURE/ffmpeg.log" >&2
    fail 7 "ffmpeg frame extraction failed for $in_gif"
  fi
  if [[ ! -s "$out_png" ]]; then
    fail 7 "Extracted PNG is empty: $out_png"
  fi
}

# assert_compact_fallback <output-png>
# Fails closed if the rendered PNG does not contain "Kitchen status" — the
# binary's compact-fallback title. This guards against the harness silently
# shipping a wrongly-sized scene render.
assert_compact_fallback() {
  local png="$1"
  if ! sips -g all "$png" >/dev/null 2>&1; then
    fail 7 "sips could not read $png"
  fi
  local ocr
  ocr="$(tesseract "$png" stdout 2>/dev/null || true)"
  if [[ "$ocr" != *"Kitchen status"* ]]; then
    fail 9 "compact capture did not contain the Kitchen status table fallback"
  fi
  log "  compact fallback OCR passed: Kitchen status"
}

run_capture() {
  local label="$1" out_png="$2" width="$3" height="$4" sleep="$5"
  local gif="$TMPDIR_CAPTURE/${label}.gif"
  local tape="$TMPDIR_CAPTURE/${label}.tape"
  write_tape "$tape" "$width" "$height" "$sleep" "$gif"
  log "capturing ${label}: width=${width} height=${height} sleep=${sleep}s"
  # Run vhs from the repo root so the tape's ./target/release/herdr-mise
  # relative path resolves; the absolute Output path stays in TMPDIR_CAPTURE
  # so the original asset is never overwritten on failure.
  (cd "$ROOT" && vhs "$tape") >"$TMPDIR_CAPTURE/${label}.vhs.log" 2>&1 &
  VHS_PID=$!
  wait "$VHS_PID" || { log "vhs failed; tail of ${label}.vhs.log:"; tail -n 30 "$TMPDIR_CAPTURE/${label}.vhs.log" >&2; fail 6 "vhs exited non-zero for ${label}"; }
  VHS_PID=""
  if [[ ! -s "$gif" ]]; then
    fail 7 "GIF not produced for ${label}: $gif"
  fi
  extract_middle_frame "$gif" "$out_png"
}

# 1. Live capture. Default: demo-isolated socket so the first PNG shows the
#    truthful DEMO SERVICE shell with the placeholder demo roster. With
#    --connect-herdr, point at the user's existing Herdr socket; the resulting
#    image is suitable for publication only when that session contains
#    intentionally public verifier labels. If the socket does not exist, fail
#    closed so we never claim a live frame we did not actually capture.
LIVE_MODE="demo"
LIVE_SOCKET_PATH="$DEMO_SOCKET"
if [[ "$CONNECT_HERDR" -eq 1 ]]; then
  if [[ "$LIVE_SOCKET" == "$DEMO_SOCKET" ]]; then
    fail 8 "--connect-herdr requested but no Herdr socket was found at $HOME/.config/herdr/herdr.sock, \$HERDR_SOCKET_PATH, or \$XDG_CONFIG_HOME/herdr/herdr.sock. Live capture failed closed."
  fi
  LIVE_MODE="connected"
  LIVE_SOCKET_PATH="$LIVE_SOCKET"
fi

export HERDR_SOCKET_PATH="$LIVE_SOCKET_PATH"
run_capture "live" "$LIVE_PNG" "$LIVE_ENV_WIDTH" "$LIVE_ENV_HEIGHT" "$DEADLINE_LIVE_SECONDS"
unset HERDR_SOCKET_PATH

# 2. Blocked capture. Always demo-isolated so the user's live session is
#    never touched. The binary's deterministic demo schedule includes a
#    blocked Claude, so the rendered frame shows the red double-line
#    border + in-station banner + pass banner + MM:SS timer.
export HERDR_SOCKET_PATH="${TMPDIR_CAPTURE}/herdr-blocked.sock"
export HERDR_MISE_DEMO_COUNT=6
run_capture "blocked" "$BLOCKED_PNG" "$LIVE_ENV_WIDTH" "$LIVE_ENV_HEIGHT" "$DEADLINE_DEMO_SECONDS"
unset HERDR_SOCKET_PATH

# 3. Compact capture. Drive at 660x352 (~66 cols x 18 rows) so the binary
#    falls back to the "Kitchen status" table view per view.rs (height < 20)
#    and layout.rs (MIN_SCENE_WIDTH=80). The
#    compact PNG is genuine fallback evidence.
export HERDR_SOCKET_PATH="${TMPDIR_CAPTURE}/herdr-compact.sock"
export HERDR_MISE_DEMO_COUNT=6
run_capture "compact" "$COMPACT_PNG" "$COMPACT_ENV_WIDTH" "$COMPACT_ENV_HEIGHT" "$DEADLINE_COMPACT_SECONDS"
unset HERDR_SOCKET_PATH
assert_compact_fallback "$COMPACT_PNG"

# Verify each PNG and record dimensions.
declare -a CAPTURE_ROWS=()
record_png() {
  local label="$1" png="$2" mode="$3" width="$4" height="$5" sleep="$6"
  local bytes sips_w sips_h
  bytes="$(wc -c <"$png" | tr -d ' ')"
  sips_w="$(sips -g pixelWidth "$png" 2>/dev/null | awk '/pixelWidth:/{print $2}')"
  sips_h="$(sips -g pixelHeight "$png" 2>/dev/null | awk '/pixelHeight:/{print $2}')"
  log "captured: $png"
  log "  bytes:        $bytes"
  log "  dimensions:   ${sips_w}x${sips_h}"
  log "  mode:         $mode"
  log "  width x height (tape): ${width}x${height}"
  log "  sleep:        ${sleep}s"
  CAPTURE_ROWS+=("$label|$png|$bytes|${sips_w}x${sips_h}|$mode|${width}x${height}|${sleep}")
}

record_png "live" "$LIVE_PNG" "$LIVE_MODE" "$LIVE_ENV_WIDTH" "$LIVE_ENV_HEIGHT" "$DEADLINE_LIVE_SECONDS"
record_png "blocked" "$BLOCKED_PNG" "demo" "$LIVE_ENV_WIDTH" "$LIVE_ENV_HEIGHT" "$DEADLINE_DEMO_SECONDS"
record_png "compact" "$COMPACT_PNG" "demo" "$COMPACT_ENV_WIDTH" "$COMPACT_ENV_HEIGHT" "$DEADLINE_COMPACT_SECONDS"

# Persist a machine-readable capture record for the handoff.
python3 - "$METADATA" "$BIN_SHA" "$VHS_VERSION" "${CAPTURE_ROWS[@]}" "$LIVE_SOCKET_PATH" "$LIVE_MODE" <<'PY'
import json, sys
from pathlib import Path

path, sha, vhs, *rows = sys.argv[1:]
live_socket, live_mode = rows[-2], rows[-1]
items = []
for row in rows[:-2]:
    label, png, nbytes, dims, mode, env, sleep = row.split("|")
    items.append({
        "label": label,
        "output": str(Path(png).relative_to(Path(path).parent.parent.parent)),
        "bytes": int(nbytes),
        "dimensions": dims,
        "mode": mode,
        "env_width_height": env,
        "sleep_seconds": int(sleep),
    })
with open(path, "w") as f:
    json.dump({
        "schema": "tui-states-capture-v1",
        "binary": "target/release/herdr-mise",
        "binary_sha256": sha,
        "vhs_version": vhs,
        "live_herdr_socket": "connected" if live_mode == "connected" else "isolated",
        "live_mode": live_mode,
        "items": items,
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY

log "ok"
exit 0
