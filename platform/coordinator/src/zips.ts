// Zip fields on desk-phone requests: the board sends a big zip in chunks, and the coordinator unpacks what's worth
// keeping into a folder of its own in IMPORTS_DIR, read-only for jobs. knowledge/notes/platform/desk-phone-zips.md has
// what's left out, the room it may take and how long things stay.
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { db } from './db.ts';
import { IMPORTS_DIR, IMPORTS_MAX_GB, IMPORTS_MIN_FREE_GB } from './config.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { reply } from './uploads.ts';
import * as photos from './photos.ts';
import * as unzip from './unzip.ts';

export const INCOMING = `${IMPORTS_DIR}/.incoming`;
const IMPORT_NOTE = '_import.md';
// The most a chunk may be. HQ sends 8 MB at a time, so a dropped line costs at most that.
const CHUNK_BYTES = 16 * 1024 * 1024;
export const ROOM = { maxStored: IMPORTS_MAX_GB * 1024 ** 3, minFree: IMPORTS_MIN_FREE_GB * 1024 ** 3 };
// The browser gives up after 10 minutes without an answer: an upload quiet for longer has been left, and its
// reservation lapses. Its next chunk, if one comes, checks the room for the rest again.
const UPLOAD_IDLE_MS = 15 * 60_000;
mkdirSync(INCOMING, { recursive: true, mode: 0o700 });

type FieldState = 'uploading' | 'importing' | 'imported' | 'failed';
// file: the browser's key for the picked file (its name, size and time), so only the same file resumes an upload
type Upload = { name: string; size: number; file: string };
type Tally = { files: number; bytes: number };
type Imported = { folder: string; folders: number; files: number; bytes: number; leftOut: Tally };
export type Field = {
  label: string;
  optional?: true;
  state?: FieldState;
  upload?: Upload;
  imported?: Imported;
  error?: string;
};

// ---------------------------------------------------------------- the fields
// A request's zip fields from what the agent sent: labels as for photo fields.
// (labels only: no photo's shot on a zip)
export const parseFields: (v: unknown) => Field[] | null | undefined = photos.parseLabels;

const fieldsOf = (json: string | null) => photos.fieldsOf<Field>(json);
const zipOf = (id: number, i: number) => `${INCOMING}/${id}-${i}.zip`;
const unpackingOf = (id: number, i: number) => `${INCOMING}/${id}-${i}.unpacking`;
const received = (id: number, i: number) => (existsSync(zipOf(id, i)) ? statSync(zipOf(id, i)).size : 0);
const save = (id: number, fields: Field[]) =>
  db.prepare('update requests set zips = ? where id = ?').run(JSON.stringify(fields), id);

// What the desk phone shows: each field, its file, and how far it is.
export const state = (id: number, json: string | null) =>
  fieldsOf(json).map((f, i) => ({
    label: f.label,
    optional: !!f.optional,
    state: f.state ?? null,
    name: f.upload?.name ?? null,
    size: f.upload?.size ?? null,
    received: f.state === 'uploading' ? received(id, i) : null,
    imported: f.imported ?? null,
    error: f.error ?? null,
  }));

// An open request with that zip field: its fields and the field's index, or an HTTP status.
function openField(id: number, field: string | null) {
  const row =
    Number.isInteger(id) && id > 0
      ? (db.prepare('select status, zips from requests where id = ?').get(id) as
          { status: string; zips: string | null } | undefined)
      : undefined;
  if (!row?.zips) return 404;
  if (row.status !== 'open') return 409;
  const fields = fieldsOf(row.zips);
  const i = /^\d$/.test(field ?? '') ? Number(field) : -1;
  if (i < 0 || i >= fields.length) return 400;
  return { fields, i };
}

// ---------------------------------------------------------------- the board's upload (HQ session, HQ's own Origin)
// GET /api/requests/zip?id=&field=: the field as the desk phone shows it, polled while the zip is unpacked.
export function show(req: IncomingMessage, res: ServerResponse) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const field = getField(Number(q.get('id')), q.get('field'));
  if (typeof field === 'number') return reply(res, field, { error: 'no such zip field on an open request' });
  return reply(res, 200, field);
}

