"""Trace a disposable fixture so a real helper stops at exec, before it can exit."""
import ctypes
import os
import signal
import sys

PTRACE_TRACEME = 0
PTRACE_CONT = 7
PTRACE_DETACH = 17
PTRACE_SETOPTIONS = 0x4200
PTRACE_O_TRACEFORK = 2
PTRACE_O_TRACEVFORK = 4
PTRACE_O_TRACECLONE = 8
PTRACE_O_TRACEEXEC = 16
PTRACE_O_EXITKILL = 0x100000
PTRACE_EVENT_EXEC = 4
WALL = 0x40000000  # Includes Node's threads in waitpid.
PR_SET_CHILD_SUBREAPER = 36

libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
libc.ptrace.restype = ctypes.c_long


def ptrace(request, pid, value=0):
    if libc.ptrace(request, pid, None, value) == -1:
        raise OSError(ctypes.get_errno(), "ptrace")


def trace(command, interruption, arguments):
    # Orphaned helpers from a failing fixture come here to be killed and reaped.
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == -1:
        raise OSError(ctypes.get_errno(), "prctl")
    child = os.fork()
    if child == 0:
        ptrace(PTRACE_TRACEME, 0)
        os.kill(os.getpid(), signal.SIGSTOP)
        os.execv(arguments[0], arguments)
    stopped = set()
    tracees = {child}
    def expired(_signal, _frame):
        raise TimeoutError("Resource enforcement missed its next sample")

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(20)  # The fixture's 15-second bound plus time to report and reap it.
    try:
        os.waitpid(child, 0)
        options = PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK | PTRACE_O_TRACECLONE | PTRACE_O_TRACEEXEC | PTRACE_O_EXITKILL
        ptrace(PTRACE_SETOPTIONS, child, options)
        ptrace(PTRACE_CONT, child)
        while tracees:
            pid, status = os.waitpid(-1, WALL)
            if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                tracees.discard(pid)
                if pid == child:
                    if command != "grep":
                        print(f"{len(stopped)} priority helpers interrupted", flush=True)
                    return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
                continue
            tracees.add(pid)
            event = status >> 16
            # grep stops once, so the fixture's later reads run healthy. Every priority helper stops, so none lowers
            # the priority unseen.
            if event == PTRACE_EVENT_EXEC and (command != "grep" or not stopped):
                with open(f"/proc/{pid}/cmdline", "rb") as stream:
                    executable = stream.read().split(b"\0")[0].decode()
                if os.path.basename(executable) == command:
                    stopped.add(pid)
                    os.kill(pid, interruption)
                    if interruption == signal.SIGSTOP:
                        ptrace(PTRACE_DETACH, pid)  # SIGSTOP is pending before user code runs.
                        tracees.discard(pid)
                    continue
            delivered = os.WSTOPSIG(status)
            ptrace(PTRACE_CONT, pid, 0 if event or delivered in (signal.SIGTRAP, signal.SIGSTOP) else delivered)
        return 1
    finally:
        signal.alarm(0)
        reap(tracees, stopped)


def reap(tracees, stopped):
    for pid in tracees | stopped:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    while True:
        try:
            pid, status = os.waitpid(-1, WALL)
            if os.WIFSTOPPED(status):
                os.kill(pid, signal.SIGKILL)
        except ChildProcessError:
            break
    if not stopped:
        raise AssertionError("No production helper was interrupted")
    for pid in stopped:
        if os.path.exists(f"/proc/{pid}"):
            raise AssertionError("Interrupted helper was not reaped")

sys.exit(trace(sys.argv[1], getattr(signal, sys.argv[2]), sys.argv[3:]))
