#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
ASSETS="$ROOT/docs/assets"
OUTPUT="$ASSETS/herdr-mise-tui-demo.gif"
POSTER="$ASSETS/herdr-mise-tui-demo-poster.png"
METADATA="$ROOT/scripts/tui-demo.capture.json"
FPS=15
MAX_BYTES=1572864
STAGING=""
RECORDER_PID=""
GHOSTTY_ADJUSTED=0

usage() { printf 'Usage: scripts/capture-demo.sh tui|web\n'; }
die() { printf 'capture-demo: %s\n' "$1" >&2; exit 1; }
cleanup() {
  [[ -z "$RECORDER_PID" ]] || kill -INT "$RECORDER_PID" 2>/dev/null || true
  if [[ "$GHOSTTY_ADJUSTED" -eq 1 ]]; then
    ghostty_action reset_font_size >/dev/null 2>&1 || true
    ghostty_action toggle_fullscreen >/dev/null 2>&1 || true
  fi
  [[ -z "$STAGING" || ! -d "$STAGING" ]] || printf 'capture-demo: candidate retained at %s\n' "$STAGING" >&2
}
trap cleanup EXIT INT TERM

[[ "$MODE" == tui || "$MODE" == web ]] || { usage >&2; exit 64; }
if [[ "$MODE" == web ]]; then
  exec node "$ROOT/scripts/capture-readme-media.mjs"
fi

for tool in cargo ffmpeg ffprobe osascript python3 script; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

cargo build --release --bin herdr-mise --locked
mkdir -p "$ASSETS"
STAGING="$(mktemp -d "$ASSETS/.capture-demo.XXXXXX")"
MOV="$STAGING/source.mov"
GIF="$STAGING/candidate.gif"
POSTER_CANDIDATE="$STAGING/poster.png"
BINARY="$ROOT/target/release/herdr-mise"

ghostty_action() {
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  tell application "Ghostty"
    set targetTerminal to focused terminal of selected tab of front window
    perform action (item 1 of argv) on targetTerminal
  end tell
end run
APPLESCRIPT
}

printf 'capture-demo: recording six demo agents in Ghostty\n'
ghostty_action set_font_size:20 >/dev/null
ghostty_action toggle_fullscreen >/dev/null
GHOSTTY_ADJUSTED=1
sleep 2
ffmpeg -hide_banner -loglevel error -y \
  -f avfoundation -framerate "$FPS" -i "Capture screen 0:none" \
  -an "$MOV" >"$STAGING/record.log" 2>&1 &
RECORDER_PID=$!
{
  sleep 10
  printf f
  sleep 6
  printf q
} | script -q /dev/null env \
  /bin/sh -c 'stty rows 42 columns 120; exec env "HERDR_SOCKET_PATH=$1" HERDR_MISE_DEMO_COUNT=6 HERDR_MISE_DEMO_START_STEP=290 "HERDR_MISE_PORT=$2" "$3" --tui' \
  capture \
  "/tmp/herdr-mise-no-herdr-$$.sock" \
  "$((20000 + $$ % 30000))" \
  "$BINARY"
kill -INT "$RECORDER_PID" 2>/dev/null || true
wait "$RECORDER_PID" 2>/dev/null || true
RECORDER_PID=""
ghostty_action reset_font_size >/dev/null
ghostty_action toggle_fullscreen >/dev/null
GHOSTTY_ADJUSTED=0
[[ -s "$MOV" ]] || die "recording failed; see $STAGING/record.log"

FILTER="fps=$FPS,scale=1100:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3"
ffmpeg -hide_banner -loglevel error -y -i "$MOV" -vf "$FILTER" -loop 0 "$GIF"
ffmpeg -hide_banner -loglevel error -y -ss 2 -i "$MOV" -vf "scale=1100:-2:flags=lanczos" -frames:v 1 "$POSTER_CANDIDATE"
ffmpeg -hide_banner -loglevel error -i "$GIF" -f null -

total_bytes="$(python3 - "$GIF" "$POSTER_CANDIDATE" <<'PY'
import os,sys
print(sum(os.path.getsize(path) for path in sys.argv[1:]))
PY
)"
[[ "$total_bytes" -le "$MAX_BYTES" ]] ||
  die "GIF and poster total $total_bytes bytes; reduce the capture before publishing"

python3 - "$MOV" "$GIF" "$POSTER_CANDIDATE" "$BINARY" "$FPS" "$MAX_BYTES" "$STAGING/capture.json" <<'PY'
import datetime,hashlib,json,os,subprocess,sys
mov,gif,poster,binary,fps,budget,destination=sys.argv[1:]
digest=lambda path: hashlib.sha256(open(path,"rb").read()).hexdigest()
probe=json.loads(subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height,nb_frames:format=duration","-of","json",gif],capture_output=True,text=True,check=True).stdout)
stream=probe["streams"][0]
frames,duration=int(stream["nb_frames"]),float(probe["format"]["duration"])
if frames < 200 or duration < 14:
    raise SystemExit(f"capture too short: {frames} frames, {duration:.2f} seconds")
data={"schema":"demo-capture-v1","mode":"tui-demo","captured_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"automated":True,"release_binary_sha256":digest(binary),"source_sha256":digest(mov),"output":{"path":"docs/assets/herdr-mise-tui-demo.gif","sha256":digest(gif),"bytes":os.path.getsize(gif),"poster":"docs/assets/herdr-mise-tui-demo-poster.png","poster_sha256":digest(poster),"total_media_bytes":os.path.getsize(gif)+os.path.getsize(poster),"media_budget_bytes":int(budget),"fps":int(fps),"width":int(stream["width"]),"height":int(stream["height"]),"frames":frames,"duration_seconds":duration,"scheduled_views":["kitchen","freezer"]}}
with open(destination,"w") as file: json.dump(data,file,indent=2,sort_keys=True); file.write("\n")
PY

mv "$GIF" "$OUTPUT"
mv "$POSTER_CANDIDATE" "$POSTER"
mv "$STAGING/capture.json" "$METADATA"
rm -rf "$STAGING"
STAGING=""
printf 'capture-demo: published docs/assets/herdr-mise-tui-demo.gif\n'
printf 'capture-demo: published docs/assets/herdr-mise-tui-demo-poster.png\n'
printf 'capture-demo: published scripts/tui-demo.capture.json\n'
