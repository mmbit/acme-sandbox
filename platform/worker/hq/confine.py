"""Runs a command from a job's checkout confined by Landlock: it writes only under the writable roots and reads only those, the readable roots and the system's own folders.
A seccomp filter refuses it every change of a file's mode, owner, extended attributes (its ACL) or times, which Landlock
doesn't govern: the command runs as the uid that owns the job's home, and could otherwise open it to other slots. Seccomp
sees no paths, so these fail in the roots too (the gates' own tar extracts with -m).

python3 confine.py --write <dir>... [--read <dir>...] -- <command> [args...]

The job's home (its CLI's sign-in and hook config) is in no root, so nothing the command runs can read, change or reopen it.
Landlock needs no privilege or namespace, so it holds where the CLI's own sandbox can't start; a process inside also
can't ptrace or read the /proc files of one outside, the CLI's environment among them.
"""
import ctypes
import os
import sys

SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/proc', '/sys', '/dev']

# linux/landlock.h
CREATE_RULESET_VERSION = 1
RULE_PATH_BENEATH = 1
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
REFER, TRUNCATE, IOCTL_DEV = 1 << 13, 1 << 14, 1 << 15
SYS_CREATE_RULESET, SYS_ADD_RULE, SYS_RESTRICT_SELF = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38

# linux/seccomp.h, linux/filter.h, and the x86_64 calls that change a file's mode, owner, extended attributes or times;
# io_uring too, whose requests can set extended attributes
PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 22, 2
AUDIT_ARCH_X86_64, X32_SYSCALL_BIT = 0xC000003E, 0x40000000
LD_W_ABS, JEQ_K, JGE_K, RET_K = 0x20, 0x15, 0x35, 0x06
ALLOW, REFUSE = 0x7FFF0000, 0x00050000 | 1  # (SECCOMP_RET_ERRNO with EPERM)
ATTRIBUTE_CALLS = {
    'chmod': 90, 'fchmod': 91, 'chown': 92, 'fchown': 93, 'lchown': 94, 'utime': 132,
    'setxattr': 188, 'lsetxattr': 189, 'fsetxattr': 190, 'removexattr': 197, 'lremovexattr': 198, 'fremovexattr': 199,
    'utimes': 235, 'fchownat': 260, 'futimesat': 261, 'fchmodat': 268, 'utimensat': 280, 'io_uring_setup': 425,
    'fchmodat2': 452, 'setxattrat': 463, 'removexattrat': 466,
}

libc = ctypes.CDLL(None, use_errno=True)


class SockFilter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_uint16), ('jt', ctypes.c_uint8), ('jf', ctypes.c_uint8), ('k', ctypes.c_uint32)]


class SockFprog(ctypes.Structure):
    _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(SockFilter))]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


def call(number, *args):
    result = libc.syscall(number, *args)
    if result < 0:
        errno = ctypes.get_errno()
        raise OSError(errno, f'landlock: {os.strerror(errno)}')
    return result


def confine(writable, readable):
    abi = call(SYS_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(CREATE_RULESET_VERSION))
    # every file system right this kernel's Landlock knows (ABI 1: bits 0-12, then REFER, TRUNCATE, IOCTL_DEV)
    handled = (1 << 13) - 1 | (REFER if abi >= 2 else 0) | (TRUNCATE if abi >= 3 else 0) | (IOCTL_DEV if abi >= 5 else 0)
    read = (EXECUTE | READ_FILE | READ_DIR | IOCTL_DEV) & handled
    attr = ctypes.c_uint64(handled)
    ruleset = call(SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0))
    rules = [(d, handled) for d in writable] + [(d, read) for d in readable]
    rules += [(d, read) for d in SYSTEM if os.path.exists(d)] + [('/dev/null', WRITE_FILE)]
    for path, allowed in rules:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        if not os.path.isdir(path):
            allowed &= EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV  # (what a rule on a file may grant)
        rule = PathBeneath(allowed, fd)
        call(SYS_ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(RULE_PATH_BENEATH), ctypes.byref(rule), ctypes.c_uint32(0))
        os.close(fd)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'prctl(PR_SET_NO_NEW_PRIVS)')
    call(SYS_RESTRICT_SELF, ctypes.c_int(ruleset), ctypes.c_uint32(0))
    os.close(ruleset)
    refuse_attribute_changes()


def refuse_attribute_changes():
    if os.uname().machine != 'x86_64':
        raise OSError(f'confine.py knows the attribute calls of x86_64 only, not {os.uname().machine}')
    calls = list(ATTRIBUTE_CALLS.values())
    # every call of another ABI (i386 through int 0x80, x32) is refused; a listed call jumps to the refusal at the end
    program = [(LD_W_ABS, 0, 0, 4), (JEQ_K, 1, 0, AUDIT_ARCH_X86_64), (RET_K, 0, 0, REFUSE), (LD_W_ABS, 0, 0, 0)]
    program += [(JGE_K, len(calls) + 1, 0, X32_SYSCALL_BIT)]
    program += [(JEQ_K, len(calls) - i, 0, nr) for i, nr in enumerate(calls)]
    program += [(RET_K, 0, 0, ALLOW), (RET_K, 0, 0, REFUSE)]
    filters = (SockFilter * len(program))(*(SockFilter(*op) for op in program))
    fprog = SockFprog(len(program), filters)
    if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(fprog), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'prctl(PR_SET_SECCOMP)')


def main(argv):
    if '--' not in argv:
        sys.exit('use confine.py --write <dir>... [--read <dir>...] -- <command> [args...]')
    roots, command = argv[: argv.index('--')], argv[argv.index('--') + 1 :]
    writable, readable, into = [], [], None
    for arg in roots:
        if arg in ('--write', '--read'):
            into = writable if arg == '--write' else readable
        elif into is None:
            sys.exit(f'confine.py: {arg} follows no --write or --read')
        else:
            into.append(arg)
    if not writable or not command:
        sys.exit('use confine.py --write <dir>... [--read <dir>...] -- <command> [args...]')
    confine(writable, readable)
    os.execvp(command[0], command)


if __name__ == '__main__':
    main(sys.argv[1:])
