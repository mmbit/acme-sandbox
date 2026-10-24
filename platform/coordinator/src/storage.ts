// Room on the data disk (DATA_DIR, which also holds the database) for what a request is about to write, for whatever
// outside input writes files there: mail's attachments, the desk phone's documents, review notes' screenshots.
import { statfsSync } from 'node:fs';
import { DATA_DIR } from './config.ts';

// The disk keeps FLOOR.bytes free, and the same share of its inodes, so the database can always grow. A filesystem that
// counts no inodes (btrfs) has no such bound. 5 GB: the deploy keeps 10 GB free for its builds (infra/sync.sh), so a
// floor of 10 refused a note's screenshot whenever a build was under way.
export const FLOOR = { bytes: 5 * 1024 ** 3 };
// files: each file's bytes; folders: the new folders they go in; bytes: what goes into the database
export type Writes = { files: number[]; folders?: number; bytes?: number };
// Writes admitted but not on the disk yet (reserve): every check counts them as taken, so two requests that write across
// an await can't both spend the same room.
const pending = { bytes: 0, inodes: 0 };

export function room(writes: Writes) {
  const { bavail, bsize, blocks, ffree, files: inodes } = statfsSync(DATA_DIR);
  const kept = (inodes * FLOOR.bytes) / (blocks * bsize);
  const free = bavail * bsize - pending.bytes - taken(writes, bsize);
  return free >= FLOOR.bytes && (!inodes || ffree - pending.inodes - made(writes) >= kept);
}

// Holds the writes' room until they're on the disk: each file or folder gives its share back as it lands there (the disk
// counts it from then on), and release gives back the rest, written or not.
export function reserve(writes: Writes) {
  const { bsize } = statfsSync(DATA_DIR);
  const held = { bytes: taken(writes, bsize), inodes: made(writes) };
  const give = (bytes: number, inodes: number) => {
    held.bytes -= bytes;
    held.inodes -= inodes;
    pending.bytes -= bytes;
    pending.inodes -= inodes;
  };
  pending.bytes += held.bytes;
  pending.inodes += held.inodes;
  return {
    landed: (size: number | null) => give(size === null ? bsize : blocksOf(size, bsize), 1), // (null: a folder)
    release: () => give(held.bytes, held.inodes),
  };
}

// What a quota of bytes charges for the writes: what they take on the disk, and for each file and folder its share of
// the disk's inodes in bytes (its size over its inodes). So a quota bounds the inodes a writer takes in the same
// proportion as its bytes, however small its files.
export function charged(writes: Writes, disk = shape()) {
  return taken(writes, disk.bsize) + made(writes) * disk.perInode;
}
// The disk's block size, and its bytes per inode (none on a filesystem that counts no inodes)
export function shape() {
  const { bsize, blocks, files: inodes } = statfsSync(DATA_DIR);
  return { bsize, perInode: inodes ? (blocks * bsize) / inodes : 0 };
}

// What the writes take on the disk: a file's bytes rounded up to whole blocks, and a block a folder
const taken = (writes: Writes, bsize: number) =>
  writes.files.reduce((n, size) => n + blocksOf(size, bsize), 0) + (writes.folders ?? 0) * bsize + (writes.bytes ?? 0);
const made = (writes: Writes) => writes.files.length + (writes.folders ?? 0);
const blocksOf = (size: number, bsize: number) => Math.ceil(size / bsize) * bsize;
