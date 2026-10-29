#!/usr/bin/env python3
"""The worker container's first process: it runs the worker and outlives it, so a reload of the worker keeps the jobs' processes.

SIGUSR2 reloads the worker, SIGTERM and SIGINT stop it, and a worker that crashes starts again after a pause. How it
works is in knowledge/notes/platform/worker-restarts.md.
"""
import ctypes
import os
import shutil
import signal
import socket
import sys
import time

CODE = os.environ.get("WORKER_CODE", "/work/code")
RUNS = os.environ.get("WORKER_RUNS", "/work/runs")
NODE = os.environ.get("WORKER_NODE") or shutil.which("node") or "node"
RESTART_S = float(os.environ.get("WORKER_RESTART_S", "5"))   # the first pause after a crash; doubled, at most a minute
SIGNALS = {signal.SIGCHLD, signal.SIGTERM, signal.SIGINT, signal.SIGUSR2}


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "supervisor:", *a, file=sys.stderr, flush=True)


def start_time(pid):
    """A process's start (clock ticks since boot, /proc/<pid>/stat's 22nd field): with its pid, it names one process."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            stat = f.read()
        return stat[stat.rindex(")") + 2 :].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def note_exit(pid, info):
    """An orphaned run's end, into the marker its worker made (none: not a run, nothing to keep)."""
    start = start_time(pid)   # still readable: the child waits, unreaped, until this is written (WNOWAIT)
    marker = f"{RUNS}/pid-{pid}-{start}"
    if start is None or not os.path.exists(marker):
        return
    how = f"exit {info.si_status}" if info.si_code == os.CLD_EXITED else f"signal {info.si_status}"
    try:
        with open(f"{marker}.new", "w") as f:
            f.write(how)
        os.replace(f"{marker}.new", marker)
    except OSError as err:
        log(f"couldn't note how process {pid} ended:", err)


def refresh_socket():
    """The loopback socket Codex runs send their sign-in refreshes to (the worker's refreshes.ts), bound once for the
    container's life: a reload of the worker never frees its port for a job's process to take.
"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    sock.set_inheritable(True)
    return sock


REFRESH = None   # main's refresh_socket()


def start_worker():
    """The worker from the code staged now, or None while there's none yet (a new server's first deploy stages it)."""
    current = f"{CODE}/current"
    if not os.path.isfile(f"{current}/src/worker.ts"):
        return None
    code = os.path.realpath(current)
    # what runs, as a link beside current: sync.sh reloads the worker while they differ, and hq follows it
    if os.path.lexists(f"{CODE}/running.new"):
        os.remove(f"{CODE}/running.new")
    os.symlink(os.path.basename(code), f"{CODE}/running.new")
    os.replace(f"{CODE}/running.new", f"{CODE}/running")
    env = {**os.environ, "WORKER_REFRESH_FD": str(REFRESH.fileno())}
    pid = os.posix_spawn(NODE, [NODE, f"{code}/src/worker.ts"], env, setsigmask=())
    log(f"worker started (pid {pid}, code {os.path.basename(code)})")
    return pid


def main():
    # orphans come here even when this isn't PID 1 (a test): PR_SET_CHILD_SUBREAPER
    ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)
    for s in SIGNALS:
        signal.signal(s, lambda *_: None)   # a handler, so PID 1 isn't immune to them; they're taken by sigwaitinfo
    signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    global REFRESH
    REFRESH = refresh_socket()
    worker, reloading, stopping, pause, started = start_worker(), False, False, RESTART_S, time.monotonic()
    due = None if worker else time.monotonic() + 10   # (no code yet: look again in a while)
    if not worker:
        log(f"no worker code in {CODE}/current yet; waiting for sync.sh to stage it")
    while True:
        wait = None if due is None else max(0.0, due - time.monotonic())
        sig = signal.sigtimedwait(SIGNALS, wait) if wait is not None else signal.sigwaitinfo(SIGNALS)
        if sig is None:   # a pause ended
            due = None
            if not stopping and not worker:
                worker, started = start_worker(), time.monotonic()
                if not worker:
                    due = time.monotonic() + 10
            continue
        if sig.si_signo in (signal.SIGTERM, signal.SIGINT):
            stopping = True
            if not worker:
                return 0
            os.kill(worker, signal.SIGTERM)
        elif sig.si_signo == signal.SIGUSR2:
            if worker and not reloading:
                reloading = True
                log("reloading the worker: its runs go on, and the new one takes them over")
                os.kill(worker, signal.SIGUSR2)
            elif not worker and not stopping:
                due = time.monotonic()
        # SIGCHLD (or any signal: several children can end under one): reap everything that ended
        while True:
            try:
                info = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                break
            if info is None:
                break
            if info.si_pid != worker:
                note_exit(info.si_pid, info)
            try:
                os.waitpid(info.si_pid, 0)
            except ChildProcessError:
                pass
            if info.si_pid != worker:
                continue
            code = info.si_status if info.si_code == os.CLD_EXITED else 128 + info.si_status
            worker = None
            if stopping:
                log(f"worker stopped ({code})")
                return code
            if reloading:
                reloading = False
                worker, started = start_worker(), time.monotonic()
                if not worker:
                    due = time.monotonic() + 10
                continue
            # a crash: started again after a pause (longer while it keeps crashing soon after starting)
            pause = min(pause * 2, 60.0) if time.monotonic() - started < 60 else RESTART_S
            log(f"worker exited ({code}); starting it again in {pause:.0f} s, its runs go on")
            due = time.monotonic() + pause


if __name__ == "__main__":
    sys.exit(main())
