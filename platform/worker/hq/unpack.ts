// A run's files (a gzipped tar from a helper) into the job's tree. GNU tar reads the archive, into an empty folder of
// its own; then only regular files and folders come in from there, each inside a path the run named with --bring, and
// never through a link already in the tree. The rest is left out and named. Nothing gets its owner or more than its
// executable bit from the tar.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';

type Entry = { path: string; kind: 'file' | 'folder' | 'other'; executable: boolean; size: number; source: string };

// Inflation needs room for zlib's chunks and its final buffer inside the worker's shared container. The files
// brought in are held to it too, as a sparse one could unpack to far more.
const UNPACKED_MAX_BYTES = 1024 * 2 ** 20;
// Bound the entry objects as well as the archive's bytes.
const ENTRIES_MAX = 100_000;

// What came in, and each entry left out with why
export function unpackInto(root: string, gzipped: Buffer, bring: string[]) {
  const tar = inflate(gzipped);
  countEntries(tar);
  const staging = mkdtempSync(`${tmpdir()}/hq-run-files-`);
  try {
    return placeAll(root, staging, extract(tar, staging), bring);
  } finally {
    // (a folder the tar locked would stop the removal)
    spawnSync('chmod', ['-R', 'u+rwx', staging]);
    rmSync(staging, { recursive: true, force: true });
  }
}

function placeAll(root: string, staging: string, refused: string[], bring: string[]) {
  const brought: string[] = [];
  const leftOut = refused;
  let room = UNPACKED_MAX_BYTES;
  for (const entry of entriesIn(staging, '')) {
    let problem = entryProblem(entry, bring);
    // (a folder on the way to one --bring named, made in the tree when a file in it comes in)
    if (problem && entry.kind === 'folder') continue;
    if (!problem && entry.size > room) problem = 'over the 1 GiB the files may hold unpacked';
    if (!problem) {
      try {
        problem = placeEntry(root, entry);
      } catch (error) {
        problem = (error as Error).message;
      }
    }
    if (problem) leftOut.push(`${entry.path}: ${problem}`);
    else {
      brought.push(entry.path);
      room -= entry.size;
    }
  }
  return { brought, leftOut };
}

function inflate(gzipped: Buffer) {
  try {
    return gunzipSync(gzipped, { maxOutputLength: UNPACKED_MAX_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
      throw new Error('the files are over 1 GiB unpacked: bring back less', { cause: error });
    throw error;
  }
}

// GNU tar's count of the archive's entries, held to ENTRIES_MAX. An archive it can't read brings nothing in.
function countEntries(tar: Buffer) {
  const listed = spawnSync('bash', ['-c', 'set -o pipefail; tar -tf - | wc -l'], { input: tar, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('the files came back damaged (not a tar GNU tar reads)');
  if (Number(listed.stdout.trim()) > ENTRIES_MAX)
    throw new Error('the files hold over 100,000 entries: bring back fewer');
}

// The archive unpacked in an empty folder, as the job's own user: GNU tar keeps every member inside it (no .. or
// absolute paths, no writing through a link it made). What it refused, as it says it.
function extract(tar: Buffer, staging: string) {
  const unpacked = spawnSync('tar', ['-xf', '-', '--no-same-owner', '--no-same-permissions', '-C', staging], {
    input: tar,
    encoding: 'utf8',
    maxBuffer: 16 * 2 ** 20,
  });
  if (unpacked.error) throw new Error(`the files didn't unpack: ${unpacked.error.message}`);
  spawnSync('chmod', ['-R', 'u+rwX', staging]);
  return unpacked.stderr
    .split('\n')
    .filter(line => line && !/Exiting with failure status/.test(line))
    .map(line => line.replace(/^tar: /, ''));
}

// What GNU tar made, folders before what's in them, never through a link
function* entriesIn(staging: string, folder: string): Generator<Entry> {
  for (const name of readdirSync(`${staging}/${folder}`).sort()) {
    const path = folder ? `${folder}/${name}` : name;
    const source = `${staging}/${path}`;
    const found = lstatSync(source);
    const kind = found.isFile() ? 'file' : found.isDirectory() ? 'folder' : 'other';
    yield { path, kind, executable: (found.mode & 0o100) !== 0, size: kind === 'file' ? found.size : 0, source };
    if (kind === 'folder') yield* entriesIn(staging, path);
  }
}

const entryProblem = (entry: Entry, bring: string[]) => {
  if (!bring.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) return 'not a path --bring named';
  if (entry.kind === 'other') return 'a link or special file';
  return '';
};

// The entry written in the tree, its folders made where missing: '', or why not, where the tree has a link or a file
function placeEntry(root: string, entry: Entry) {
  const parts = entry.path.split('/');
  const folders = entry.kind === 'folder' ? parts : parts.slice(0, -1);
  for (let depth = 1; depth <= folders.length; depth++) {
    const folder = `${root}/${folders.slice(0, depth).join('/')}`;
    const existing = lstatOrNull(folder);
    if (!existing) mkdirSync(folder, { mode: 0o755 });
    else if (!existing.isDirectory()) return `${folders.slice(0, depth).join('/')} in the tree is a link or a file`;
  }
  if (entry.kind === 'folder') return '';
  const existing = lstatOrNull(`${root}/${entry.path}`);
  if (existing && !existing.isFile()) return 'the tree has a link or a folder there';
  const destination = `${root}/${entry.path}`;
  // Replace the directory entry, never an existing inode that may also be linked outside --bring.
  const temporary = `${dirname(destination)}/.hq-run-${randomUUID()}`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = openSync(temporary, flags, 0o600);
  try {
    try {
      const body = readFileSync(entry.source);
      let written = 0;
      while (written < body.length) written += writeSync(handle, body, written);
      fchmodSync(handle, entry.executable ? 0o755 : 0o644);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return '';
}

const lstatOrNull = (path: string) => lstatSync(path, { throwIfNoEntry: false }) ?? null;