export function getField(id: number, field: string | null) {
  const open = openField(id, field);
  if (typeof open === 'number') return open;
  const row = db.prepare('select zips from requests where id = ?').get(id) as { zips: string };
  return state(id, row.zips)[open.i];
}

// POST /api/requests/zip?id=&field=&name=&size=&file=&offset=, a chunk of the file as the body. A chunk at the
// offset the server has appends. Any other offset is answered 416 with the bytes received, and the browser goes on
// from there (0 for another file: it starts over). Offset 0 of a new file replaces what the field had. The last chunk
// starts the import.
export async function upload(req: IncomingMessage, res: ServerResponse) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const id = Number(q.get('id'));
  const fail = async (code: number, error: string) => {
    await reply(res, code, { error }, true);
    req.destroy();
  };
  const refusal = refused(openField(id, q.get('field')));
  if (refusal) return fail(refusal.code, refusal.error);
  const zipBytes = Number(q.get('size'));
  const offset = Number(q.get('offset'));
  const file = q.get('file') ?? '';
  const name = (q.get('name') ?? '').trim().slice(0, 200) || 'upload.zip';
  if (!(zipBytes > 0) || !Number.isSafeInteger(zipBytes) || !Number.isSafeInteger(offset) || offset < 0 || !file)
    return fail(400, 'needs the size, the offset and the file');
  const chunk = await readBody(req, CHUNK_BYTES).catch(() => undefined);
  if (chunk === undefined) return; // the line dropped mid-chunk: nothing appended, and nobody to answer
  if (!chunk) return fail(413, 'a chunk is 16 MB at most');
  if (offset + chunk.length > zipBytes) return reply(res, 400, { error: 'that chunk goes past the end of the file' });
  // From here to the reply nothing waits, so two chunks can't both append at the same offset.
  const open = openField(id, q.get('field'));
  const again = refused(open);
  if (again) return reply(res, again.code, { error: again.error });
  const { fields, i } = open as { fields: Field[]; i: number };
  const field = fields[i];
  const sameFile = field.upload?.file === file && field.upload.size === zipBytes;
  const end = offset + chunk.length;
  // the last chunk again, its answer lost on the way: it's in, and the browser goes on to wait for the unpacking
  const lastAgain = sameFile && end === zipBytes && (field.state === 'importing' || field.state === 'imported');
  if (lastAgain) return reply(res, 200, { received: zipBytes, state: field.state });
  if (field.state === 'importing') return reply(res, 409, { error: 'the last file is still being unpacked' });
  const have = sameFile && field.state === 'uploading' ? received(id, i) : 0;
  if (offset !== have) return reply(res, 416, { error: 'go on from the bytes received', received: have });
  const reservationId = reservationKey(id, i);
  const toReceive = zipBytes - offset;
  const fits =
    offset === 0 || !reserved.has(reservationId) ? room(reservationId, toReceive) : diskKeeps(reservationId, toReceive);
  if (!fits) return reply(res, 507, { error: 'the server has no room for a zip that big' });
  if (offset === 0) {
    clearField(id, i, field);
    Object.assign(field, { state: 'uploading', upload: { name, size: zipBytes, file } });
    save(id, fields); // the earlier folder is gone even if this chunk can't be written
  }
  appendFileSync(zipOf(id, i), chunk, { mode: 0o600 });
  const done = end === zipBytes;
  if (done) {
    field.state = 'importing';
    reserved.delete(reservationId);
  } else {
    reserved.set(reservationId, { bytes: zipBytes - end, until: Date.now() + UPLOAD_IDLE_MS });
  }
  save(id, fields);
  if (done) startImport(id, i);
  return reply(res, 200, { received: end, state: field.state });
}

function refused(open: ReturnType<typeof openField>) {
  if (open === 404) return { code: 404, error: 'no such request with zip fields' };
  if (open === 409) return { code: 409, error: 'that request is already answered' };
  if (open === 400) return { code: 400, error: 'no such zip field' };
  return null;
}

