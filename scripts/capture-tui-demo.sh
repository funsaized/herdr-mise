#!/usr/bin/env bash
# Capture the real Phase 2 TUI pane to docs/assets/herdr-mise-tui-demo.gif.
#
# Why this exists:
#   The plan's deliverable 8 requires a README demo GIF of the pane
#   captured from the real shipped TUI binary, not a browser substitute.
#   The browser already has `capture-readme-media.mjs`; this wrapper is
#   the deliberately narrow, TUI-only counterpart.
#
# Fail-closed contract (no fallback tools, no fabricated media):
#   1. Requires `vhs` on PATH (installed system-wide; not a repo dep).
#      Refuses to silently substitute another tool.
#   2. Requires `./target/release/herdr-mise` to exist. The script
#      will run a release build if it's missing, but will NOT fall
#      back to a debug binary, a mock, or the browser.
#   3. Refuses to overwrite an existing `herdr-mise-tui-demo.gif`
#      unless `--force` is passed.
#   4. Isolates the herdr socket path to a temp directory so the
#      capture never talks to a real Herdr session; the pane renders
#      the truthful DEMO SERVICE treatment. The original env var, if
#      any, is restored on exit (trap).
#   5. Writes the GIF to `docs/assets/`. Writes machine-readable
#      capture metadata to `scripts/tui-demo.tape.capture.json` next to
#      the source tape. Removes temp paths before exit. Does NOT
#      `pkill` unrelated processes; only reaps the vhs child by PID.
#   6. Prints tool versions, the exact capture command, and the GIF
#      metadata after capture so the handoff can quote them verbatim.
#
# Usage:
#   scripts/capture-tui-demo.sh [--force]
#
# Exit codes:
#   0  GIF captured and verified.
#   2  vhs missing.
#   3  Build failed.
#   4  Binary missing after build.
#   5  Output already exists (without --force).
#   6  VHS failed.
#   7  GIF verification failed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAPE="${ROOT}/scripts/tui-demo.tape"
METADATA="${TAPE}.capture.json"
ASSETS="${ROOT}/docs/assets"
OUTPUT="${ASSETS}/herdr-mise-tui-demo.gif"
BINARY="${ROOT}/target/release/herdr-mise"
TMPDIR_CAPTURE="$(mktemp -d -t herdr-mise-tui-capture.XXXXXX)"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "capture-tui-demo.sh: unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

log() { printf 'capture-tui-demo: %s\n' "$*"; }
fail() { printf 'capture-tui-demo: %s\n' "$*" >&2; exit "$1"; }

# Always restore env + clean temp + reap vhs child, even on failure
# paths. Idempotent. NEVER kills unrelated processes.
ORIG_HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-}"
cleanup() {
  set +e
  # Restore socket path env so a future invocation sees what the user
  # intended (not the demo-time isolation path).
  if [[ -n "$ORIG_HERDR_SOCKET_PATH" ]]; then
    export HERDR_SOCKET_PATH="$ORIG_HERDR_SOCKET_PATH"
  else
    unset HERDR_SOCKET_PATH
  fi
  # Reap only the vhs child we forked, by its recorded PID. VHS spawns
  # ttyd + Chromium itself; on script exit the vhs parent already
  # returns, so this is defensive against vhs hanging. We deliberately
  # do NOT use `pkill -P` against the broader process tree because
  # nothing else in this script forks — only vhs does.
  if [[ -n "${VHS_PID:-}" ]] && kill -0 "$VHS_PID" 2>/dev/null; then
    kill "$VHS_PID" 2>/dev/null || true
  fi
  # Remove the temp socket dir.
  rm -rf "$TMPDIR_CAPTURE"
}
trap cleanup EXIT INT TERM

# 1. vhs is required. We do not silently substitute another tool.
if ! command -v vhs >/dev/null 2>&1; then
  fail 2 "vhs is not on PATH. The plan asks for it; install via 'brew install vhs' and re-run. Do not edit the tape to use a different tool."
fi
VHS_VERSION="$(vhs --version 2>&1 | head -n 1 || true)"
log "vhs detected: $VHS_VERSION"

# 2. Build if the release binary is missing. The plan's Phase 2 build
# contract is `cargo build --release --bin herdr-mise`. We always use
# the release binary so the GIF shows the same binary the marketplace
# ships.
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

