#!/usr/bin/python3
"""Supervise one OpenCode invocation; identity is bookkeeping, not containment."""
import ctypes
import errno
import os
import signal
import struct
import subprocess
import sys
import time
import uuid


def close_inherited_descriptors():
    # macOS exposes actual open descriptors here; a soft RLIMIT is insufficient
    # when a parent lowered its limit after opening a higher-numbered descriptor.
    for name in os.listdir('/dev/fd'):
        descriptor = int(name)
        if descriptor <= 2:
            continue
        try:
            os.close(descriptor)
        except OSError as error:
            # listdir's own directory descriptor has already been closed.
            if error.errno != errno.EBADF:
                raise


IDENTITY = 'NIGHTSHIFT_INVOCATION_ID'
CLEANUP_SECONDS = 3.5  # Strictly below runCli's five-second supervisor grace.


class Processes:
    def __init__(self):
        if sys.platform == 'darwin':
            self.lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
            self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
            self.libc = ctypes.CDLL(None, use_errno=True)

    def pids(self):
        if sys.platform != 'darwin':
            return [int(p) for p in os.listdir('/proc') if p.isdigit()]
        # A fixed ceiling keeps each native inspection bounded; overflow fails closed.
        buf = (ctypes.c_int * 32768)()
        size = self.lib.proc_listpids(1, 0, buf, ctypes.sizeof(buf))
        if size <= 0 or size >= ctypes.sizeof(buf):
            raise RuntimeError('process enumeration unavailable or exceeds bound')
        return [p for p in buf[:size // 4] if p > 0]

    def inspect(self, pid):
        try:
            if sys.platform != 'darwin':
                with open(f'/proc/{pid}/stat', 'rb') as stream:
                    fields = stream.read().rsplit(b')', 1)[1].split()
                if fields[0] == b'Z':
                    return None
                with open(f'/proc/{pid}/environ', 'rb') as stream:
                    entries = stream.read(1048576).split(b'\0')
                return fields[19], entries
            # proc_bsdinfo has a stable 136-byte ABI, including start timeval.
            info = ctypes.create_string_buffer(136)
            if self.lib.proc_pidinfo(pid, 3, 0, info, 136) != 136:
                return None  # Exited or not visible to this uid.
            status = struct.unpack_from('I', info.raw, 4)[0]
            uid = struct.unpack_from('I', info.raw, 20)[0]
            if status == 5 or uid != os.getuid():
                return None
            start = info.raw[120:136]
            buf = ctypes.create_string_buffer(1048576)
            size = ctypes.c_size_t(len(buf))
            mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
            if self.libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
                error = ctypes.get_errno()
                if error in (errno.ESRCH, errno.EINVAL):
                    return None
                raise OSError(error, 'invocation environment inspection failed')
            raw = buf.raw[:size.value]
            argc = struct.unpack_from('i', raw)[0]
            cursor = raw.index(b'\0', 4) + 1
            while cursor < len(raw) and raw[cursor] == 0:
                cursor += 1
            for _ in range(argc):
                cursor = raw.index(b'\0', cursor) + 1
            return start, raw[cursor:].split(b'\0')
        except (FileNotFoundError, ProcessLookupError):
            return None

    def owned(self, entry, deadline):
        result = []
        for pid in self.pids():
            if time.monotonic() >= deadline:
                raise RuntimeError('invocation inspection deadline exceeded')
            if pid == os.getpid():
                continue
            info = self.inspect(pid)
            if info and entry in info[1]:
                result.append((pid, info[0]))
        return result

    def terminate(self, owned, entry, sig):
        for pid, start in owned:
            info = self.inspect(pid)
            if info and info[0] == start and entry in info[1]:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass


def main():
    requested = []
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda number, frame: requested.append(number))

    close_inherited_descriptors()
    for name in ('SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO'):
        os.environ.pop(name, None)
    os.environ[IDENTITY] = uuid.uuid4().hex
    entry = f'{IDENTITY}={os.environ[IDENTITY]}'.encode()
    processes = Processes()
    child = None
    code = 1
    try:
        if not requested:
            child = subprocess.Popen(['opencode', *sys.argv[1:]])
            while child.poll() is None and not requested:
                time.sleep(0.02)
            code = child.poll()
    except Exception as error:
        print(f'nightshift launcher: startup failed: {error}', file=sys.stderr)
    finally:
        deadline = time.monotonic() + CLEANUP_SECONDS
        escalate = time.monotonic() + 0.5
        try:
            while True:
                if child is not None:
                    child.poll()
                owned = processes.owned(entry, deadline)
                if not owned:
                    break
                processes.terminate(owned, entry, signal.SIGKILL if time.monotonic() >= escalate else signal.SIGTERM)
                time.sleep(0.02)
            if child is not None:
                child.wait(timeout=max(0.001, deadline - time.monotonic()))
        except Exception as error:
            print(f'nightshift launcher: cleanup not established: {error}', file=sys.stderr)
            return 1
    if requested:
        signal.signal(requested[0], signal.SIG_DFL)
        os.kill(os.getpid(), requested[0])
    if code is not None and code < 0:
        signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code if code is not None else 1


if __name__ == '__main__':
    sys.exit(main())