// A field starting over: its zip, a half-unpacked folder and the folder an earlier file of it became all go.
function clearField(id: number, i: number, field: Field) {
  rmSync(zipOf(id, i), { force: true });
  rmSync(unpackingOf(id, i), { recursive: true, force: true });
  if (field.imported) rmSync(field.imported.folder, { recursive: true, force: true });
  for (const key of ['state', 'upload', 'imported', 'error'] as const) delete field[key];
}

// ---------------------------------------------------------------- room
// Bytes promised but not on disk yet, by field: what an upload has still to receive (until it lapses), and what an
// import has still to write (until it ends).
type Reservation = { bytes: number; until: number };
const reserved = new Map<string, Reservation>();
const reservationKey = (id: number, i: number) => `${id}-${i}`;

// Whether `bytes` more fit for a field, besides what the others reserved: under ROOM.maxStored for everything in
// IMPORTS_DIR, with ROOM.minFree left on the disk.
function room(reservationId: string, bytes: number) {
  const stored = storedBytes(IMPORTS_DIR) + reservedBesides(reservationId) + bytes;
  return stored <= ROOM.maxStored && diskKeeps(reservationId, bytes);
}
function diskKeeps(reservationId: string, bytes: number) {
  const { bavail, bsize } = statfsSync(IMPORTS_DIR);
  return bavail * bsize - reservedBesides(reservationId) - bytes >= ROOM.minFree;
}
function reservedBesides(reservationId: string) {
  let bytes = 0;
  for (const [key, reservation] of reserved) {
    if (reservation.until < Date.now()) reserved.delete(key);
    else if (key !== reservationId) bytes += reservation.bytes;
  }
  return bytes;
}
// What the disk gives the files, in whole blocks: thousands of tiny files take far more than their bytes.
function storedBytes(path: string): number {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    bytes += entry.isDirectory() ? storedBytes(child) : lstatSync(child).blocks * 512;
  }
  return bytes;
}
// A file of `bytes` on the disk, rounded up to its blocks
function onDisk(bytes: number) {
  const { bsize } = statfsSync(IMPORTS_DIR);
  return Math.ceil(bytes / bsize) * bsize;
}

// ---------------------------------------------------------------- the import
class ImportError extends Error {}

type Reason =
  'dependencies' | 'build output' | 'caches' | 'version history' | 'system files' | 'keys' | 'unusable names';
type Kept = { parts: string[]; entry: unzip.ZipEntry };
type Plan = { kept: Kept[]; leftOut: Map<Reason, Tally>; wrapper: string | null };