# 3. Refuse to clobber an existing GIF unless --force.
mkdir -p "$ASSETS"
if [[ -e "$OUTPUT" && "$FORCE" -ne 1 ]]; then
  fail 5 "output already exists: $OUTPUT (pass --force to overwrite)"
fi

# 4. Isolate the herdr socket path to a non-existent temp file. The
# capture binary will fail to connect and render the truthful DEMO
# SERVICE treatment; this never touches the user's real Herdr session.
export HERDR_SOCKET_PATH="$TMPDIR_CAPTURE/herdr.sock"
export HERDR_MISE_DEMO_COUNT=6
export TERM=xterm-256color
export COLORTERM=truecolor

# 5. Run VHS. It forks ttyd + Chromium itself; we record the vhs
# child PID so the EXIT trap can reap it.
log "running: vhs scripts/tui-demo.tape"
vhs "$TAPE" &
VHS_PID=$!
wait "$VHS_PID" || fail 6 "vhs exited non-zero"

if [[ ! -s "$OUTPUT" ]]; then
  fail 7 "GIF not produced: $OUTPUT"
fi

# 6. Verify the GIF metadata with `sips` (always on macOS) and
# `identify` (VHS bundles ImageMagick via ffmpeg's brew tap on macOS).
GIF_DIM_RAW="$(file "$OUTPUT" | sed -En 's/.*GIF image data, version [0-9a-z]+, ([0-9]+) x ([0-9]+).*/\1x\2/p' | head -n 1)"
GIF_BYTES="$(wc -c < "$OUTPUT" | tr -d ' ')"
SIPS_DIM="$(sips -g pixelWidth -g pixelHeight "$OUTPUT" 2>/dev/null | awk '/pixel(W|H)/{printf "%s", $2; if (/Height/) printf "x"; else printf "x"}' | sed 's/x$//')"
# Frame count via `identify`. The output enumerates one frame per line.
IDENTIFY_OUT="$(identify "$OUTPUT" 2>/dev/null || true)"
FRAME_COUNT="$(printf '%s\n' "$IDENTIFY_OUT" | grep -c '^[^[:space:]]' || true)"
# Extract first-frame geometry (canvas) and a representative content rect.
FIRST_FRAME="$(printf '%s\n' "$IDENTIFY_OUT" | head -n 1)"

log "captured: docs/assets/herdr-mise-tui-demo.gif"
log "  bytes:           $GIF_BYTES"
log "  size (file):     ${GIF_DIM_RAW:-unknown}"
log "  size (sips):     ${SIPS_DIM:-unknown}"
log "  frames (identify): ${FRAME_COUNT:-unknown}"
log "  first frame:     ${FIRST_FRAME:-unknown}"
log "  command:         vhs scripts/tui-demo.tape"

# Persist a machine-readable capture record next to the source tape so
# the handoff can quote it without re-running the capture. Repo-
# relative paths only — no absolute or personal identifiers.
python3 - "$METADATA" "$BIN_SHA" "$VHS_VERSION" "$GIF_BYTES" "$SIPS_DIM" "$FRAME_COUNT" <<'PY'
import json, sys
path, sha, vhs, nbytes, sips, frames = sys.argv[1:]
w, h = (sips.split("x") if "x" in sips else ("0", "0"))
with open(path, "w") as f:
    json.dump({
        "schema": "tui-demo-capture-v1",
        "binary": "target/release/herdr-mise",
        "binary_sha256": sha,
        "vhs_version": vhs,
        "command": "vhs scripts/tui-demo.tape",
        "output": "docs/assets/herdr-mise-tui-demo.gif",
        "bytes": int(nbytes),
        "width": int(w),
        "height": int(h),
        "frames": int(frames),
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY

# Frame-count floor: 8 s of sleep + 0.5 s quit tail at 20 fps
# must produce at least 120 frames; below that the tape ran into the
# fallback path (binary exited, ttyd closed early).
if [[ -n "$FRAME_COUNT" && "$FRAME_COUNT" -lt 120 ]]; then
  fail 7 "GIF has only $FRAME_COUNT frames; expected >=120. Tape likely exited early."
fi

# Sanity: the first frame should be the full canvas, not a 1x1
# transparent placeholder (which would mean the recording started
# before the binary produced a frame).
if [[ -n "$FIRST_FRAME" ]] && [[ "$FIRST_FRAME" == *" 1x1 "* ]]; then
  fail 7 "First GIF frame is 1x1; binary produced no initial render."
fi

log "ok"
exit 0
