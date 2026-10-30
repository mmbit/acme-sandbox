"""Keep scanner entries and identity charges in a private temporary database with a bounded page cache."""

import os
import sqlite3
import tempfile
from typing import NamedTuple

from diskerror import AccountingError


# Keep the supported tree size from the Map scanner so storage changes do not widen slot limits.
# Its estimates were 1 KiB per entry, 4 KiB per watch, 128 bytes per queued path and UTF-16 path bytes.
# One eighth of the configured MiB bound was available to each retained tree or change queue.
# These weights describe supported tree size, not the SQLite scanner's resident memory.
ENTRY_BYTES = 1024
DIRECTORY_BYTES = 4096
CHANGE_BYTES = 128
UTF16_UNIT_BYTES = 2
TREE_SHARE = 8


class Entry(NamedTuple):
    id: int
    parent: int
    root: int
    name: bytes
    identity: bytes
    born: int
    directory: bool
    length: int
    weight_bytes: int
    watch: int | None
    seen: int


class DiskIndex:
    def __init__(self, budget_mb):
        self.connection = open_index()
        self.supported_weight_bytes = budget_mb * 2**20 // TREE_SHARE
        self.entry_limit = self.supported_weight_bytes // ENTRY_BYTES
        self.count = 0
        self.weight_bytes = 0
        self.dirty_weight_bytes = 0
        self.bytes = 0
        self.generation = 0
        self.sequence = 0

    def find(self, parent, name):
        row = self.connection.execute("select * from entries where parent = ? and name = ?", (parent, name)).fetchone()
        return stored_entry(row)

    def get(self, identifier):
        return stored_entry(self.connection.execute("select * from entries where id = ?", (identifier,)).fetchone())

    def replace(self, previous, parent, name, snapshot, length, generation=0):
        weight_bytes = ENTRY_BYTES + UTF16_UNIT_BYTES * length + (DIRECTORY_BYTES if snapshot.directory else 0)
        if previous:
            self.uncharge(previous)
        if self.count >= self.entry_limit or self.weight_bytes + weight_bytes > self.supported_weight_bytes:
            raise AccountingError("job-tree", "Disk tree exceeds supported size. Remove disposable files and directories.")
        if previous:
            identifier = previous.id
            self.connection.execute(
                "update entries set identity=?, born=?, directory=?, weight_bytes=?, seen=? where id=?",
                (snapshot.identity, snapshot.born, snapshot.directory, weight_bytes, generation, identifier),
            )
        else:
            root = self.get(parent).root if parent else 0
            cursor = self.connection.execute(
                "insert into entries(parent,root,name,identity,born,directory,length,weight_bytes,seen) values (?,?,?,?,?,?,?,?,?)",
                (parent, root, name, snapshot.identity, snapshot.born, snapshot.directory, length, weight_bytes, generation),
            )
            identifier = cursor.lastrowid
            if not parent:
                self.connection.execute("update entries set root=? where id=?", (identifier, identifier))
        self.count += 1
        self.weight_bytes += weight_bytes
        self.charge(snapshot.identity, snapshot.allocated)
        return self.get(identifier)

    def charge(self, identity, allocated):
        previous = self.connection.execute("select bytes,links from identities where identity=?", (identity,)).fetchone()
        if previous:
            self.bytes += allocated - previous["bytes"]
            self.connection.execute("update identities set bytes=?,links=links+1 where identity=?", (allocated, identity))
        else:
            self.bytes += allocated
            self.connection.execute("insert into identities values (?,?,1)", (identity, allocated))

    def uncharge(self, entry):
        identity = self.connection.execute("select bytes,links from identities where identity=?", (entry.identity,)).fetchone()
        if identity["links"] == 1:
            self.bytes -= identity["bytes"]
            self.connection.execute("delete from identities where identity=?", (entry.identity,))
        else:
            self.connection.execute("update identities set links=links-1 where identity=?", (entry.identity,))
        self.count -= 1
        self.weight_bytes -= entry.weight_bytes

    def forget(self, entry):
        self.uncharge(entry)
        self.connection.execute("delete from entries where id=?", (entry.id,))
        dirty = self.connection.execute("select weight_bytes from dirty where id=?", (entry.id,)).fetchone()
        if dirty:
            self.dirty_weight_bytes -= dirty["weight_bytes"]
            self.connection.execute("delete from dirty where id=?", (entry.id,))

    def queue(self, identifier):
        if self.connection.execute("select 1 from dirty where id=?", (identifier,)).fetchone():
            return
        entry = self.get(identifier)
        if not entry:
            return
        weight_bytes = CHANGE_BYTES + UTF16_UNIT_BYTES * entry.length
        if self.dirty_weight_bytes + weight_bytes > self.supported_weight_bytes:
            raise AccountingError("job-tree", "Disk changes exceed supported size. Remove disposable files and directories.")
        self.sequence += 1
        self.connection.execute("insert into dirty values (?,?,?,?)", (identifier, entry.root, weight_bytes, self.sequence))
        self.dirty_weight_bytes += weight_bytes

    def invalidate_directories(self):
        # Lost filesystem notifications require a rescan of every directory.
        # Each directory costs less to queue than to retain, and both budgets have the same size.
        # The queue ignores duplicates, so all retained directories fit without raising the limit.
        for row in self.connection.execute("select id from entries where directory = 1"):
            self.queue(row["id"])

    def dirty_entries(self, root, through):
        after = 0
        while True:
            dirty = self.connection.execute(
                "select id,queued from dirty where root=? and queued>? and queued<=? order by queued limit 1",
                (root, after, through),
            ).fetchone()
            if dirty is None:
                return
            after = dirty["queued"]
            yield self.get(dirty["id"])

    def pop_dirty(self, root, through):
        dirty = self.connection.execute(
            "select id,weight_bytes from dirty where root=? and queued<=? order by queued limit 1", (root, through)
        ).fetchone()
        if not dirty:
            return None
        self.connection.execute("delete from dirty where id=?", (dirty["id"],))
        self.dirty_weight_bytes -= dirty["weight_bytes"]
        return self.get(dirty["id"])

    def watched(self, watch):
        return [Entry(*row) for row in self.connection.execute("select * from entries where watch=?", (watch,))]

    def watch_references(self, watch):
        return self.connection.execute("select count(*) from entries where watch=?", (watch,)).fetchone()[0]

    def set_watch(self, identifier, watch):
        self.connection.execute("update entries set watch=? where id=?", (watch, identifier))

    def children(self, identifier):
        after = 0
        while True:
            child = stored_entry(self.connection.execute(
                "select * from entries where parent=? and id>? order by id limit 1", (identifier, after)
            ).fetchone())
            if child is None:
                return
            after = child.id
            yield child

    def first_child(self, identifier):
        return stored_entry(self.connection.execute("select * from entries where parent=? limit 1", (identifier,)).fetchone())

    def unseen_child(self, identifier, generation):
        row = self.connection.execute(
            "select * from entries where parent=? and seen!=? limit 1", (identifier, generation)
        ).fetchone()
        return stored_entry(row)

    def close(self):
        self.connection.close()


