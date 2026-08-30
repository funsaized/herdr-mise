#!/usr/bin/env bash
# Capture the current live Herdr session and Mise Kitchen split.
#
# The Herdr workspace and plugin pane must already be prepared. This wrapper
# only attaches a capture terminal, encodes the GIF, and verifies all emitted
# frames; it never creates or changes the host layout.
#
# Usage: scripts/capture-tui-demo.sh [--force|--verify-only]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAPE="${ROOT}/scripts/tui-demo.tape"
METADATA="${TAPE}.capture.json"
OUTPUT="${ROOT}/docs/assets/herdr-mise-tui-demo.gif"

FORCE=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help)
      sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf 'capture-tui-demo: unknown arg: %s\n' "$arg" >&2; exit 64 ;;
  esac
done
[[ "$FORCE" -eq 0 || "$VERIFY_ONLY" -eq 0 ]] \
  || { printf 'capture-tui-demo: --force and --verify-only cannot be combined\n' >&2; exit 64; }

TMPDIR_CAPTURE="$(mktemp -d -t herdr-mise-tui-capture.XXXXXX)"

log() { printf 'capture-tui-demo: %s\n' "$*"; }
fail() {
  local code="$1" message="$2" log_file
  CAPTURE_FAILED=1
  printf 'exit_code=%s\nmessage=%s\n' "$code" "$message" >"$TMPDIR_CAPTURE/failure.txt"
  printf 'capture-tui-demo: %s\n' "$message" >&2
  for log_file in "$TMPDIR_CAPTURE"/*.log; do
    [[ -s "$log_file" ]] || continue
    printf 'capture-tui-demo: last 40 lines of %s:\n' "$(basename "$log_file")" >&2
    tail -n 40 "$log_file" >&2
  done
  exit "$code"
}
cleanup() {
  local status=$?
  set +e
  [[ -z "${VHS_PGID:-}" ]] || kill -TERM -- "-${VHS_PGID}" 2>/dev/null || true
  if [[ -n "${VHS_PID:-}" ]]; then
    wait "$VHS_PID" 2>/dev/null || true
  fi
  if [[ "${CAPTURE_STARTED:-0}" -eq 1 && "${CAPTURE_OK:-0}" -ne 1 ]]; then
    if [[ -e "$TMPDIR_CAPTURE/previous.gif" ]]; then
      cp "$TMPDIR_CAPTURE/previous.gif" "$OUTPUT"
    else
      rm -f "$OUTPUT"
    fi
    if [[ -e "$TMPDIR_CAPTURE/previous-metadata.json" ]]; then
      cp "$TMPDIR_CAPTURE/previous-metadata.json" "$METADATA"
    else
      rm -f "$METADATA"
    fi
  fi
  if [[ "$status" -ne 0 || "${CAPTURE_FAILED:-0}" -eq 1 ]]; then
    printf 'capture-tui-demo: retained diagnostics at %s\n' "$TMPDIR_CAPTURE" >&2
  else
    rm -rf "$TMPDIR_CAPTURE"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TOOLS=(ffmpeg identify tesseract sips python3)
[[ "$VERIFY_ONLY" -eq 1 ]] || TOOLS+=(vhs herdr)
for tool in "${TOOLS[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || fail 2 "$tool is required"
done

verify_gif() {
  [[ -s "$OUTPUT" ]] || fail 7 "GIF not found: $OUTPUT"
  IDENTIFY_OUT="$(identify "$OUTPUT" 2>/dev/null || true)"
  FRAME_COUNT="$(printf '%s\n' "$IDENTIFY_OUT" | grep -c '^[^[:space:]]' || true)"
  [[ "$FRAME_COUNT" -ge 120 ]] || fail 7 "GIF has only $FRAME_COUNT frames; expected at least 120"

  mkdir "$TMPDIR_CAPTURE/frames" "$TMPDIR_CAPTURE/ocr"
  ffmpeg -y -i "$OUTPUT" -fps_mode passthrough \
    "$TMPDIR_CAPTURE/frames/frame-%04d.png" >"$TMPDIR_CAPTURE/ffmpeg.log" 2>&1 \
    || fail 7 "frame extraction failed"
  BRANCH="$(git -C "$ROOT" branch --show-current)"
  VERIFIED_FRAMES=0
  SCENE_FRAMES=0
  for frame in "$TMPDIR_CAPTURE"/frames/frame-*.png; do
    OCR_FILE="$TMPDIR_CAPTURE/ocr/$(basename "${frame%.png}").txt"
    tesseract "$frame" stdout >"$OCR_FILE" 2>/dev/null || true
    OCR="$(<"$OCR_FILE")"
    OCR_UPPER="${OCR^^}"
    [[ "$OCR_UPPER" == *"MISE"* && "$OCR_UPPER" == *"LIVE"* \
      && "$OCR_UPPER" == *"VERIFIER SESSION"* && "$OCR_UPPER" == *"MISE KITCHEN"* ]] \
      || fail 7 "$(basename "$frame") does not show the verified live Herdr split"
    [[ "$OCR_UPPER" != *"KITCHEN STATUS"* ]] \
      || fail 7 "$(basename "$frame") shows the compact table instead of chef sprites"
    [[ "$OCR_UPPER" == *"10HZ"* ]] && SCENE_FRAMES=$((SCENE_FRAMES + 1))
    [[ "$OCR_UPPER" != *"DEMO SERVICE"* ]] || fail 7 "$(basename "$frame") contains DEMO SERVICE"
    [[ "$OCR" != *"/Users/"* && "$OCR_UPPER" != *"DOCUMENTS/"* ]] \
      || fail 7 "$(basename "$frame") contains a home-directory path"
    [[ -z "${USER:-}" || "$OCR" != *"$USER"* ]] || fail 7 "$(basename "$frame") contains the local username"
    [[ -z "$BRANCH" || "$OCR" != *"$BRANCH"* ]] || fail 7 "$(basename "$frame") contains the local branch name"
    [[ ! "$OCR_UPPER" =~ (AKIA[[:alnum:]]{16}|GH[POUSR]_|SK-[[:alnum:]]|PASSWORD|PASSWD|API[_\ -]?KEY|ACCESS[_\ -]?TOKEN|PRIVATE[_\ -]?KEY|BEGIN[[:space:]].*PRIVATE[[:space:]]KEY) ]] \
      || fail 7 "$(basename "$frame") may contain a secret"
    VERIFIED_FRAMES=$((VERIFIED_FRAMES + 1))
  done
  [[ "$VERIFIED_FRAMES" -eq "$FRAME_COUNT" ]] || fail 7 "verified $VERIFIED_FRAMES of $FRAME_COUNT frames"
  [[ "$SCENE_FRAMES" -gt 0 ]] || fail 7 "no frame contains the animated scene tick header"
  UNIQUE_FRAMES="$(shasum -a 256 "$TMPDIR_CAPTURE"/frames/*.png | cut -d ' ' -f 1 | sort -u | wc -l | tr -d ' ')"
  [[ "$UNIQUE_FRAMES" -ge 20 ]] || fail 7 "GIF has only $UNIQUE_FRAMES unique frames; expected live motion"
  GIF_BYTES="$(wc -c < "$OUTPUT" | tr -d ' ')"
  WIDTH="$(sips -g pixelWidth "$OUTPUT" 2>/dev/null | awk '/pixelWidth:/{print $2}')"
  HEIGHT="$(sips -g pixelHeight "$OUTPUT" 2>/dev/null | awk '/pixelHeight:/{print $2}')"
}

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  verify_gif
else
  LIVE_SOCKET="${HERDR_SOCKET_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/herdr.sock}"
  [[ -S "$LIVE_SOCKET" ]] || fail 8 "no live Herdr socket at $LIVE_SOCKET"
  [[ ! -L "$LIVE_SOCKET" ]] || fail 8 "live Herdr socket must not be a symlink"
  read -r SOCKET_UID SOCKET_MODE SOCKET_DEVICE SOCKET_INODE <<<"$(stat -f '%u %Lp %d %i' "$LIVE_SOCKET")"
  [[ "$SOCKET_UID" == "$(id -u)" ]] || fail 8 "live Herdr socket is not owned by the current user"
  (( (8#$SOCKET_MODE & 8#022) == 0 )) || fail 8 "live Herdr socket is group- or world-writable"
  SOCKET_IDENTITY="$SOCKET_UID $SOCKET_MODE $SOCKET_DEVICE $SOCKET_INODE"
  export HERDR_SOCKET_PATH="$LIVE_SOCKET"
  verify_socket() {
    local identity
    [[ -S "$LIVE_SOCKET" && ! -L "$LIVE_SOCKET" ]] || fail 8 "live Herdr socket changed during capture"
    identity="$(stat -f '%u %Lp %d %i' "$LIVE_SOCKET" 2>/dev/null || true)"
    [[ "$identity" == "$SOCKET_IDENTITY" ]] || fail 8 "live Herdr socket changed during capture"
  }
  herdr_checked() {
    local status
    verify_socket
    if herdr "$@"; then status=0; else status=$?; fi
    verify_socket
    return "$status"
  }
  herdr_checked status >/dev/null || fail 8 "Herdr is not running"
  HERDR_CAPTURE_SESSION="$(herdr_checked session list --json | python3 -c '
import json, os, sys
socket = os.path.realpath(sys.argv[1])
print(next((item["name"] for item in json.load(sys.stdin)["sessions"] if item["running"] and os.path.realpath(item["socket_path"]) == socket), ""))
  ' "$LIVE_SOCKET")"
  [[ -n "$HERDR_CAPTURE_SESSION" ]] || fail 8 "live Herdr socket does not belong to a named session"
  [[ "$HERDR_CAPTURE_SESSION" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] \
    || fail 8 "live Herdr session name is not safe for the capture command"
  export HERDR_CAPTURE_SESSION
  CAPTURE_WORKSPACE="verifier-kitchen"
  capture_target() {
    herdr_checked api snapshot | python3 -c '
import json, sys
label = sys.argv[1]
snapshot = json.load(sys.stdin)["result"]["snapshot"]
workspace = next((item for item in snapshot["workspaces"] if item.get("label") == label), None)
pane = next((item for item in snapshot["panes"] if item.get("label") == "Mise Kitchen" and workspace and item["workspace_id"] == workspace["workspace_id"]), None)
host = next((item for item in snapshot["panes"] if pane and item.get("label") == "verifier-session" and item["tab_id"] == pane["tab_id"]), None)
layout = next((item for item in snapshot["layouts"] if pane and item["tab_id"] == pane["tab_id"]), None)
rect = next((item["rect"] for item in layout["panes"] if item["pane_id"] == pane["pane_id"]), None) if layout else None
public_workspaces = {"verifier-host", "verifier-kitchen"}
public_panes = {"verifier-session", "Mise Kitchen"}
tab_panes = [item for item in snapshot["panes"] if pane and item["tab_id"] == pane["tab_id"]]
workspace_panes = [item for item in snapshot["panes"] if workspace and item["workspace_id"] == workspace["workspace_id"]]
if pane and host and rect and rect["width"] >= 80 and rect["height"] >= 24 and all(item.get("label") in public_workspaces for item in snapshot["workspaces"]) and len(tab_panes) == len(workspace_panes) == 2 and all(item.get("label") in public_panes for item in workspace_panes):
    print(pane["workspace_id"], pane["tab_id"], pane["pane_id"])
' "$CAPTURE_WORKSPACE"
  }
  read -r CAPTURE_WORKSPACE_ID CAPTURE_TAB_ID CAPTURE_PANE_ID <<<"$(capture_target)"
  [[ -n "$CAPTURE_WORKSPACE_ID" && -n "$CAPTURE_TAB_ID" && -n "$CAPTURE_PANE_ID" ]] \
    || fail 8 "no 80x24 Mise Kitchen split beside verifier-session in Herdr workspace $CAPTURE_WORKSPACE"

mkdir -p "$(dirname "$OUTPUT")"
if [[ -e "$OUTPUT" && "$FORCE" -ne 1 ]]; then
  fail 5 "output already exists: $OUTPUT (pass --force to overwrite)"
fi
[[ ! -e "$OUTPUT" ]] || cp "$OUTPUT" "$TMPDIR_CAPTURE/previous.gif"
[[ ! -e "$METADATA" ]] || cp "$METADATA" "$TMPDIR_CAPTURE/previous-metadata.json"

VHS_VERSION="$(vhs --version 2>&1 | head -n 1)"
HERDR_VERSION="$(herdr --version 2>&1 | head -n 1)"
log "capturing prepared live Herdr session"
herdr_checked workspace focus "$CAPTURE_WORKSPACE_ID" >/dev/null
CAPTURE_STARTED=1
verify_socket
set -m
(
  unset HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID
  unset COLORTERM
  export TERM=xterm-256color
  cd "$ROOT" && exec vhs "$TAPE"
) >"$TMPDIR_CAPTURE/vhs.log" 2>&1 &
VHS_PID=$!
VHS_PGID=$VHS_PID
set +m
for _ in {1..10}; do
  herdr_checked workspace focus "$CAPTURE_WORKSPACE_ID" >/dev/null
  herdr_checked tab focus "$CAPTURE_TAB_ID" >/dev/null
  sleep 0.1
done
while kill -0 "$VHS_PID" 2>/dev/null; do
  verify_socket
  read -r CURRENT_WORKSPACE_ID CURRENT_TAB_ID CURRENT_PANE_ID <<<"$(capture_target)"
  [[ "$CURRENT_WORKSPACE_ID $CURRENT_TAB_ID $CURRENT_PANE_ID" == "$CAPTURE_WORKSPACE_ID $CAPTURE_TAB_ID $CAPTURE_PANE_ID" ]] \
    || fail 7 "verified Herdr capture target changed during recording"
  herdr_checked workspace focus "$CAPTURE_WORKSPACE_ID" >/dev/null
  herdr_checked tab focus "$CAPTURE_TAB_ID" >/dev/null
  sleep 0.1
done
if wait "$VHS_PID"; then VHS_STATUS=0; else VHS_STATUS=$?; fi
VHS_PID=""
kill -TERM -- "-${VHS_PGID}" 2>/dev/null || true
VHS_PGID=""
[[ "$VHS_STATUS" -eq 0 ]] || fail 6 "vhs exited non-zero"
verify_socket
[[ -s "$OUTPUT" ]] || fail 7 "GIF not produced: $OUTPUT"
read -r FINAL_WORKSPACE_ID FINAL_TAB_ID FINAL_PANE_ID <<<"$(capture_target)"
[[ "$FINAL_WORKSPACE_ID $FINAL_TAB_ID $FINAL_PANE_ID" == "$CAPTURE_WORKSPACE_ID $CAPTURE_TAB_ID $CAPTURE_PANE_ID" ]] \
  || fail 7 "verified Herdr capture target changed during recording"

  verify_gif
fi

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  METADATA_ACTION=verify
  VHS_VERSION=""
  HERDR_VERSION=""
  CAPTURE_WORKSPACE_ID=""
  CAPTURE_TAB_ID=""
  CAPTURE_PANE_ID=""
else
  METADATA_ACTION=write
fi
python3 - "$METADATA_ACTION" "$METADATA" "$VHS_VERSION" "$HERDR_VERSION" "$GIF_BYTES" "$WIDTH" "$HEIGHT" "$FRAME_COUNT" "$UNIQUE_FRAMES" "$CAPTURE_WORKSPACE_ID" "$CAPTURE_TAB_ID" "$CAPTURE_PANE_ID" <<'PY' \
  >"$TMPDIR_CAPTURE/metadata.log" 2>&1 || fail 7 "capture metadata verification failed"
import json, sys
action, path, vhs, herdr, nbytes, width, height, frames, unique, workspace, tab, pane = sys.argv[1:]
contract = {
    "command": "vhs scripts/tui-demo.tape",
    "mode": "live-host-split",
    "output": "docs/assets/herdr-mise-tui-demo.gif",
    "privacy_checks": [
        "MISE — LIVE",
        "not DEMO SERVICE",
        "not /Users/",
        "not local username or branch",
        "not common secret prefixes",
        "every frame shows only verifier workspace labels",
    ],
    "schema": "tui-demo-capture-v3",
}
media = {
    "bytes": int(nbytes),
    "frames": int(frames),
    "height": int(height),
    "unique_frames": int(unique),
    "verified_frames": int(frames),
    "width": int(width),
}
if action == "verify":
    with open(path) as file:
        metadata = json.load(file)
    assert all(metadata[key] == value for key, value in (contract | media).items())
else:
    with open(path, "w") as file:
        json.dump(
            contract
            | media
            | {
                "herdr_version": herdr,
                "source_pane_id": pane,
                "source_tab_id": tab,
                "source_workspace_id": workspace,
                "vhs_version": vhs,
            },
            file,
            indent=2,
            sort_keys=True,
        )
        file.write("\n")
PY

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  log "verified checked-in live split: ${WIDTH}x${HEIGHT}, ${FRAME_COUNT} frames (${UNIQUE_FRAMES} unique)"
else
  CAPTURE_OK=1
  log "captured live split: ${WIDTH}x${HEIGHT}, ${FRAME_COUNT} verified frames (${UNIQUE_FRAMES} unique), ${GIF_BYTES} bytes"
fi
