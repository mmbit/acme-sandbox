// Incremental allocated use with every directory and watch anchored to a verified descriptor.
import { AccountingError, type AccountingFailureReason } from './accounting.ts';
import { constants, watch, type FSWatcher, type Stats } from 'node:fs';
import { open, lstat, opendir, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

type Entry = { inode: string; bytes: number; directory: boolean; born: number };
type Directory = { handle: FileHandle; parent: FileHandle; name: string; stats: Stats };
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// A root's ancestors (/work/jobs and the like, 0711: a slot may pass through, not list) are held with O_PATH, which
// needs no read permission: Node has no constant for it, Linux's value.
const pathFlags = 0o10000000 | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const descriptor = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const identity = (stats: Stats) => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;

// Short-path files measured about 680 heap bytes each. Allow 1 KiB plus the full UTF-16 path, and
// another 4 KiB per directory for its watch, open traversal frame and single buffered directory entry.
// Entries, queued changes and the drained change snapshot each get at most one eighth of the old space, where they
// live. The remaining five eighths cover runtime state, map resizing, temporary allocations and garbage collection.
export const PROBE_OLD_SPACE_MB = 2048; // V8's default on a 64-bit machine, set explicitly on the probe (diskscan.ts)
const treeBytes = (oldSpaceMb: number) => Math.floor((oldSpaceMb * 2 ** 20) / 8);
const entryBytes = 1024;
export const treeEntryLimit = (oldSpaceMb = PROBE_OLD_SPACE_MB) => Math.floor(treeBytes(oldSpaceMb) / entryBytes);
const pathBytes = (path: string) => 128 + 2 * path.length;
const retainedBytes = (path: string, entry: Entry) => entryBytes + 2 * path.length + (entry.directory ? 4096 : 0);
const treeLimit = () =>
  new AccountingError('job-tree', 'Disk tree exceeds scanner memory budget. Remove disposable files and directories.');

export class DiskTree {
  private entries = new Map<string, Entry>();
  private inodes = new Map<string, { bytes: number; links: number }>();
  private watchers = new Map<string, FSWatcher>();
  private dirty = new Set<string>();
  private failure?: Error;
  private bytes = 0;
  private entryHeapBytes = 0;
  private dirtyHeapBytes = 0;
  private roots: string[];
  private treeHeapBytes: number;
  private entryLimit: number;

  constructor(roots: string[], oldSpaceMb = PROBE_OLD_SPACE_MB) {
    this.roots = roots.map(root => resolve(root));
    this.treeHeapBytes = treeBytes(oldSpaceMb);
    this.entryLimit = treeEntryLimit(oldSpaceMb);
  }

  async measure() {
    try {
      if (this.failure) throw this.failure;
      const dirty = [...this.dirty].sort((a, b) => a.length - b.length);
      this.dirty.clear();
      this.dirtyHeapBytes = 0;
      for (const root of this.roots) await this.measureRoot(root, dirty);
      if (this.failure) throw this.failure;
      return this.bytes;
    } catch (failure) {
      this.close();
      throw failure;
    }
  }

  private async measureRoot(root: string, dirty: string[]) {
    const anchored = await anchor(root);
    if (!anchored) return this.remove(root);
    try {
      const directory = anchored.directories.at(-1)!;
      await this.refresh(directory.parent, directory.name, root, directory);
      for (const path of dirty)
        if (path.startsWith(root + sep) && this.entries.get(dirname(path))?.directory)
          await this.refreshPath(directory.handle, root, path);
      for (const ancestor of anchored.directories) {
        const now = await there(ancestor, ancestor === directory ? 'job-tree' : 'worker-ancestor');
        if (now === 'there') continue;
        if (ancestor !== directory)
          throw new AccountingError('worker-ancestor', `Disk directory ${now}: ${ancestor.name}`);
        this.remove(root);
      }
    } finally {
      await anchored.close();
    }
  }

  private async refreshPath(root: FileHandle, rootPath: string, path: string) {
    const names = path.slice(rootPath.length + 1).split(sep);
    const name = names.pop()!;
    const directories: (Directory & { path: string })[] = [];
    let parent = root;
    let parentPath = rootPath;
    try {
      for (const component of names) {
        parentPath = join(parentPath, component);
        const handle = await openDirectory(parent, component);
        if (!handle) return this.remove(parentPath);
        const stats = await handle.stat();
        const directory = { handle, parent, name: component, stats, path: parentPath };
        directories.push(directory);
        const previous = this.entries.get(parentPath)!;
        if (previous.inode !== `${stats.dev}:${stats.ino}` || previous.born !== stats.birthtimeMs)
          return this.again(parentPath);
        parent = handle;
      }
      await this.refresh(parent, name, path);
      for (const directory of directories) {
        const now = await there(directory);
        if (now !== 'there') return now === 'gone' ? this.remove(directory.path) : this.again(directory.path);
      }
    } finally {
      for (const directory of directories.reverse()) await directory.handle.close();
    }
  }

  private async refresh(parent: FileHandle, name: string, path: string, anchored?: Directory) {
    if (this.failure) throw this.failure;
    const stats = anchored?.stats ?? (await present(join(descriptor(parent), name)));
    if (!stats) return this.remove(path);
    const previous = this.entries.get(path);
    const entry = {
      inode: `${stats.dev}:${stats.ino}`,
      bytes: stats.blocks * 512,
      directory: stats.isDirectory(),
      born: stats.birthtimeMs,
    };
    const changed = previous?.inode !== entry.inode || previous?.born !== entry.born;
    if (previous?.directory && (!entry.directory || changed)) this.remove(path);
    this.replace(path, entry);
    if (!entry.directory) return;
    const handle = anchored?.handle ?? (await openDirectory(parent, name));
    if (!handle) return this.remove(path);
    try {
      const opened = await handle.stat();
      if (identity(stats) !== identity(opened)) return this.again(path);
      if (!previous?.directory || changed) {
        this.watchDirectory(path, handle);
        for await (const child of children(handle)) await this.refresh(handle, child, join(path, child));
      }
      const now = await there({ handle, parent, name, stats });
      if (now === 'gone') this.remove(path);
      else if (now === 'swapped') this.again(path);
    } finally {
      if (!anchored) await handle.close();
    }
  }

  private watchDirectory(directory: string, handle: FileHandle) {
    const watcher = watch(descriptor(handle), (_event, name) => {
      if (this.failure) return;
      if (name === null) this.failure = new Error(`Disk changes lost for ${directory}`);
      else {
        this.queue(join(directory, String(name)));
        this.queue(directory);
      }
    });
    watcher.on('error', failure => {
      this.failure = failure;
    });
    this.watchers.set(directory, watcher);
  }

  private queue(path: string) {
    if (this.failure || this.dirty.has(path)) return;
    const bytes = pathBytes(path);
    if (this.dirtyHeapBytes + bytes > this.treeHeapBytes) {
      this.failure = treeLimit();
      return;
    }
    this.dirty.add(path);
    this.dirtyHeapBytes += bytes;
  }

  private replace(path: string, entry: Entry) {
    this.drop(path);
    const bytes = retainedBytes(path, entry);
    if (this.entries.size >= this.entryLimit || this.entryHeapBytes + bytes > this.treeHeapBytes) throw treeLimit();
    this.entries.set(path, entry);
    this.entryHeapBytes += bytes;
    const inode = this.inodes.get(entry.inode);
    if (inode) {
      this.bytes += entry.bytes - inode.bytes;
      inode.bytes = entry.bytes;
      inode.links++;
    } else {
      this.inodes.set(entry.inode, { bytes: entry.bytes, links: 1 });
      this.bytes += entry.bytes;
    }
  }

  private drop(path: string) {
    const entry = this.entries.get(path);
    if (!entry) return;
    const inode = this.inodes.get(entry.inode)!;
    if (--inode.links === 0) {
      this.bytes -= inode.bytes;
      this.inodes.delete(entry.inode);
    }
    this.entries.delete(path);
    this.entryHeapBytes -= retainedBytes(path, entry);
  }

  // Another directory at a walked one's name: what was walked may be the one moved away, so it is dropped, and the
  // next look walks what stands there then. A job's tests swap folders all the time (git's refs, a fixture renamed
  // into place); the descriptors already kept the walk inside the tree, so a swap is no reason to stop accounting.
  private again(path: string) {
    this.remove(path);
    this.queue(path);
  }

  private remove(path: string) {
    if (!this.entries.get(path)?.directory) return this.drop(path);
    for (const [directory, watcher] of this.watchers)
      if (directory === path || directory.startsWith(path + sep)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    for (const name of this.entries.keys()) if (name === path || name.startsWith(path + sep)) this.drop(name);
  }

  close() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.entries.clear();
    this.inodes.clear();
    this.dirty.clear();
    this.bytes = 0;
    this.entryHeapBytes = 0;
    this.dirtyHeapBytes = 0;
    this.failure = undefined;
  }
}

async function anchor(path: string) {
  const base = await open(sep, pathFlags).catch(failure => {
    throw new AccountingError('worker-ancestor', String(failure));
  });
  const directories: Directory[] = [];
  const close = async () => {
    for (const directory of [...directories].reverse()) await directory.handle.close();
    await base.close();
  };
  let parent = base;
  let reason: AccountingFailureReason = 'worker-ancestor';
  try {
    const names = path.split(sep).filter(Boolean);
    for (const [i, name] of names.entries()) {
      reason = i < names.length - 1 ? 'worker-ancestor' : 'job-tree';
      const handle = await open(join(descriptor(parent), name), i < names.length - 1 ? pathFlags : directoryFlags);
      directories.push({ handle, parent, name, stats: await handle.stat() });
      parent = handle;
    }
    return { directories, close };
  } catch (failure) {
    await close();
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AccountingError(reason, String(failure));
  }
}

// Whether a walked directory is still at its name: one deleted during its walk (a job's temporary folders come and go
// all the time) is gone, another directory at its name a swap. (swapped)
async function there(
  directory: Directory,
  reason: AccountingFailureReason = 'job-tree',
): Promise<'there' | 'gone' | 'swapped'> {
  try {
    const current = await present(join(descriptor(directory.parent), directory.name));
    if (!current) return 'gone';
    return identity(current) === identity(directory.stats) ? 'there' : 'swapped';
  } catch (failure) {
    throw new AccountingError(reason, String(failure));
  }
}

// A directory gone from its name between its lstat and its open is undefined, as present() has it.
async function openDirectory(parent: FileHandle, name: string) {
  try {
    return await open(join(descriptor(parent), name), directoryFlags);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw failure;
  }
}

// A directory's names. Linux lists a deleted directory as ENOENT, which ends its listing: there() then tells gone
// from swapped.
async function* children(handle: FileHandle) {
  try {
    for await (const child of await opendir(descriptor(handle), { bufferSize: 1 })) yield child.name;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
  }
}

async function present(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw failure;
  }
}