// What's left out, by a folder anywhere on a file's path or by the file's own name.
// prettier-ignore
const LEFT_OUT_FOLDERS: [Reason, string][] = [
  ['dependencies', 'node_modules bower_components jspm_packages .pnpm-store .yarn .venv venv site-packages Pods'],
  ['caches', '.cache .next .nuxt .svelte-kit .turbo .parcel-cache .vite .angular .expo .gradle .dart_tool __pycache__ .pytest_cache .mypy_cache .ruff_cache .tox'],
  ['build output', 'dist build out .output coverage .vercel .netlify storybook-static'],
  ['version history', '.git .hg .svn'],
  ['system files', '__MACOSX .Spotlight-V100 .Trashes .fseventsd'],
];
const FOLDERS = new Map(
  LEFT_OUT_FOLDERS.flatMap(([reason, names]) => names.split(' ').map(name => [name, reason] as const)),
);
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.eslintcache']);
// Not *.key: that's a Keynote deck as often as a key
// prettier-ignore
const KEY_FILE = new RegExp([
  /\.env(\.(?!example$|sample$|template$|defaults$)[^/]+)?/,
  /\.npmrc|\.netrc|\.pgpass|\.htpasswd|id_(rsa|dsa|ed25519|ecdsa)/,
  /credentials(\.json)?|service[-_]?account.*\.json|client_secret.*\.json/,
  /.+\.(pem|p12|pfx|jks|keystore)/,
].map(r => `^(${r.source})$`).join('|'), 'i');
// Build output keeps these: a trailer rendered into out/, its sound
const MEDIA = /\.(mp4|m4v|mov|webm|mkv|avi|mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i;

function leftOutFor(parts: string[]): Reason | null {
  const file = parts[parts.length - 1];
  if (SYSTEM_FILES.has(file) || file.startsWith('._')) return 'system files';
  if (KEY_FILE.test(file)) return 'keys';
  for (const folder of parts.slice(0, -1)) {
    const reason = FOLDERS.get(folder);
    if (reason === 'build output' && MEDIA.test(file)) continue;
    if (reason) return reason;
  }
  return null;
}

// A path's parts, or null for one that could land outside the folder or that no file system takes.
// eslint-disable-next-line no-control-regex -- control characters make no file name worth keeping
const CONTROL = /[\u0000-\u001f]/;
function safeParts(name: string) {
  const parts = name.split('/').filter(p => p && p !== '.');
  const usable =
    parts.length > 0 &&
    !name.startsWith('/') &&
    parts.every(p => p !== '..' && !CONTROL.test(p) && Buffer.byteLength(p) <= 255);
  return usable ? parts : null;
}

function planImport(entries: unzip.ZipEntry[]): Plan {
  const kept: Kept[] = [];
  const leftOut = new Map<Reason, Tally>();
  const seen = new Set<string>();
  const leave = (reason: Reason, entry: unzip.ZipEntry) => {
    const tally = leftOut.get(reason) ?? { files: 0, bytes: 0 };
    leftOut.set(reason, { files: tally.files + 1, bytes: tally.bytes + entry.size });
  };
  for (const entry of entries) {
    if (entry.folder) continue;
    const parts = safeParts(entry.name);
    const reason = parts ? leftOutFor(parts) : 'unusable names';
    if (reason) {
      leave(reason, entry);
      continue;
    }
    const path = parts!.join('/');
    if (entry.link || seen.has(path)) {
      leave('unusable names', entry);
      continue;
    }
    if (entry.encrypted) throw new ImportError('it has a password: zip it again without one');
    if (entry.method !== 0 && entry.method !== 8)
      throw new ImportError(
        "it uses a compression this server can't unpack: zip it again with the computer's own Compress",
      );
    seen.add(path);
    kept.push({ parts: parts!, entry });
  }
  if (!kept.length) throw new ImportError('nothing in it was worth keeping: only files a computer can rebuild');
  const wrapper = wrapperOf(kept);
  if (wrapper) for (const k of kept) k.parts.shift();
  return { kept, leftOut, wrapper };
}

// A single folder around everything, holding several folders and nothing of its own but notes: a zipped folder of
// concepts, which isn't repeated. A folder with a project's own files (a package.json) or folders (src/) is a zipped
// concept, and stays.
const NOTE_FILE = /\.(md|txt|pdf|rtf)$/i;
const PROJECT_FOLDER = /^(src|public|assets|static|lib|app|components|pages|styles|scripts|images|img|css|js)$/i;
function wrapperOf(kept: Kept[]) {
  const top = kept[0].parts[0];
  if (!kept.every(k => k.parts.length > 1 && k.parts[0] === top)) return null;
  const ownFiles = kept.filter(k => k.parts.length === 2 && !NOTE_FILE.test(k.parts[1]));
  const folders = new Set(kept.filter(k => k.parts.length > 2).map(k => k.parts[1]));
  const project = ownFiles.length > 0 || [...folders].some(folder => PROJECT_FOLDER.test(folder));
  return folders.size > 1 && !project ? top : null;
}

const startImport = (id: number, i: number) =>
  importZip(id, i).catch(e => console.error(`Could not record the zip import for request #${id}:`, e));

async function importZip(id: number, i: number) {
  const source = zipOf(id, i);
  const unpacking = unpackingOf(id, i);
  const reservationId = reservationKey(id, i);
  let outcome: Pick<Field, 'state' | 'imported' | 'error'>;
  try {
    const plan = planImport(await unzip.listEntries(source));
    const bytes = plan.kept.reduce((n, k) => n + k.entry.size, 0);
    const toWrite = { bytes: plan.kept.reduce((n, k) => n + onDisk(k.entry.size), 0), until: Infinity };
    if (!room(reservationId, toWrite.bytes))
      throw new ImportError(`unpacked, it needs ${formatBytes(toWrite.bytes)}, and the server has no room for that`);
    reserved.set(reservationId, toWrite);
    await unpack(source, plan.kept, unpacking, toWrite);
    const request = db.prepare('select title, zips from requests where id = ?').get(id) as {
      title: string;
      zips: string;
    };
    const field = fieldsOf(request.zips)[i];
    const folder = freeFolder(`${IMPORTS_DIR}/${id}-${slug(field.label)}`);
    const leftOutTally = [...plan.leftOut.values()].reduce(
      (t, x) => ({ files: t.files + x.files, bytes: t.bytes + x.bytes }),
      { files: 0, bytes: 0 },
    );
    const imported = {
      folder,
      folders: new Set(plan.kept.filter(k => k.parts.length > 1).map(k => k.parts[0])).size,
      files: plan.kept.length,
      bytes,
      leftOut: leftOutTally,
    };
    writeFileSync(`${unpacking}/${IMPORT_NOTE}`, importNote({ id, title: request.title, field, ...plan, imported }), {
      mode: 0o644,
    });
    renameSync(unpacking, folder);
    outcome = { state: 'imported', imported };
    console.log(`Zip for request #${id}: imported into ${folder}: ${plan.kept.length} files, ${formatBytes(bytes)}`);
  } catch (e) {
    rmSync(unpacking, { recursive: true, force: true });
    const why = reasonFor(e);
    if (!why) console.error(`Could not import the zip for request #${id}:`, e);
    outcome = { state: 'failed', error: why ?? 'the server could not unpack it' };
  }
  reserved.delete(reservationId);
  rmSync(source, { force: true });
  const row = db.prepare('select zips from requests where id = ?').get(id) as { zips: string } | undefined;
  if (!row) return;
  const fields = fieldsOf(row.zips);
  Object.assign(fields[i], outcome);
  if (outcome.state === 'failed') delete fields[i].imported;
  save(id, fields);
}

// The kept entries into a fresh folder, counting down what they still have to write.
async function unpack(source: string, kept: Kept[], unpacking: string, toWrite: Reservation) {
  rmSync(unpacking, { recursive: true, force: true });
  for (const { parts, entry } of kept) {
    const to = `${unpacking}/${parts.join('/')}`;
    mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
    await unzip.extract(source, entry, to);
    toWrite.bytes -= onDisk(entry.size);
  }
}

// What the card says about a failure: the zip's own fault in words, or null for one of the server's
const reasonFor = (e: unknown) => (e instanceof unzip.ZipError || e instanceof ImportError ? e.message : null);

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'zip';
function freeFolder(path: string) {
  let candidate = path;
  for (let n = 2; existsSync(candidate); n++) candidate = `${path}-${n}`;
  return candidate;
}

// ---------------------------------------------------------------- what the folder holds
const KINDS = [
  ['videos', /\.(mp4|m4v|mov|webm|mkv|avi)$/i],
  ['sound', /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i],
  ['pictures', /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i],
] as const;

function importNote(n: {
  id: number;
  title: string;
  field: Field;
  kept: Kept[];
  leftOut: Map<Reason, Tally>;
  wrapper: string | null;
  imported: Imported;
}) {
  const folders = new Map<string, Kept[]>();
  for (const k of n.kept) {
    const top = k.parts.length > 1 ? `${k.parts[0]}/` : '(the top)';
    folders.set(top, [...(folders.get(top) ?? []), k]);
  }
  const row = (name: string, files: Kept[]) => {
    const counts = KINDS.map(([, pattern]) => files.filter(f => pattern.test(f.entry.name)).length);
    return `| ${name} | ${files.length} | ${formatBytes(files.reduce((b, f) => b + f.entry.size, 0))} | ${counts.join(' | ')} |`;
  };
  const videos = n.kept.filter(k => KINDS[0][1].test(k.entry.name));
  const reasons = [...n.leftOut].map(([reason, t]) => `- ${reason}: ${count(t.files)} files, ${formatBytes(t.bytes)}`);
  return [
    `# ${n.field.label}`,
    '',
    `Imported on ${new Date().toISOString().slice(0, 10)} from ${n.field.upload?.name} (${formatBytes(n.field.upload?.size ?? 0)}), for desk-phone request #${n.id} ("${n.title}").`,
    `Kept: ${count(n.imported.files)} files, ${formatBytes(n.imported.bytes)}. Every path below is relative to this folder.`,
    n.wrapper ? `The zip had everything in ${n.wrapper}/, which isn't repeated here.` : '',
    !n.wrapper && folders.size === 1 && !folders.has('(the top)')
      ? `The zip had everything in ${[...folders.keys()][0]}, kept as it was: it looked like one project.`
      : '',
    '',
    '## Left out (a computer can rebuild these, or they hold keys)',
    '',
    ...(reasons.length ? reasons : ['- nothing']),
    '',
    '## The folders',
    '',
    `| Folder | Files | Size | ${KINDS.map(([kind]) => kind[0].toUpperCase() + kind.slice(1)).join(' | ')} |`,
    `|---|---|---|${KINDS.map(() => '---').join('|')}|`,
    ...[...folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, files]) => row(name, files)),
    '',
    '## Videos',
    '',
    ...(videos.length ? videos.map(v => `- ${v.parts.join('/')} (${formatBytes(v.entry.size)})`) : ['- none']),
    '',
  ].join('\n');
}

