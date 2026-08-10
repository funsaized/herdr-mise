#!/bin/sh
# Verify a packaged release artifact end to end: checksum, archive contents,
# embedded assets, live demo snapshot over WebSocket, and graceful shutdown.
# Needs sh, curl, tar, node, and sha256sum/shasum — no
# browser — so it runs on macOS hosts and inside Linux containers alike.
set -eu

archive=${1:?usage: verify-release-artifact.sh dist/herdr-mise-<target>.tar.gz}
checksum="$archive.sha256"
work=$(mktemp -d)
pid=""
trap '[ -n "$pid" ] && kill -INT "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT INT TERM

if command -v sha256sum >/dev/null 2>&1; then sum=sha256sum; else sum="shasum -a 256"; fi
expected=$(awk '{print $1}' "$checksum")
recorded=$(awk '{print $2}' "$checksum")
[ "$recorded" = "$(basename "$archive")" ] || { echo "checksum names wrong file: $recorded" >&2; exit 1; }
actual=$($sum "$archive" | awk '{print $1}')
[ "$expected" = "$actual" ] || { echo "checksum mismatch: $actual != $expected" >&2; exit 1; }
echo "checksum=ok $actual"

contents=$(tar -tzf "$archive")
expected_contents=$(printf '%s\n' herdr-mise LICENSE THIRD_PARTY_NOTICES.txt)
[ "$contents" = "$expected_contents" ] || { echo "unexpected archive contents: $contents" >&2; exit 1; }
echo "archive_contents=executable and license notices"

tar -C "$work" -xzf "$archive"
binary="$work/herdr-mise"
[ -x "$binary" ]
cmp LICENSE "$work/LICENSE"
grep -q '^## Rust dependencies$' "$work/THIRD_PARTY_NOTICES.txt"
grep -q '^## JavaScript dependencies$' "$work/THIRD_PARTY_NOTICES.txt"
grep -q 'Instrument Sans Project Authors' "$work/THIRD_PARTY_NOTICES.txt"
grep -q 'Silkscreen Project Authors' "$work/THIRD_PARTY_NOTICES.txt"
echo "license_notices=ok"
if [ "${VERIFY_GATEKEEPER:-0}" = 1 ]; then
  [ "$(uname -s)" = Darwin ] || { echo "Gatekeeper assessment requires macOS" >&2; exit 1; }
  spctl --assess --type exec --verbose=4 "$binary"
  echo "gatekeeper_assessment=accepted"
fi

HOME="$work/home" XDG_CONFIG_HOME="$work/config" XDG_RUNTIME_DIR="$work/runtime" \
  HERDR_SOCKET_PATH="$work/no-herdr.sock" HERDR_MISE_DEMO_COUNT=12 \
  "$binary" >"$work/server.log" 2>&1 &
pid=$!

i=0
until curl --fail --silent http://127.0.0.1:8686/ -o "$work/index.html" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 400 ] || { echo "server did not become ready" >&2; cat "$work/server.log" >&2; exit 1; }
  sleep 0.05
done

asset=$(sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' "$work/index.html" | head -n 1)
[ -n "$asset" ] || { echo "no hashed js asset referenced by index.html" >&2; exit 1; }
mime=$(curl --fail --silent -o "$work/client.js" -w '%{content_type}' "http://127.0.0.1:8686/$asset")
[ -s "$work/client.js" ]
case "$mime" in text/javascript*) ;; *) echo "unexpected asset MIME: $mime" >&2; exit 1 ;; esac
echo "embedded_assets=ok $asset ($mime)"

font_mime=$(curl --fail --silent -o "$work/font.ttf" -w '%{content_type}' "http://127.0.0.1:8686/fonts/instrument-sans-400.ttf")
[ -s "$work/font.ttf" ]
[ "$font_mime" = "font/ttf" ] || { echo "unexpected font MIME: $font_mime" >&2; exit 1; }
notice_mime=$(curl --fail --silent -o "$work/font-license.txt" -w '%{content_type}' "http://127.0.0.1:8686/fonts/OFL-Instrument-Sans.txt")
case "$notice_mime" in text/plain*) ;; *) echo "unexpected font license MIME: $notice_mime" >&2; exit 1 ;; esac
echo "embedded_fonts=ok ($font_mime; $notice_mime)"

node -e '
const timer=setTimeout(()=>{console.error("websocket timeout");process.exit(1)},3000);
const ws=new WebSocket("ws://127.0.0.1:8686/ws");
ws.onmessage=(event)=>{const value=JSON.parse(event.data);if(value.type!=="snapshot"||value.mode!=="demo"||value.agents.length!==12)process.exit(2);clearTimeout(timer);console.log(`demo_snapshot=ok mode=${value.mode} agents=${value.agents.length}`);process.exit(0)};
ws.onerror=()=>process.exit(3);
'

kill -INT "$pid"
wait "$pid"
echo "graceful_shutdown=ok"
