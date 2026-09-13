#!/usr/bin/env python3
"""Measure and smoke-test the release TUI through a real POSIX PTY."""

import argparse
import ctypes
import fcntl
import json
import os
import platform
import re
import select
import signal
import socket
import statistics
import struct
import subprocess
import tempfile
import termios
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "server" / "tests" / "fixtures"
SIZES = ((120, 42), (79, 23))
UNCHANGED_FRAME = b"\x1b[39m\x1b[49m\x1b[59m\x1b[0m\x1b[?25l"


def positive(value: str) -> float:
    number = float(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def label(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise argparse.ArgumentTypeError("use only letters, numbers, '_' or '-'")
    return value


def commit(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise argparse.ArgumentTypeError("must be a full lowercase commit SHA")
    return value


class FakeHerdr:
    def __init__(self, path: Path, snapshot: dict):
        self.path = path
        self.snapshot = snapshot
        self.subscribers = []
        self.stop = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path))
        self.listener.listen()
        self.listener.settimeout(0.1)
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.listener.close()
        self.thread.join(timeout=1)
        for connection in self.subscribers:
            connection.close()

    def transition(self, snapshot: dict):
        self.snapshot = snapshot
        event = b'{"event":"pane.updated","data":{"pane_id":"p-11"}}\n'
        for connection in self.subscribers[:]:
            try:
                connection.sendall(event)
            except OSError:
                self.subscribers.remove(connection)

    def _serve(self):
        while not self.stop.is_set():
            try:
                connection, _ = self.listener.accept()
            except (TimeoutError, OSError):
                continue
            threading.Thread(target=self._respond, args=(connection,), daemon=True).start()

    def _respond(self, connection: socket.socket):
        try:
            request = b""
            while not request.endswith(b"\n"):
                chunk = connection.recv(4096)
                if not chunk:
                    return
                request += chunk
            method = json.loads(request)["method"]
            if method == "session.snapshot":
                payload = self.snapshot
                if "result" not in payload:
                    payload = {"result": {"type": "session_snapshot", "snapshot": payload}}
                connection.sendall(json.dumps(payload, separators=(",", ":")).encode() + b"\n")
            else:
                connection.sendall(
                    b'{"id":"herdr-mise-events","result":{"type":"subscription_started"}}\n'
                )
                self.subscribers.append(connection)
                while not self.stop.wait(0.1):
                    pass
                return
        finally:
            if connection not in self.subscribers:
                connection.close()


def fixture(name: str, state: str | None = None) -> dict:
    value = json.loads((FIXTURES / name).read_text())
    snapshot = value.get("result", {}).get("snapshot", value)
    if state:
        snapshot = json.loads(json.dumps(snapshot))
        snapshot["agents"] = [snapshot["agents"][0]]
        snapshot["agents"][0]["agent_status"] = state
    return snapshot


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def resize(fd: int, width: int, height: int):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))


def drain(fd: int, seconds: float) -> bytes:
    output = bytearray()
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], max(0, min(0.02, deadline - time.monotonic())))
        if ready:
            try:
                output.extend(os.read(fd, 65536))
            except OSError:
                break
    return bytes(output)


def launch(binary: Path, server: FakeHerdr, width: int, height: int, reduced: bool = False):
    master, slave = os.openpty()
    resize(slave, width, height)
    env = os.environ.copy()
    env.update(
        TERM="xterm-256color",
        HERDR_SOCKET_PATH=str(server.path),
        HERDR_MISE_PORT=str(free_port()),
    )
    if reduced:
        env["HERDR_MISE_REDUCED_MOTION"] = "1"
    else:
        env.pop("HERDR_MISE_REDUCED_MOTION", None)
    process = subprocess.Popen(
        [str(binary), "--tui"], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True
    )
    os.close(slave)
    return process, master


def stop(process: subprocess.Popen, master: int):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)


class RusageInfo(ctypes.Structure):
    _fields_ = [
        ("uuid", ctypes.c_ubyte * 16),
        ("user_time", ctypes.c_uint64),
        ("system_time", ctypes.c_uint64),
        ("package_idle_wakeups", ctypes.c_uint64),
        ("interrupt_wakeups", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64),
        ("wired_size", ctypes.c_uint64),
        ("resident_size", ctypes.c_uint64),
        ("physical_footprint", ctypes.c_uint64),
        ("remaining", ctypes.c_uint64 * 12),
    ]


def sample_process(pid: int) -> tuple[float, int]:
    if platform.system() == "Darwin":
        info = RusageInfo()
        if ctypes.CDLL("/usr/lib/libproc.dylib").proc_pid_rusage(pid, 2, ctypes.byref(info)):
            raise OSError("proc_pid_rusage failed")
        return (info.user_time + info.system_time) / 1_000_000_000, info.resident_size // 1024
    stat = Path(f"/proc/{pid}/stat").read_text().split()
    rss_kib = int(stat[23]) * os.sysconf("SC_PAGE_SIZE") // 1024
    return (int(stat[13]) + int(stat[14])) / os.sysconf("SC_CLK_TCK"), rss_kib


