#!/usr/bin/python3
"""Close ambient descriptors before entering the globally configured OpenCode CLI."""
import errno
import os


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


if __name__ == '__main__':
    import sys

    close_inherited_descriptors()
    for name in ('SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO'):
        os.environ.pop(name, None)
    os.execvp('opencode', ['opencode', *sys.argv[1:]])
