#!/bin/sh
set -eu

binary=${1:-target/release/herdr-mise}
artifact_dir=${HERDR_MISE_ARTIFACT_DIR:-perf/artifacts}
mkdir -p "$artifact_dir"
isolated=$(mktemp -d)
log="$artifact_dir/release-smoke.log"
port=$(node -e 'const net=require("node:net"),server=net.createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})')
HOME="$isolated/home" XDG_CONFIG_HOME="$isolated/config" XDG_RUNTIME_DIR="$isolated/runtime" HERDR_SOCKET_PATH="$isolated/no-herdr.sock" HERDR_MISE_DEMO_COUNT=12 HERDR_MISE_PORT="$port" "$binary" >"$log" 2>&1 &
pid=$!
trap 'kill -INT "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$isolated"' EXIT INT TERM

i=0
until curl --fail --silent "http://127.0.0.1:$port/" -o "$isolated/index.html" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 400 ] || { echo "server did not become ready" >&2; exit 1; }
  sleep 0.01
done
grep -q 'assets/.*\.js' "$isolated/index.html"
asset=$(sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' "$isolated/index.html" | head -n 1)
[ -n "$asset" ]
curl --fail --silent "http://127.0.0.1:$port/$asset" -o "$isolated/client.js"
HERDR_MISE_PORT="$port" node -e '
const timer=setTimeout(()=>{console.error("websocket timeout");process.exit(1)},1500);
const ws=new WebSocket(`ws://127.0.0.1:${process.env.HERDR_MISE_PORT}/ws`);
ws.onmessage=(event)=>{const value=JSON.parse(event.data);if(value.type!=="snapshot"||value.mode!=="demo"||value.agents.length!==12)process.exit(2);clearTimeout(timer);console.log(`ws_mode=${value.mode} agents=${value.agents.length}`);process.exit(0)};
ws.onerror=()=>process.exit(3);
'
HERDR_MISE_PORT="$port" node scripts/smoke-browser.mjs
kill -INT "$pid"
wait "$pid"
trap 'rm -rf "$isolated"' EXIT INT TERM
echo "bind=127.0.0.1:$port"
echo "graceful_shutdown=ok"
