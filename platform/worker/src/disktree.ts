// Incremental allocated use with every directory and watch anchored to a verified descriptor.
import { constants, watch, type FSWatcher, type Stats } from 'node:fs';
import { open, lstat, readdir, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

type Entry = { inode: string; bytes: number; directory: boolean; born: number };
type Directory = { handle: FileHandle; parent: FileHandle; name: string; stats: Stats };
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// A root's ancestors (/work/jobs and the like, 0711: a slot may pass through, not list) are held with O_PATH, which
// needs no read permission: Node has no constant for it, Linux's value.
const pathFlags = 0o10000000 | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const descriptor = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const identity = (stats: Stats) => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;

export class DiskTree {
  private entries = new Map<string, Entry>();
  private inodes = new Map<string, { bytes: number; links: number }>();
  private watchers = new Map<string, FSWatcher>();
  private dirty = new Set<string>();
  private failure?: Error;
  private bytes = 0;
  private roots: string[];

  constructor(roots: string[]) {
    this.roots = roots.map(root => resolve(root));
  }

  async measure() {
    try {
      if (this.failure) throw this.failure;
      const dirty = [...this.dirty].sort((a, b) => a.length - b.length);
      this.dirty.clear();
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
      for (const directory of anchored.directories) await unchanged(directory);
    } finally {
      await anchored.close();
    }
  }

  private async refreshPath(root: FileHandle, rootPath: string, path: string) {
    const names = path.slice(rootPath.length + 1).split(sep);
    const name = names.pop()!;
    const directories: Directory[] = [];
    let parent = root;
    let parentPath = rootPath;
    try {
      for (const component of names) {
        const handle = await open(join(descriptor(parent), component), directoryFlags);
        const stats = await handle.stat();
        const directory = { handle, parent, name: component, stats };
        directories.push(directory);
        parentPath = join(parentPath, component);
        const previous = this.entries.get(parentPath)!;
        if (previous.inode !== `${stats.dev}:${stats.ino}` || previous.born !== stats.birthtimeMs)
          throw new Error(`Disk directory replaced during scan: ${parentPath}`);
        parent = handle;
      }
      await this.refresh(parent, name, path);
      for (const directory of directories) await unchanged(directory);
    } finally {
      for (const directory of directories.reverse()) await directory.handle.close();
    }
  }

  private async refresh(parent: FileHandle, name: string, path: string, anchored?: Directory) {
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
    const handle = anchored?.handle ?? (await open(join(descriptor(parent), name), directoryFlags));
    try {
      const opened = await handle.stat();
      if (identity(stats) !== identity(opened)) throw new Error(`Disk directory replaced during scan: ${path}`);
      if (!previous?.directory || changed) {
        this.watchDirectory(path, handle);
        for (const child of await readdir(descriptor(handle))) await this.refresh(handle, child, join(path, child));
      }
      await unchanged({ handle, parent, name, stats });
    } finally {
      if (!anchored) await handle.close();
    }
  }

  private watchDirectory(directory: string, handle: FileHandle) {
    const watcher = watch(descriptor(handle), (_event, name) => {
      if (name === null) this.failure = new Error(`Disk changes lost for ${directory}`);
      else {
        this.dirty.add(join(directory, String(name)));
        this.dirty.add(directory);
      }
    });
    watcher.on('error', failure => {
      this.failure = failure;
    });
    this.watchers.set(directory, watcher);
  }

  private replace(path: string, entry: Entry) {
    this.drop(path);
    this.entries.set(path, entry);
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
    this.failure = undefined;
  }
}

async function anchor(path: string) {
  const base = await open(sep, pathFlags);
  const directories: Directory[] = [];
  const close = async () => {
    for (const directory of [...directories].reverse()) await directory.handle.close();
    await base.close();
  };
  let parent = base;
  try {
    const names = path.split(sep).filter(Boolean);
    for (const [i, name] of names.entries()) {
      const handle = await open(join(descriptor(parent), name), i < names.length - 1 ? pathFlags : directoryFlags);
      directories.push({ handle, parent, name, stats: await handle.stat() });
      parent = handle;
    }
    return { directories, close };
  } catch (failure) {
    await close();
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw failure;
  }
}

async function unchanged(directory: Directory) {
  const current = await present(join(descriptor(directory.parent), directory.name));
  if (!current || identity(current) !== identity(directory.stats))
    throw new Error(`Disk directory replaced during scan: ${directory.name}`);
}

async function present(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw failure;
  }
}