const count = (n: number) => n.toLocaleString('en');
function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

// ---------------------------------------------------------------- the answer
// answerRequest: every required zip imported, and none still on its way. Returns the line the agent's answer ends
// with, or 400.
export function answerLine(id: number, json: string) {
  const fields = fieldsOf(json);
  if (fields.some(f => (!f.optional && f.state !== 'imported') || f.state === 'importing')) return 400;
  const lines = fields.map(f => {
    const it = f.imported;
    if (f.state !== 'imported' || !it) return `- ${f.label}: left empty`;
    const leftOut = it.leftOut.files
      ? `; left out ${count(it.leftOut.files)} files, ${formatBytes(it.leftOut.bytes)}, that a computer can rebuild or that hold keys`
      : '';
    return `- ${f.label}: ${it.folder} (from ${f.upload?.name}): ${count(it.folders)} folders, ${count(it.files)} files, ${formatBytes(it.bytes)}${leftOut}. What's where: ${it.folder}/${IMPORT_NOTE}`;
  });
  return `Zips: ${fields.filter(f => f.state === 'imported').length} of ${fields.length} imported. Jobs read them in place (read-only, never copied):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------- the sweep
// Hourly, and at the start: an upload whose card is no longer open goes. At the start, a half-unpacked
// folder goes too, and a field that was being unpacked when the coordinator stopped starts again from its zip.
export function sweep(starting = false) {
  for (const name of readdirSync(INCOMING)) {
    const id = Number(/^(\d+)-/.exec(name)?.[1]);
    const open = id && db.prepare("select 1 from requests where id = ? and status = 'open'").get(id);
    if (open && !(starting && name.endsWith('.unpacking'))) continue;
    rmSync(`${INCOMING}/${name}`, { recursive: true, force: true });
    if (!open) reserved.delete(name.replace(/\.zip$/, ''));
  }
  if (starting) resumeImports();
}

function resumeImports() {
  const rows = db.prepare("select id, zips from requests where status = 'open' and zips is not null").all() as {
    id: number;
    zips: string;
  }[];
  for (const { id, zips } of rows) {
    const fields = fieldsOf(zips);
    fields.forEach((field, i) => {
      if (field.state !== 'importing') return;
      if (existsSync(zipOf(id, i))) return startImport(id, i);
      Object.assign(field, {
        state: 'failed',
        error: 'the server restarted while it was being unpacked: pick the file again',
      });
      save(id, fields);
    });
  }
}

sweep(true);
setInterval(() => {
  try {
    sweep();
  } catch (e) {
    console.error('zips: the sweep failed:', e);
  }
}, 3_600_000).unref();
