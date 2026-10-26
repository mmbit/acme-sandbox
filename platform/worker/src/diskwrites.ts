// Command-specific regular-file writes, including files on memory-backed filesystems.
import { execFile } from 'node:child_process';
import type { Ids } from './slots.ts';
import type { ProcessSnapshot } from './shares.ts';
import type { DiskUse } from './disk.ts';

export type WritableFile = { inode: string; position: number; bytes: number };

export function writableFiles(pids: number[], ids: Required<Ids>): Promise<Map<number, WritableFile[]>> {
  if (!pids.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', SAMPLE_FILES, ...pids.map(String)],
      {
        ...ids,
        env: { PATH: '/usr/bin:/bin' },
        timeout: 10_000,
        killSignal: 'SIGKILL',
      },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(new Map(JSON.parse(stdout)));
      },
    );
  });
}

export async function sampleWrites(processes: ProcessSnapshot[], jobs: Required<Ids>[]) {
  await Promise.all(
    jobs.map(async ids => {
      const owned = processes.filter(process => process.uid === ids.uid);
      try {
        const files = await writableFiles(
          owned.map(process => process.pid),
          ids,
        );
        for (const process of owned) process.writableFiles = files.get(process.pid);
      } catch (failure) {
        for (const process of owned)
          process.diskAccountingError = `Disk accounting unavailable: writable-file sampling failed: ${failure}`;
      }
    }),
  );
  return processes;
}

// /proc descriptor links resolve under the slot's permissions, without reading any file's contents.
const SAMPLE_FILES = `
const fs = require('node:fs');
const snapshots = process.argv.slice(1).map(value => {
  const pid = Number(value), files = new Map();
  try {
    for (const descriptor of fs.readdirSync('/proc/' + pid + '/fd')) {
      try {
        const prefix = '/proc/' + pid;
        const fields = fs.readFileSync(prefix + '/fdinfo/' + descriptor, 'utf8');
        const flags = Number.parseInt(fields.match(/^flags:\\s+(\\d+)$/m)[1], 8);
        if (!(flags & 3)) continue;
        const stats = fs.statSync(prefix + '/fd/' + descriptor);
        if (!stats.isFile()) continue;
        const inode = stats.dev + ':' + stats.ino;
        const position = Number(fields.match(/^pos:\\s+(\\d+)$/m)[1]);
        const earlier = files.get(inode);
        files.set(inode, { inode, position: Math.max(position, earlier?.position ?? 0), bytes: stats.blocks * 512 });
      } catch (err) {
        if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(err.code)) throw err;
      }
    }
  } catch (err) {
    if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(err.code)) throw err;
  }
  return [pid, [...files.values()]];
});
process.stdout.write(JSON.stringify(snapshots));
`;

export function storedWrites(current: ProcessSnapshot, before: ProcessSnapshot | undefined, sharedFiles: Set<string>) {
  if (!current.writtenCallBytes) return 0;
  const previous = new Map(before?.writableFiles?.map(file => [file.inode, file]));
  const files = new Map(current.writableFiles?.map(file => [file.inode, file]));
  return [...files.values()].reduce((bytes, file) => {
    if (sharedFiles.has(file.inode)) return bytes;
    const earlier = previous.get(file.inode);
    return bytes + (earlier ? Math.max(0, Math.min(file.position - earlier.position, file.bytes - earlier.bytes)) : 0);
  }, 0);
}

export const diskWrites = (process: ProcessSnapshot, use: DiskUse) =>
  process.writtenBytes === undefined || process.writtenCallBytes === undefined
    ? undefined
    : use.grew
      ? process.writtenBytes || process.storedWriteBytes || 0
      : 0;

export function diskAccountingError(run: ProcessSnapshot[]) {
  const unavailable = run.find(process => process.writtenBytes === undefined || process.writtenCallBytes === undefined);
  return (
    run.find(process => process.diskAccountingError)?.diskAccountingError ??
    (unavailable
      ? `Disk accounting unavailable for process ${unavailable.pid}: cannot read its write counters`
      : undefined)
  );
}

// A shared file's offset or allocation can advance because another process wrote it.
export function sharedWritableFiles(now: ProcessSnapshot[], before: ProcessSnapshot[]) {
  const writers = new Map<string, Set<string>>();
  for (const process of [...before, ...now])
    for (const file of process.writableFiles ?? []) {
      const owners = writers.get(file.inode) ?? new Set<string>();
      owners.add(`${process.pid}:${process.start}`);
      writers.set(file.inode, owners);
    }
  return new Set([...writers].filter(([, owners]) => owners.size > 1).map(([inode]) => inode));
}
