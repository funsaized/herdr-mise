#!/bin/sh
# Owns exactly one public-artifact process. State and logs must live outside repo.
set -eu
action=${1:?usage: acceptance-soak.sh start|status|stop STATE_DIR [BINARY MIN_HOURS]}
state_dir=${2:?usage: acceptance-soak.sh start|status|stop STATE_DIR [BINARY MIN_HOURS]}
repo=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)
repo=$(cd "$repo" && pwd -P)
state_parent=$(dirname "$state_dir")
mkdir -p "$state_parent"
state_parent=$(cd "$state_parent" && pwd -P)
state_dir="$state_parent/$(basename "$state_dir")"
case "$state_dir" in "$repo"|"$repo"/*) echo "soak state must be outside the source tree" >&2; exit 1 ;; esac
pid_file="$state_dir/pid"
command_file="$state_dir/command"
started_file="$state_dir/started-at"
review_file="$state_dir/reviews.log"

running() {
  [ -f "$pid_file" ] || return 1
  soak_pid=$(sed -n '1p' "$pid_file")
  case "$soak_pid" in *[!0-9]*|'') return 1 ;; esac
  kill -0 "$soak_pid" 2>/dev/null || return 1
  observed=$(ps -p "$soak_pid" -o command= 2>/dev/null || true)
  expected=$(sed -n '1p' "$command_file" 2>/dev/null || true)
  [ "$observed" = "$expected" ]
}

case "$action" in
  start)
    binary=${3:?start requires installed BINARY}
    minimum_hours=${4:-72}
    case "$minimum_hours" in *[!0-9]*|'') echo "MIN_HOURS must be an integer" >&2; exit 1 ;; esac
    binary_dir=$(cd "$(dirname "$binary")" && pwd -P)
    binary="$binary_dir/$(basename "$binary")"
    case "$binary" in "$repo"|"$repo"/*) echo "source-tree binary cannot count for soak" >&2; exit 1 ;; esac
    install_dir=$(dirname "$(dirname "$binary")")
    [ -x "$binary" ] && [ -f "$install_dir/artifact-sha256" ] && [ -f "$install_dir/public-source-url" ] || { echo "binary is not an anonymously downloaded verified install" >&2; exit 1; }
    grep -q '^https://' "$install_dir/public-source-url" || { echo "soak source is not public HTTPS" >&2; exit 1; }
    if running; then echo "soak already running" >&2; exit 1; fi
    mkdir -p "$state_dir/logs"
    printf '%s\n' "$minimum_hours" >"$state_dir/minimum-hours"
    cp "$install_dir/artifact-sha256" "$state_dir/artifact-sha256"
    cp "$install_dir/public-source-url" "$state_dir/public-source-url"
    date -u '+%Y-%m-%dT%H:%M:%SZ' >"$started_file"
    : >"$review_file"
    nohup "$binary" >"$state_dir/logs/herdr-mise.log" 2>&1 &
    soak_pid=$!
    printf '%s\n' "$soak_pid" >"$pid_file"
    ps -p "$soak_pid" -o command= | sed -n '1p' >"$command_file"
    sleep 1
    running || { echo "soak process failed to stay running" >&2; exit 1; }
    echo "soak=RUNNING pid=$soak_pid started_at=$(sed -n '1p' "$started_file")"
    ;;
  status)
    now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '%s status-review\n' "$now" >>"$review_file"
    if running; then state=RUNNING; else state=STOPPED; fi
    echo "soak=$state started_at=$(sed -n '1p' "$started_file" 2>/dev/null || echo NOT_STARTED) reviewed_at=$now minimum_hours=$(sed -n '1p' "$state_dir/minimum-hours" 2>/dev/null || echo UNKNOWN)"
    [ "$state" = RUNNING ]
    ;;
  stop)
    running || { echo "owned soak process is not running" >&2; exit 1; }
    kill -INT "$soak_pid"
    attempts=0
    while kill -0 "$soak_pid" 2>/dev/null; do attempts=$((attempts + 1)); [ "$attempts" -lt 50 ] || { echo "process did not stop after SIGINT" >&2; exit 1; }; sleep 0.1; done
    date -u '+%Y-%m-%dT%H:%M:%SZ stopped' >>"$review_file"
    echo "soak=STOPPED pid=$soak_pid"
    ;;
  *) echo "unknown action: $action" >&2; exit 1 ;;
esac
