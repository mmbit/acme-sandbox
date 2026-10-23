// Files on a desk-phone card: an agent hands the board files it puts in place
// itself (a site's pages, a config), with hq ask --file <path> (several), instead of pasting each into a block to copy and
// save by hand. The card shows each as a download by its name, and its steps say where to put it.
//   - Kept with the card, as the outbox keeps an email's attachments: the bytes in the table, as the agent sent them,
//     but for keys: a UTF-8 text file goes through the same redaction as every text an agent writes (charter rule 8), so
//     a key the company holds then is its name. That's at filing only: a key saved later isn't scrubbed from the bytes.
//   - Served to the board alone, behind HQ's sign-in, always as a download (never a page on HQ's origin).
//   - Kept while the card is open and for KEEP_DAYS after it's answered or closed (the Answered list still offers them),
//     then the bytes go and the names stay (sweep).
//   - A guest checklist's items carry files the same way (guests.ts: an item's "files"), kept with the checklist's card
//     under their item's number, and served to the guest's own session too.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, redacted } from './db.ts';
import { redact } from './events.ts';
import { attachment } from './files.ts';

db.exec(`create table if not exists request_files (request integer not null, n integer not null, name text not null,
  size integer not null, bytes blob, primary key (request, n))`);
redacted('request_files', 'name');
// item: the guest checklist item a file is under (null: the card's own)
if (!(db.prepare('pragma table_info(request_files)').all() as { name: string }[]).some(c => c.name === 'item'))
  db.exec('alter table request_files add column item integer');
// next: the number a card's next file takes once a dropped item took its highest files with it, so a number is never
// given to another file (a page loaded before still links to the dropped one)
db.exec('create table if not exists request_files_numbered (request integer primary key, next integer not null)');

export const MAX_FILES = 8,
  MAX_BYTES = 5 * 1024 * 1024; // (all of them together: a site's pages, a few pictures)
const MAX_NAME = 100,
  KEEP_DAYS = 30;
// (the request's JSON with them in base64, for the server's body limit)
export const JSON_MAX = Math.ceil((MAX_BYTES * 4) / 3) + 1_000_000;

export type CardFile = { name: string; bytes: Buffer };

// The files an agent sent ([{ name, data }], data in base64), checked: the list, or what's wrong with it (for the agent).
// what: where the agent named them; before: the files the card has already (a guest checklist's other items' and earlier
// additions'), which count toward its limits
export function read(v: unknown, what = '--file', before = { count: 0, size: 0 }): CardFile[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.length || v.length + before.count > MAX_FILES)
    return before.count
      ? `${what}: up to ${MAX_FILES} files on one card (it has ${before.count})`
      : `${what}: 1 to ${MAX_FILES} files`;
  const files: CardFile[] = [];
  let total = before.size;
  for (const f of v) {
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    if (!name || name.length > MAX_NAME || /[/\\\p{Cc}]/u.test(name) || /^\.+$/.test(name))
      return `${what}: a file's name is 1 to ${MAX_NAME} characters, no folder (${JSON.stringify(String(f?.name ?? '')).slice(0, 120)})`;
    if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data))
      return `${what}: ${name} came without its bytes`;
    const bytes = withoutKeys(Buffer.from(f.data, 'base64'));
    if (!bytes.length) return `${what}: ${name} is empty`;
    total += bytes.length;
    if (total > MAX_BYTES)
      return `${what}: more than ${MAX_BYTES / 1024 / 1024} MB in all; hand over fewer or smaller files`;
    files.push({ name, bytes });
  }
  if (new Set(files.map(f => f.name)).size !== files.length) return `${what}: two files with the same name`;
  return files;
}
// A text file (UTF-8 throughout) as it's kept: a key in it replaced by its name
function withoutKeys(bytes: Buffer) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes; // (not text: a picture, a zip)
  }
  const kept = redact(text) ?? text;
  return kept === text ? bytes : Buffer.from(kept, 'utf8');
}

// numbered after the card's files so far; item: a guest checklist item's
export function keep(request: number, files: CardFile[], item: number | null = null) {
  const add = db.prepare('insert into request_files (request, n, name, size, bytes, item) values (?, ?, ?, ?, ?, ?)');
  const next = (
    db
      .prepare(
        `select max(coalesce((select max(n) + 1 from request_files where request = ?), 0),
          coalesce((select next from request_files_numbered where request = ?), 0)) n`,
      )
      .get(request, request) as { n: number }
  ).n;
  files.forEach((f, k) => add.run(request, next + k, f.name, f.bytes.length, f.bytes, item));
}

// How many files a card has and their size, toward its limits
export const totals = (request: number) =>
  db
    .prepare('select count(*) count, coalesce(sum(size), 0) size from request_files where request = ?')
    .get(request) as {
    count: number;
    size: number;
  };

// A guest checklist item's files go with it (hq guest drop), their numbers kept from reuse
export function forget(request: number, item: number) {
  db.prepare(
    `insert into request_files_numbered (request, next) select request, max(n) + 1 from request_files where request = ?
      group by request on conflict (request) do update set next = max(next, excluded.next)`,
  ).run(request);
  db.prepare('delete from request_files where request = ? and item = ?').run(request, item);
}

// A card's files for HQ: each one's number, name and size, whether it can still be downloaded, and the item it's under
export const of = (request: number) =>
  (
    db
      .prepare('select n, name, size, bytes is not null as kept, item from request_files where request = ? order by n')
      .all(request) as { n: number; name: string; size: number; kept: number; item: number | null }[]
  ).map(f => ({ n: f.n, name: f.name, size: f.size, kept: !!f.kept, ...(f.item === null ? {} : { item: f.item }) }));

// GET /api/requests/file?id=<request>&n=<n>: one of a card's files, for the board (behind HQ's sign-in), as a download
export function serve(req: IncomingMessage, res: ServerResponse) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  if (send(res, Number(q.get('id')), Number(q.get('n')))) return;
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

// One of a card's files as a download: false when the card has none by that number, or its bytes are gone
export const send = (res: ServerResponse, request: number, n: number) => download(res, request, n, '');
// The same, only for a file under a guest checklist item (the guest's page: guests.ts)
export const sendItemFile = (res: ServerResponse, request: number, n: number) =>
  download(res, request, n, ' and item is not null');
function download(res: ServerResponse, request: number, n: number, only: string) {
  const f = db
    .prepare(`select name, bytes from request_files where request = ? and n = ? and bytes is not null${only}`)
    .get(request, n) as { name: string; bytes: Uint8Array } | undefined;
  if (!f) return false;
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': f.bytes.length,
    'content-disposition': attachment(f.name),
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(Buffer.from(f.bytes));
  return true;
}

// The bytes of cards answered or closed more than KEEP_DAYS ago go; their names stay on the card
export function sweep(now = Date.now()) {
  const before = new Date(now - KEEP_DAYS * 86_400_000).toISOString();
  db.prepare(
    `update request_files set bytes = null where bytes is not null and request in
      (select id from requests where status != 'open' and answered < ?)`,
  ).run(before);
}