def measure_once(binary: Path, snapshot: dict, size: tuple[int, int], reduced: bool, warmup: float, window: float):
    with tempfile.TemporaryDirectory(prefix="herdr-mise-tui-") as directory:
        path = Path(directory) / "herdr.sock"
        with FakeHerdr(path, snapshot) as server:
            process, master = launch(binary, server, *size, reduced)
            try:
                drain(master, warmup)
                started_cpu, _ = sample_process(process.pid)
                rss_samples = []
                output = bytearray()
                deadline = time.monotonic() + window
                while time.monotonic() < deadline:
                    output.extend(drain(master, min(0.2, deadline - time.monotonic())))
                    _, rss = sample_process(process.pid)
                    rss_samples.append(rss)
                finished_cpu, rss = sample_process(process.pid)
                rss_samples.append(rss)
                return {
                    "cpuPercent": (finished_cpu - started_cpu) / window * 100,
                    "rssKiB": statistics.median(rss_samples),
                    "bytesPerSecond": len(output) / window,
                }
            finally:
                stop(process, master)


def await_output(master: int, action, expected: bytes, message: str) -> bytes:
    drain(master, 0.05)
    started = time.monotonic()
    action()
    output = drain(master, 0.25)
    if expected not in output or time.monotonic() - started > 0.27:
        raise AssertionError(f"{message} did not produce PTY output within 250 ms")
    return output


def verify_elapsed_change(master: int, message: str):
    drain(master, 0.1)
    output = drain(master, 1.1).replace(UNCHANGED_FRAME, b"")
    if not output:
        raise AssertionError(f"{message} elapsed text did not advance within one second")


def verify(binary: Path):
    working = fixture("snapshot-working-idle-accents.json", "working")
    blocked = fixture("snapshot-herdr-0.8.0-p19.json")
    with tempfile.TemporaryDirectory(prefix="herdr-mise-tui-verify-") as directory:
        with FakeHerdr(Path(directory) / "herdr.sock", working) as server:
            process, master = launch(binary, server, 120, 42, reduced=True)
            try:
                drain(master, 0.5)
                await_output(master, lambda: os.write(master, b"?"), b"Shift+Tab inspect", "help input")
                await_output(master, lambda: server.transition(blocked), b"BLOCKED", "Feed transition")
                verify_elapsed_change(master, "blocked scene")
                await_output(
                    master,
                    lambda: (resize(master, 79, 23), os.kill(process.pid, signal.SIGWINCH)),
                    b"\x1b[2J",
                    "PTY resize",
                )
                verify_elapsed_change(master, "compact table")
                os.write(master, b"q")
                restored = drain(master, 1)
                process.wait(timeout=1)
                if b"\x1b[?1049l" not in restored:
                    raise AssertionError("quit omitted alternate-screen restoration")
            finally:
                stop(process, master)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=ROOT / "target/release/herdr-mise")
    parser.add_argument("--commit", type=commit)
    parser.add_argument("--label", type=label, default="candidate")
    parser.add_argument("--runs", type=positive_int, default=3)
    parser.add_argument("--warmup", type=positive, default=1)
    parser.add_argument("--window", type=positive, default=2)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        parser.error(f"binary not found: {binary}")
    if binary != (ROOT / "target/release/herdr-mise").resolve() and not args.commit:
        parser.error("--commit is required with a custom --binary")

    profiles = (
        ("idle", fixture("snapshot-working-idle-accents.json", "idle"), False),
        ("working", fixture("snapshot-working-idle-accents.json", "working"), False),
        ("blocked", fixture("snapshot-herdr-0.8.0-p19.json"), False),
        ("working-reduced-motion", fixture("snapshot-working-idle-accents.json", "working"), True),
    )
    rows = []
    for name, snapshot, reduced in profiles:
        for size in SIZES:
            runs = [measure_once(binary, snapshot, size, reduced, args.warmup, args.window) for _ in range(args.runs)]
            rows.append(
                {
                    "profile": name,
                    "size": f"{size[0]}x{size[1]}",
                    **{key: statistics.median(run[key] for run in runs) for key in runs[0]},
                }
            )
    if args.verify:
        verify(binary)

    report = {
        "label": args.label,
        "binary": str(binary),
        "commit": args.commit
        or subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip(),
        "os": platform.platform(),
        "hardware": subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True
        ).stdout.strip()
        or platform.machine(),
        "warmupSeconds": args.warmup,
        "windowSeconds": args.window,
        "runs": args.runs,
        "results": rows,
        "verified": args.verify,
    }
    artifacts = ROOT / "perf" / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    destination = artifacts / f"tui-measure-{args.label}.json"
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print("profile size cpu_percent rss_kib bytes_per_second")
    for row in rows:
        print(
            row["profile"], row["size"], f'{row["cpuPercent"]:.2f}',
            f'{row["rssKiB"]:.0f}', f'{row["bytesPerSecond"]:.0f}'
        )
    print(f"wrote {destination.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
