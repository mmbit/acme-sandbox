"""Measure allocated bytes incrementally through verified, slot-readable directory descriptors."""

import errno
import os
import sys
from typing import NamedTuple

from diskindex import DiskIndex
from diskwatch import DiskWatch
from diskstat import DIRECTORY_FLAGS, PATH_FLAGS, Snapshot, same, snapshot
from diskerror import AccountingError


class Anchor(NamedTuple):
    parent: int
    descriptor: int
    name: bytes
    original: Snapshot


class DiskTree:
    def __init__(self, roots, budget_mb):
        self.roots = [os.fsencode(os.path.abspath(root)) for root in roots]
        self.index = DiskIndex(budget_mb)
        # Python 3.11+ keeps Python call frames off the C stack. The indexed-entry bound also bounds traversal depth.
        sys.setrecursionlimit(max(sys.getrecursionlimit(), self.index.entry_limit * 3 + 100))
        try:
            self.watch = DiskWatch()
        except Exception:
            self.index.close()
            raise

    def measure(self):
        self.watch.drain(self.index)
        # Bounds cover every root. Release stale charges everywhere before any directory can add entries.
        for root in self.roots:
            self.measure_root(root, reconcile=True)
        for root in self.roots:
            self.measure_root(root)
        self.watch.drain(self.index)
        return self.index.bytes

    def measure_root(self, root, reconcile=False):
        anchored = anchor(root)
        if anchored is None:
            self.remove(self.index.find(0, root))
            return
        base, directories = anchored
        try:
            parent, descriptor, name, original = directories[-1]
            self.refresh(parent, name, 0, root, utf16_length(root), descriptor=descriptor, reconcile=reconcile)
            root_entry = self.index.find(0, root)
            through = self.index.sequence
            if root_entry and reconcile:
                for dirty in self.index.dirty_entries(root_entry.id, through):
                    self.refresh_path(dirty, descriptor, reconcile=True)
            while root_entry and not reconcile:
                dirty = self.index.pop_dirty(root_entry.id, through)
                if dirty is None:
                    break
                self.refresh_path(dirty, descriptor)
            for ancestor in directories[:-1]:
                verify_ancestor(ancestor)
            if not same(original, snapshot(parent, name)):
                self.remove(self.index.find(0, root))
        finally:
            close_anchor(base, directories)

    def refresh_path(self, entry, descriptor, reconcile=False):
        ancestors = []
        current = entry
        while current.parent:
            ancestors.append(current)
            current = self.index.get(current.parent)
        if not ancestors:
            if reconcile:
                self.remove_vanished(entry.id, descriptor)
            else:
                self.scan_directory(entry, descriptor)
            return
        opened = []
        parent = descriptor
        try:
            for ancestor in reversed(ancestors[1:]):
                handle = open_directory(parent, ancestor.name)
                if handle is None:
                    self.remove(ancestor)
                    return
                opened.append((parent, handle, ancestor))
                if not same(ancestor, snapshot(handle)):
                    self.rescan_parent(ancestor)
                    return
                parent = handle
            target = ancestors[0]
            self.refresh(parent, target.name, target.parent, target.name, target.length, full=True, reconcile=reconcile)
            for parent, handle, ancestor in opened:
                if not same(ancestor, snapshot(parent, ancestor.name)):
                    self.rescan_parent(ancestor)
                    break
        finally:
            for parent, handle, ancestor in reversed(opened):
                os.close(handle)

    def refresh(self, parent, name, parent_id, stored_name, length, descriptor=None, full=False, generation=0, reconcile=False):
        original = snapshot(parent, name)
        previous = self.index.find(parent_id, stored_name)
        if original is None:
            self.remove(previous)
            return
        changed = previous is None or not same(previous, original)
        if previous and previous.directory and (changed or not original.directory):
            self.remove(previous)
            previous = None
        if reconcile:
            if previous is None:
                return
            entry = previous
        else:
            entry = self.index.replace(previous, parent_id, stored_name, original, length, generation)
        if not entry.directory:
            return
        handle = descriptor if descriptor is not None else open_directory(parent, name)
        if handle is None:
            self.remove(entry)
            return
        try:
            if not same(original, snapshot(handle)):
                self.rescan_parent(entry)
                return
            if full or changed or entry.watch is None:
                if reconcile:
                    self.remove_vanished(entry.id, handle)
                else:
                    self.scan_directory(entry, handle)
            current = snapshot(parent, name)
            if current is None:
                self.remove(entry)
            elif not same(original, current):
                self.rescan_parent(entry)
        finally:
            if descriptor is None:
                os.close(handle)

    def scan_directory(self, entry, descriptor):
        if entry.watch is None:
            self.index.set_watch(entry.id, self.watch.add(descriptor))
        self.index.generation += 1
        generation = self.index.generation
        self.remove_vanished(entry.id, descriptor)
        try:
            with os.scandir(descriptor) as children:
                for child in children:
                    name = os.fsencode(child.name)
                    length = entry.length + 1 + utf16_length(name)
                    self.refresh(descriptor, name, entry.id, name, length, generation=generation)
        except FileNotFoundError:
            pass  # A deleted descriptor has no children, and its parent identity is checked after the scan.
        while True:
            missing = self.index.unseen_child(entry.id, generation)
            if missing is None:
                break
            self.remove(missing)
        self.watch.drain(self.index)

    def remove_vanished(self, identifier, descriptor):
        for child in self.index.children(identifier):
            if not same(child, snapshot(descriptor, child.name)):
                self.remove(child)

    def rescan_parent(self, entry):
        parent = entry.parent
        self.remove(entry)
        if parent:
            self.index.queue(parent)

    def remove(self, entry):
        if entry is None:
            return
        entry = self.index.get(entry.id)
        if entry is None:
            return
        if entry.directory:
            while True:
                child = self.index.first_child(entry.id)
                if child is None:
                    break
                self.remove(child)
            if entry.watch is not None and self.index.watch_references(entry.watch) == 1:
                self.watch.remove(entry.watch)
        self.index.forget(entry)

    def close(self):
        self.watch.close()
        self.index.close()


def anchor(path):
    directories = []
    base = None
    reason = "worker-ancestor"
    try:
        base = os.open(b"/", PATH_FLAGS)
        parent = base
        names = path.strip(b"/").split(b"/")
        for position, name in enumerate(names):
            final = position == len(names) - 1
            reason = "job-tree" if final else "worker-ancestor"
            descriptor = os.open(name, DIRECTORY_FLAGS if final else PATH_FLAGS, dir_fd=parent)
            directories.append(Anchor(parent, descriptor, name, snapshot(descriptor)))
            parent = descriptor
        return base, directories
    except OSError as failure:
        close_anchor(base, directories)
        if failure.errno == errno.ENOENT:
            return None
        raise AccountingError(reason, described(failure)) from failure


def close_anchor(base, directories):
    for parent, descriptor, name, original in reversed(directories):
        os.close(descriptor)
    if base is not None:
        os.close(base)


def verify_ancestor(ancestor):
    try:
        if not same(ancestor.original, snapshot(ancestor.parent, ancestor.name)):
            raise AccountingError("worker-ancestor", "Disk directory moved during accounting")
    except OSError as failure:
        raise AccountingError("worker-ancestor", described(failure)) from failure


def open_directory(parent, name):
    try:
        return os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    except FileNotFoundError:
        return None


def described(failure):
    symbol = errno.errorcode.get(getattr(failure, "errno", None))
    return f"{symbol}: {failure}" if symbol else str(failure)


def utf16_length(path):
    return len(os.fsdecode(path).encode("utf-16-le", "surrogatepass")) // 2
