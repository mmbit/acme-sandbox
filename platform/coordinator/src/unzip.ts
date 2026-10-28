// Reading a zip one entry at a time: its central directory first (zip64 too), then each entry's bytes as a stream, so
// an import decides what it keeps before anything reaches the disk. Stored and deflated entries only, as the common zip
// tools write them. Anything else is a ZipError for the caller to report.
import { createReadStream, createWriteStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';

export class ZipError extends Error {}

export type ZipEntry = {
  name: string; // with forward slashes, as the zip has it (a folder's ends in /)
  folder: boolean;
  link: boolean; // a symbolic link, from a Unix zip tool
  encrypted: boolean;
  method: number; // 0: stored, 8: deflated
  crc: number;
  compressedSize: number;
  size: number;
  offset: number; // of its local header
};

const END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const END_BYTES = 22;
const MAX_COMMENT = 0xffff;
const MASKED = 0xffffffff; // a 32-bit field whose value is in the zip64 extra field
const UNIX = 3; // "version made by" host: its external attributes carry a Unix mode
const LINK_MODE = 0o120000;
// Far more than any real zip's directory needs (about 100 bytes a file), and little enough to read into memory
const MAX_DIRECTORY = 256 * 1024 * 1024;

// Whether the file starts as a zip does: with a file's local header, or the end record of an empty zip
export async function isZip(path: string) {
  const file = await open(path);
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await file.read(head, 0, 4, 0);
    return bytesRead === 4 && [LOCAL, END].includes(head.readUInt32LE(0));
  } finally {
    await file.close();
  }
}

export async function listEntries(path: string): Promise<ZipEntry[]> {
  const file = await open(path);
  try {
    const { offset, size, count } = await findDirectory(file);
    return parseDirectory(await readAt(file, offset, size), count);
  } finally {
    await file.close();
  }
}

// The central directory's place and length, from the end record at the end of the file (after an archive comment of up
// to 64 KB), or from the zip64 end record it points to when the zip is too big for 32 bits.
async function findDirectory(file: FileHandle) {
  const fileSize = (await file.stat()).size;
  const tailStart = Math.max(0, fileSize - END_BYTES - MAX_COMMENT);
  const tail = await readAt(file, tailStart, fileSize - tailStart);
  let end = tail.length - END_BYTES;
  while (end >= 0 && tail.readUInt32LE(end) !== END) end--;
  if (end < 0) throw new ZipError("it isn't a zip file");
  const locator = end - 20;
  const directory =
    locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR
      ? await zip64Directory(file, Number(tail.readBigUInt64LE(locator + 8)), tailStart + locator)
      : { count: tail.readUInt16LE(end + 10), size: tail.readUInt32LE(end + 12), offset: tail.readUInt32LE(end + 16) };
  return checkedDirectory(directory, fileSize);
}

async function zip64Directory(file: FileHandle, at: number, locatorAt: number) {
  if (at + 56 > locatorAt) throw new ZipError('its directory is damaged');
  const zip64 = await readAt(file, at, 56);
  if (zip64.readUInt32LE(0) !== ZIP64_END) throw new ZipError('its directory is damaged');
  const count = Number(zip64.readBigUInt64LE(32));
  return { count, size: Number(zip64.readBigUInt64LE(40)), offset: Number(zip64.readBigUInt64LE(48)) };
}

// A directory that fits in the file, and in memory. A damaged end record can declare any length, and reading that
// much would take the server down with it.
function checkedDirectory(directory: { count: number; size: number; offset: number }, fileSize: number) {
  const { count, size, offset } = directory;
  const fits = offset + size <= fileSize && size <= MAX_DIRECTORY && count * 46 <= size;
  if (!fits) throw new ZipError('its directory is damaged');
  return directory;
}

function parseDirectory(directory: Buffer, count: number) {
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL)
      throw new ZipError('its directory is damaged');
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const flags = directory.readUInt16LE(at + 8);
    const rawName = directory.subarray(at + 46, at + 46 + nameLength);
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    const sizes = zip64Sizes(extra, {
      size: directory.readUInt32LE(at + 24),
      compressedSize: directory.readUInt32LE(at + 20),
      offset: directory.readUInt32LE(at + 42),
    });
    const host = directory.readUInt16LE(at + 4) >> 8;
    const mode = host === UNIX ? directory.readUInt32LE(at + 38) >>> 16 : 0;
    const name = decodeName(rawName, flags);
    entries.push({
      name,
      folder: name.endsWith('/'),
      link: (mode & 0o170000) === LINK_MODE,
      encrypted: (flags & 1) === 1,
      method: directory.readUInt16LE(at + 10),
      crc: directory.readUInt32LE(at + 16),
      ...sizes,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// The zip64 extra field (id 1) holds, in this order, each of these whose 32-bit field is all ones.
function zip64Sizes(extra: Buffer, sizes: { size: number; compressedSize: number; offset: number }) {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 1) {
      let field = at + 4;
      for (const key of ['size', 'compressedSize', 'offset'] as const) {
        if (sizes[key] !== MASKED) continue;
        sizes[key] = Number(extra.readBigUInt64LE(field));
        field += 8;
      }
    }
    at += 4 + length;
  }
  return sizes;
}

// UTF-8 when the zip says so (flag bit 11) or when the bytes are valid UTF-8 anyway (macOS doesn't set it). Latin-1
// otherwise. Windows' backslashes become slashes.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
function decodeName(raw: Buffer, flags: number) {
  let name: string;
  try {
    name = flags & 0x800 ? raw.toString('utf8') : strictUtf8.decode(raw);
  } catch {
    name = raw.toString('latin1');
  }
  return name.replaceAll('\\', '/');
}

// One entry's bytes into a new file at `to`, checked against its size and CRC as they're written.
export async function extract(path: string, entry: ZipEntry, to: string) {
  if (entry.method !== 0 && entry.method !== 8)
    throw new ZipError(`${entry.name} uses a compression this server can't unpack`);
  const file = await open(path);
  let start: number;
  try {
    const header = await readAt(file, entry.offset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new ZipError(`${entry.name} is damaged`);
    start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await file.close();
  }
  const output = createWriteStream(to, { flags: 'wx', mode: 0o644 });
  if (!entry.compressedSize) {
    await new Promise<void>((resolve, reject) => output.end(() => resolve()).on('error', reject));
    if (entry.size) throw new ZipError(`${entry.name} is damaged`);
    return;
  }
  const input = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  const check = checker(entry);
  await (entry.method === 8 ? pipeline(input, createInflateRaw(), check, output) : pipeline(input, check, output));
  check.verify();
}

// Counts and sums the bytes going past, refusing more than the directory promised (a zip bomb stops there).
function checker(entry: ZipEntry) {
  let crc = 0;
  let size = 0;
  const damaged = () => new ZipError(`${entry.name} is damaged`);
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > entry.size) return done(damaged());
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
  });
  return Object.assign(stream, {
    verify() {
      if (size !== entry.size || crc !== entry.crc) throw damaged();
    },
  });
}

async function readAt(file: FileHandle, position: number, length: number) {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  if (bytesRead < length) throw new ZipError('it ends too early: the upload may be cut short');
  return bytes;
}
