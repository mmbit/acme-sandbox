"""Read Linux file identity and allocated blocks through held directory descriptors."""

import ctypes
import errno
import os
import stat
import struct
from typing import NamedTuple

DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
PATH_FLAGS = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
# linux/fcntl.h and linux/stat.h
AT_SYMLINK_NOFOLLOW, AT_EMPTY_PATH = 0x100, 0x1000
STATX_TYPE, STATX_INO, STATX_BLOCKS, STATX_BTIME = 0x1, 0x100, 0x400, 0x800
STATX_FIELDS = STATX_TYPE | STATX_INO | STATX_BLOCKS | STATX_BTIME


class StatxTimestamp(ctypes.Structure):
    _fields_ = [("seconds", ctypes.c_int64), ("nanoseconds", ctypes.c_uint32), ("reserved", ctypes.c_int32)]


class Statx(ctypes.Structure):
    # linux/stat.h keeps this 256-byte ABI extensible through reserved trailing fields.
    _fields_ = [
        ("mask", ctypes.c_uint32), ("block_size", ctypes.c_uint32), ("attributes", ctypes.c_uint64),
        ("links", ctypes.c_uint32), ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32),
        ("mode", ctypes.c_uint16), ("reserved", ctypes.c_uint16), ("inode", ctypes.c_uint64),
        ("size", ctypes.c_uint64), ("blocks", ctypes.c_uint64), ("attributes_mask", ctypes.c_uint64),
        ("accessed", StatxTimestamp), ("born", StatxTimestamp), ("changed", StatxTimestamp), ("modified", StatxTimestamp),
        ("rdev_major", ctypes.c_uint32), ("rdev_minor", ctypes.c_uint32),
        ("dev_major", ctypes.c_uint32), ("dev_minor", ctypes.c_uint32),
        ("extensions", ctypes.c_uint64 * 14),
    ]


class Snapshot(NamedTuple):
    identity: bytes
    born: int
    allocated: int
    directory: bool


LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.statx.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx))
LIBC.statx.restype = ctypes.c_int
STAT_BUFFER = Statx()


def snapshot(parent, name=b""):
    flags = AT_SYMLINK_NOFOLLOW | (AT_EMPTY_PATH if not name else 0)
    if LIBC.statx(parent, name, flags, STATX_FIELDS, ctypes.byref(STAT_BUFFER)) != 0:
        failure = ctypes.get_errno()
        if failure == errno.ENOENT:
            return None
        raise OSError(failure, os.strerror(failure), os.fsdecode(name))
    identity = struct.pack("IIQ", STAT_BUFFER.dev_major, STAT_BUFFER.dev_minor, STAT_BUFFER.inode)
    born = STAT_BUFFER.born.seconds * 10**9 + STAT_BUFFER.born.nanoseconds
    return Snapshot(identity, born, STAT_BUFFER.blocks * 512, stat.S_ISDIR(STAT_BUFFER.mode))


def same(left, right):
    return left is not None and right is not None and left.identity == right.identity and left.born == right.born
