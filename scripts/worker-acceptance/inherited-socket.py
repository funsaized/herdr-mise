"""Inject a dummy socket into Deno; prove the production provider launcher closes it."""
import os
from pathlib import Path
import socket
import subprocess

control = Path(__file__).resolve().parents[2]
deno = os.environ.get('DENO_EXEC_PATH', str(Path.home() / '.swamp/deno/deno'))
left, right = socket.socketpair()
os.dup2(right.fileno(), 123, inheritable=True)
try:
    baseline = subprocess.check_output(
        ['/usr/bin/python3', '-c',
         'import os,stat;print(stat.S_ISSOCK(os.fstat(123).st_mode))'],
        pass_fds=(123,), text=True,
    )
    assert baseline.strip() == 'True', 'fixture socket was not inherited'
    subprocess.run(
        [deno, 'run', '--no-lock', '--node-modules-dir=none', '--allow-all',
         str(Path(__file__).with_suffix('.ts')), str(control)],
        pass_fds=(123,), check=True,
    )
finally:
    os.close(123)
    left.close()
    right.close()
