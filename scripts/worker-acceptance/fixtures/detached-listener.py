#!/usr/bin/env python3
"""Fake `opencode` that spawns detached socket listeners for reaping tests.

This fixture is substituted for the real provider on PATH by
`scripts/nightshift-opencode.test.mjs`. The launcher under test is expected to
run it as an opaque child and, when the launcher exits (normally or on
termination), leave none of these descendants alive.

Provider mode (default) env contract:
  NS_FIXTURE_MODE    success | failure | immediate | hold | resistant | ordinary | incomplete
  NS_FIXTURE_READY   path where the readiness JSON is written after every
                     listener is bound and listening
  NS_FIXTURE_PORT    optional fixed TCP port for the primary `detached` listener
  NS_FIXTURE_SIGNALS optional append-only log of received signal names
  NS_FIXTURE_ECHO_STDIN  "1" echoes one stdin line back on stdout
  NIGHTSHIFT_INVOCATION_ID  reported verbatim when the launcher exports one

Readiness JSON shape:
  {
    "ready": true,
    "mode": "<mode>",
    "invocationId": "<NIGHTSHIFT_INVOCATION_ID or null>",
    "stdinProbe": "<line or null>",
    "provider": {"pid", "startId", "pgid", "session"},
    "listeners": [
      {"role", "pid", "port", "startId", "pgid", "session", "socketBound"},
      ... one entry per ordinary/detached parent and each grandchild ...
    ]
  }

Scenario matrix:
  ordinary   ordinary listener + ordinary grandchild; provider exits 0
  success    ordinary + detached listener (each with a grandchild); exit 0
  failure    same children as success; provider exits 7
  immediate  same children as success; provider exits 0 immediately
  hold       same children as success; provider blocks until signalled
  resistant  same children as hold; listeners ignore SIGTERM (need SIGKILL)
  incomplete same children as success; aggregate readiness is withheld and the
             provider blocks, exercising the harness failure-path cleanup

Emergency cleanup is the test's job: it revalidates each recorded pid against
its recorded startId before signalling, so a reused pid is never killed.
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

MODES = ("success", "failure", "immediate", "hold", "resistant", "ordinary", "incomplete")
PARENT_ROLES = ("ordinary", "detached")


def _libproc_start_id(pid: int) -> str | None:
    """`ps -o lstart=`-formatted start stamp read through libproc.

    Seatbelt denies `ps` to the sandboxed provider, so on macOS the fixture
    reads proc_bsdinfo's start timeval directly (the launcher's own method)
    and renders it the way `ps -o lstart=` does for the harness to compare.
    """
    import ctypes
    import struct

    try:
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        lib.proc_pidinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        info = ctypes.create_string_buffer(136)
        if lib.proc_pidinfo(pid, 3, 0, info, 136) != 136:
            return None
        seconds = struct.unpack_from("Q", info.raw, 120)[0]
    except OSError:
        return None
    return time.strftime("%a %b %e %H:%M:%S %Y", time.localtime(seconds))


def process_start_id(pid: int) -> str | None:
    """Kernel start stamp (`ps -o lstart=`) used to detect pid reuse."""
    if sys.platform == "darwin":
        return _libproc_start_id(pid)
    try:
        output = subprocess.check_output(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = output.strip()
    return value or None


def process_ids(pid: int | None = None) -> dict:
    pid = pid or os.getpid()
    try:
        pgid = os.getpgid(pid)
    except OSError:
        pgid = None
    try:
        session = os.getsid(pid)
    except OSError:
        session = None
    return {
        "pid": pid,
        "startId": process_start_id(pid),
        "pgid": pgid,
        "session": session,
    }


def write_json_atomic(path: Path | str, payload: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True))
    os.replace(temporary, target)


def wait_for_json(path: Path | str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return json.loads(Path(path).read_text())
        except (FileNotFoundError, ValueError):
            time.sleep(0.02)
    raise RuntimeError(f"readiness file was not written: {path}")


def note_signal(signals_path: str | None, role: str, name: str) -> None:
    if not signals_path:
        return
    try:
        with open(signals_path, "a", encoding="utf8") as handle:
            handle.write(f"{role} {name}\n")
    except OSError:
        pass


def run_listener() -> int:
    role = os.environ["NS_FIXTURE_CHILD_ROLE"]
    ready_path = os.environ["NS_FIXTURE_CHILD_READY"]
    resistant = os.environ.get("NS_FIXTURE_RESISTANT") == "1"
    signals_path = os.environ.get("NS_FIXTURE_SIGNALS")
    detached_parent = role == "detached"
    if detached_parent:
        os.setsid()

    requested = os.environ.get("NS_FIXTURE_PORT")
    bind_port = int(requested) if requested and detached_parent else 0
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", bind_port))
    server.listen(16)
    port = server.getsockname()[1]

    def on_term(_signum, _frame):
        note_signal(signals_path, role, "SIGTERM")
        if resistant:
            return
        try:
            server.close()
        except OSError:
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)

    def accept_loop():
        while True:
            try:
                connection, _ = server.accept()
            except OSError:
                return
            connection.close()

    threading.Thread(target=accept_loop, daemon=True).start()

    record = process_ids()
    record.update({"role": role, "port": port, "socketBound": True})

    if role in PARENT_ROLES:
        grand_role = f"{role}-grandchild"
        child_env = dict(os.environ)
        child_env["NS_FIXTURE_CHILD_ROLE"] = grand_role
        child_env["NS_FIXTURE_CHILD_READY"] = str(
            Path(ready_path).with_name(f"ready-{grand_role}.json")
        )
        # Sequential invocations reuse this directory; stale grandchildren must
        # never satisfy the next invocation's readiness handshake.
        Path(child_env["NS_FIXTURE_CHILD_READY"]).unlink(missing_ok=True)
        grandchild = subprocess.Popen(
            [sys.executable, os.path.realpath(__file__)],
            env=child_env,
            stdin=0,
            stdout=1,
            stderr=2,
            start_new_session=detached_parent,
        )
        grand_ready = wait_for_json(child_env["NS_FIXTURE_CHILD_READY"], 15)
        grand_ready.pop("role", None)
        record["grandchild"] = {"role": grand_role, **grand_ready}

    write_json_atomic(ready_path, record)
    while True:
        signal.pause()


def run_provider() -> int:
    mode = os.environ.get("NS_FIXTURE_MODE", "success")
    if mode not in MODES:
        raise SystemExit(f"unknown NS_FIXTURE_MODE: {mode}")
    ready_path = Path(os.environ["NS_FIXTURE_READY"])
    signals_path = os.environ.get("NS_FIXTURE_SIGNALS")
    port_env = os.environ.get("NS_FIXTURE_PORT")
    resistant = mode == "resistant"

    stdin_probe = None
    if os.environ.get("NS_FIXTURE_ECHO_STDIN") == "1":
        stdin_probe = sys.stdin.readline().rstrip("\n")
        sys.stdout.write(f"NS_FIXTURE_STDIN {stdin_probe}\n")
        sys.stdout.flush()

    roles = ["ordinary"] if mode == "ordinary" else list(PARENT_ROLES)
    ready_dir = ready_path.parent
    write_json_atomic(ready_dir / 'ready-provider.json', process_ids())
    children = []
    for role in roles:
        child_ready = ready_dir / f"ready-{role}.json"
        child_ready.unlink(missing_ok=True)
        child_env = dict(os.environ)
        child_env["NS_FIXTURE_CHILD_ROLE"] = role
        child_env["NS_FIXTURE_CHILD_READY"] = str(child_ready)
        if resistant:
            child_env["NS_FIXTURE_RESISTANT"] = "1"
        if signals_path:
            child_env["NS_FIXTURE_SIGNALS"] = signals_path
        if role == "detached" and port_env:
            child_env["NS_FIXTURE_PORT"] = port_env
        process = subprocess.Popen(
            [sys.executable, os.path.realpath(__file__)],
            env=child_env,
            stdin=0,
            stdout=1,
            stderr=2,
        )
        children.append((role, child_ready, process))

    listeners = []
    for _role, child_ready, _process in children:
        parent_ready = wait_for_json(child_ready, 20)
        grandchild = parent_ready.pop("grandchild", None)
        listeners.append(parent_ready)
        if grandchild:
            listeners.append(grandchild)

    deadline = time.monotonic() + 5
    for listener in listeners:
        while not listener["startId"] or process_start_id(listener["pid"]) != listener["startId"]:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"owned listener not live: {listener['role']}")
            time.sleep(0.02)

    if mode == "incomplete":
        # Listeners are bound and their identities are recorded in the per-child
        # files, but the aggregate readiness handshake is deliberately withheld
        # so the harness exercises its failure-path cleanup.
        def on_term(_signum, _frame):
            os._exit(0)

        signal.signal(signal.SIGTERM, on_term)
        signal.signal(signal.SIGINT, on_term)
        while True:
            signal.pause()

    write_json_atomic(
        ready_path,
        {
            "ready": True,
            "mode": mode,
            "invocationId": os.environ.get("NIGHTSHIFT_INVOCATION_ID"),
            "stdinProbe": stdin_probe,
            "provider": process_ids(),
            "listeners": listeners,
            "createdAt": time.time(),
        },
    )
    sys.stdout.write(f"NS_FIXTURE_STDOUT {mode}\n")
    sys.stderr.write(f"NS_FIXTURE_STDERR {mode}\n")
    sys.stdout.flush()
    sys.stderr.flush()

    if mode == "immediate":
        return 0
    if mode in ("ordinary", "success", "failure"):
        time.sleep(0.15)
        return 0 if mode in ("ordinary", "success") else 7

    def on_term(_signum, _frame):
        os._exit(0)

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    while True:
        signal.pause()


def main() -> int:
    if os.environ.get("NS_FIXTURE_CHILD_ROLE"):
        return run_listener()
    return run_provider()


if __name__ == "__main__":
    raise SystemExit(main())
