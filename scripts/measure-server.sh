#!/bin/sh
set -eu
binary=${1:-target/release/herdr-mise}
artifact_dir=${HERDR_MISE_ARTIFACT_DIR:-perf/artifacts}
mkdir -p "$artifact_dir"
log="$artifact_dir/server-resource.log"
sample="$artifact_dir/server-resource.txt"
isolated=$(mktemp -d)
HOME="$isolated/home" XDG_RUNTIME_DIR="$isolated/xdg" HERDR_SOCKET_PATH="$isolated/missing.sock" HERDR_MISE_DEMO_COUNT=12 "$binary" >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$isolated"' EXIT INT TERM
sleep 3
raw=$(ps -o pid=,rss=,%cpu= -p "$pid")
{
  echo "pid rss_kib cpu_percent"
  echo "$raw"
} | tee "$sample"
rss_kib=$(echo "$raw" | awk '{print $2}')
cpu_percent=$(echo "$raw" | awk '{print $3}')
awk -v rss="$rss_kib" 'BEGIN { if (rss > 50 * 1024) { printf "server RSS assertion failed: %s KiB > 51200 KiB\n", rss > "/dev/stderr"; exit 1 } }'
awk -v cpu="$cpu_percent" 'BEGIN { if (cpu > 1) { printf "server CPU assertion failed: %s%% > 1%% of one core\n", cpu > "/dev/stderr"; exit 1 } }'
echo "server resource assertions passed: RSS ${rss_kib} KiB <= 51200 KiB; CPU ${cpu_percent}% <= 1%"
