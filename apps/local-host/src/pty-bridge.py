#!/usr/bin/env python3
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd):
    try:
        cols = int(os.environ.get("COLUMNS", "80"))
        rows = int(os.environ.get("LINES", "24"))
        size = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
    except Exception:
        pass


def main():
    if len(sys.argv) < 2:
        print("usage: pty-bridge.py <command> [args...]", file=sys.stderr)
        return 2

    command = sys.argv[1:]
    pid, master_fd = pty.fork()

    if pid == 0:
        os.execvpe(command[0], command, os.environ)

    set_winsize(master_fd)

    def forward_signal(signum, _frame):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    while True:
        try:
            readable, _, _ = select.select([master_fd, stdin_fd], [], [])
        except InterruptedError:
            continue

        if master_fd in readable:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(stdout_fd, data)

        if stdin_fd in readable:
            data = os.read(stdin_fd, 4096)
            if data:
                os.write(master_fd, data)

        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            return os.waitstatus_to_exitcode(status)

    try:
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
