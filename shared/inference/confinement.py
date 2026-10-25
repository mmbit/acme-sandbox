"""Apply the candidate filesystem and syscall boundary before any candidate operation."""

import ctypes
import os
import resource


libc = ctypes.CDLL(None, use_errno=True)
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1, 2, 4, 8
# ABI 3 includes cross-directory rename/link and all truncate operations.
FILESYSTEM = (1 << 15) - 1
READ = EXECUTE | READ_FILE | READ_DIR
# x86-64 only. Everything else, including signals, tracing, process handles, network
# connections, IPC, namespace changes and file attributes, is refused by default.
SYSCALLS = {
    'read': 0, 'write': 1, 'open': 2, 'close': 3, 'stat': 4, 'fstat': 5, 'lstat': 6,
    'poll': 7, 'lseek': 8, 'mmap': 9, 'mprotect': 10, 'munmap': 11, 'brk': 12,
    'rt_sigaction': 13, 'rt_sigprocmask': 14, 'rt_sigreturn': 15,
    'pread64': 17, 'pwrite64': 18, 'readv': 19, 'writev': 20, 'access': 21,
    'pipe': 22, 'select': 23, 'sched_yield': 24, 'mremap': 25, 'msync': 26,
    'mincore': 27, 'madvise': 28, 'dup': 32, 'dup2': 33, 'pause': 34,
    'nanosleep': 35, 'getitimer': 36, 'alarm': 37, 'setitimer': 38, 'getpid': 39,
    'sendmsg': 46, 'recvmsg': 47, 'shutdown': 48,
    'clone': 56, 'fork': 57, 'vfork': 58, 'execve': 59, 'exit': 60, 'wait4': 61,
    'uname': 63, 'flock': 73, 'fsync': 74, 'fdatasync': 75, 'truncate': 76,
    'ftruncate': 77, 'getdents': 78, 'getcwd': 79, 'chdir': 80, 'fchdir': 81,
    'rename': 82, 'mkdir': 83, 'rmdir': 84, 'creat': 85, 'link': 86,
    'unlink': 87, 'symlink': 88, 'readlink': 89, 'umask': 95, 'getrlimit': 97,
    'getrusage': 98, 'sysinfo': 99, 'times': 100, 'getuid': 102, 'getgid': 104,
    'geteuid': 107, 'getegid': 108, 'getppid': 110, 'getpgrp': 111,
    'getgroups': 115, 'getresuid': 118, 'getresgid': 120, 'getpgid': 121,
    'getsid': 124, 'sigaltstack': 131,
    'statfs': 137, 'fstatfs': 138, 'getpriority': 140, 'sched_getparam': 143,
    'sched_getscheduler': 145, 'sched_get_priority_max': 146, 'sched_get_priority_min': 147,
    'arch_prctl': 158, 'gettid': 186, 'readahead': 187, 'futex': 202,
    'sched_getaffinity': 204, 'getdents64': 217, 'set_tid_address': 218,
    'restart_syscall': 219, 'fadvise64': 221, 'clock_gettime': 228,
    'clock_getres': 229, 'clock_nanosleep': 230, 'exit_group': 231,
    'epoll_wait': 232, 'epoll_ctl': 233, 'waitid': 247, 'openat': 257,
    'mkdirat': 258, 'newfstatat': 262, 'unlinkat': 263, 'renameat': 264,
    'linkat': 265, 'symlinkat': 266, 'readlinkat': 267, 'faccessat': 269,
    'pselect6': 270, 'ppoll': 271, 'set_robust_list': 273, 'splice': 275,
    'tee': 276, 'sync_file_range': 277, 'vmsplice': 278,
    'epoll_pwait': 281, 'timerfd_create': 283, 'fallocate': 285,
    'timerfd_settime': 286, 'timerfd_gettime': 287, 'eventfd2': 290,
    'epoll_create1': 291, 'dup3': 292, 'pipe2': 293,
    'preadv': 295, 'pwritev': 296, 'getcpu': 309, 'renameat2': 316,
    'getrandom': 318, 'memfd_create': 319, 'execveat': 322,
    'copy_file_range': 326, 'preadv2': 327, 'pwritev2': 328, 'statx': 332,
    'rseq': 334, 'close_range': 436, 'openat2': 437, 'faccessat2': 439,
    'epoll_pwait2': 441, 'futex_waitv': 449,
}


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('access', ctypes.c_uint64), ('fd', ctypes.c_int32)]


class Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('yes', ctypes.c_ubyte),
                ('no', ctypes.c_ubyte), ('operand', ctypes.c_uint)]


class Program(ctypes.Structure):
    _fields_ = [('length', ctypes.c_ushort), ('filters', ctypes.POINTER(Filter))]


def enter(workspace, readable):
    if os.uname().machine != 'x86_64':
        raise RuntimeError('Candidate confinement requires Linux x86-64')
    abi = syscall(444, None, 0, 1)
    if abi < 3:
        raise RuntimeError('Candidate confinement requires Landlock ABI 3 or newer')
    os.closerange(3, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
    rights = ctypes.c_uint64(FILESYSTEM)
    ruleset = syscall(444, ctypes.byref(rights), ctypes.sizeof(rights), 0)
    for path, allowed in [(workspace, FILESYSTEM), *[(path, READ) for path in readable],
                          ('/dev/null', READ_FILE | WRITE_FILE)]:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        if not os.path.isdir(path):
            allowed &= EXECUTE | READ_FILE | WRITE_FILE | (1 << 14)
        rule = PathRule(allowed, fd)
        syscall(445, ruleset, 1, ctypes.byref(rule), 0)
        os.close(fd)
    prctl(38, 1)
    syscall(446, ruleset, 0)
    os.close(ruleset)
    restrict_syscalls()


def syscall(number, *arguments):
    returned = libc.syscall(number, *arguments)
    if returned < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return returned


def prctl(option, *arguments):
    if libc.prctl(option, *arguments, *([0] * (4 - len(arguments)))) != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))


def restrict_syscalls():
    allow, refuse, absent = 0x7fff0000, 0x50001, 0x50026
    # BPF seccomp_data: architecture at 4, syscall number at 0, first argument at 16.
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xc000003e), (0x06, 0, 0, refuse),
                    (0x20, 0, 0, 0)]
    for number in SYSCALLS.values():
        instructions += [(0x15, 0, 1, number), (0x06, 0, 0, allow)]
    # libc falls back to clone when clone3 is unavailable. io_uring stays unavailable under NONET.
    for number in (435, 425):
        instructions += [(0x15, 0, 1, number), (0x06, 0, 0, absent)]
    # fcntl cannot nominate a signal recipient. ioctl permits only pipe/terminal flags and queries.
    for number, argument, values in [(53, 0, [1]), (302, 0, [0]), (72, 1, [0, 1, 2, 3, 4, 5, 6, 7, 1030]),
                                     (16, 1, [0x5421, 0x5451, 0x5450, 0x5401, 0x541b])]:
        branch = [(0x20, 0, 0, 16 + 8 * argument)]
        for value in values:
            branch += [(0x15, 0, 1, value), (0x06, 0, 0, allow)]
        branch += [(0x06, 0, 0, refuse)]
        instructions += [(0x15, 0, len(branch), number), *branch]
    instructions += [(0x06, 0, 0, refuse)]
    filters = (Filter * len(instructions))(*(Filter(*instruction) for instruction in instructions))
    program = Program(len(instructions), filters)
    prctl(22, 2, ctypes.byref(program))