def stored_entry(row):
    return Entry(*row) if row is not None else None


def open_index():
    # Only storage setup regains the worker uid. No slot paths are opened under that identity.
    slot_uid = os.geteuid()
    os.seteuid(os.getuid())
    try:
        with tempfile.TemporaryDirectory(prefix="disk-index-") as directory:
            path = os.path.join(directory, "index.sqlite")
            connection = sqlite3.connect(path, isolation_level=None)
            try:
                connection.row_factory = sqlite3.Row
                create_schema(connection)
                # The main file already exists in a worker-only directory. Journal-free writes keep its open fd.
                os.unlink(path)
                return connection
            except Exception:
                connection.close()
                raise
    except OSError as failure:
        raise AccountingError("worker-scanner", str(failure)) from failure
    finally:
        os.seteuid(slot_uid)


def create_schema(connection):
    connection.executescript("""
        pragma cache_size = -512;
        pragma mmap_size = 0;
        pragma temp_store = memory;
        pragma journal_mode = off;
        pragma synchronous = off;
        create table entries (
            id integer primary key autoincrement,
            parent integer not null, root integer not null, name blob not null,
            identity blob not null, born integer not null,
            directory integer not null, length integer not null,
            weight_bytes integer not null, watch integer, seen integer not null,
            unique(parent, name)
        );
        create index watches on entries(watch) where watch is not null;
        create index children on entries(parent, id);
        create table identities (identity blob primary key, bytes integer not null, links integer not null) without rowid;
        create table dirty (id integer primary key, root integer not null, weight_bytes integer not null, queued integer not null);
        create index dirty_roots on dirty(root, queued);
    """)
