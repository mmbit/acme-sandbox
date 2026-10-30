"""Maintain Linux inotify watches and drain a bounded snapshot of queued events."""

import ctypes
import errno
import fcntl
import os
import struct
import termios

LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.inotify_init1.argtypes = (ctypes.c_int,)
LIBC.inotify_init1.restype = ctypes.c_int
LIBC.inotify_add_watch.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
LIBC.inotify_add_watch.restype = ctypes.c_int
LIBC.inotify_rm_watch.argtypes = (ctypes.c_int, ctypes.c_int)
LIBC.inotify_rm_watch.restype = ctypes.c_int
EVENT = struct.Struct("iIII")
# linux/inotify.h
IN_MODIFY, IN_ATTRIB, IN_CLOSE_WRITE, IN_MOVED_FROM, IN_MOVED_TO = 0x2, 0x4, 0x8, 0x40, 0x80
IN_CREATE, IN_DELETE, IN_DELETE_SELF, IN_MOVE_SELF = 0x100, 0x200, 0x400, 0x800
IN_UNMOUNT, IN_Q_OVERFLOW, IN_IGNORED, IN_ONLYDIR = 0x2000, 0x4000, 0x8000, 0x1000000
WATCHED_EVENTS = (
    IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO
    | IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF | IN_ONLYDIR
)


class DiskWatch:
    def __init__(self):
        self.descriptor = LIBC.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        if self.descriptor < 0:
            failure = ctypes.get_errno()
            raise OSError(failure, os.strerror(failure))

    def add(self, descriptor):
        # The proc link targets our already verified open descriptor, never a slot-supplied symlink.
        path = f"/proc/self/fd/{descriptor}".encode()
        watch = LIBC.inotify_add_watch(self.descriptor, path, WATCHED_EVENTS)
        if watch < 0:
            failure = ctypes.get_errno()
            raise OSError(failure, os.strerror(failure))
        return watch

    def remove(self, watch):
        if LIBC.inotify_rm_watch(self.descriptor, watch) != 0:
            failure = ctypes.get_errno()
            if failure != errno.EINVAL:  # The kernel already removes a deleted directory's watch.
                raise OSError(failure, os.strerror(failure))

    def drain(self, index):
        # FIONREAD snapshots the queued bytes so a continuously writing slot cannot hold a resource pass open.
        queued = struct.unpack("i", fcntl.ioctl(self.descriptor, termios.FIONREAD, bytes(4)))[0]
        while queued:
            try:
                events = os.read(self.descriptor, min(queued, 65536))
            except BlockingIOError:
                return
            queued -= len(events)
            offset = 0
            while offset < len(events):
                watch, mask, cookie, length = EVENT.unpack_from(events, offset)
                offset += EVENT.size + length
                if mask & IN_Q_OVERFLOW:
                    index.invalidate_directories()
                    continue
                if mask & IN_UNMOUNT:
                    raise OSError("Disk changes lost: filesystem unmounted")
                for entry in index.watched(watch):
                    if mask & IN_IGNORED:
                        index.set_watch(entry.id, None)
                    index.queue(entry.id)
                    if mask & (IN_DELETE_SELF | IN_MOVE_SELF | IN_IGNORED) and entry.parent:
                        index.queue(entry.parent)

    def close(self):
        os.close(self.descriptor)
