// The watch-along's store: its sessions and their recorded events, on the database and folder of the app that keeps
// them (the coordinator for calls). README.md has the design.
//   - A session is started for one purpose and the thing it belongs to (a live call), with a key of its own that only
//     its page holds. The database keeps the key's sha256.
//   - And with the other origins its page may show, as the app decides at its start (a guest's walk-through: the
//     previews its share reaches): what the recording names is the page's word, never the app's.
//   - Each batch the page posts is appended to the session's file as one gzip member (a gzip file may hold several), with
//     the time it came in: the page's clock may be off, and the call's transcript is timed by the server's.
//   - A session ends with its purpose (the call's end) and goes, file and row, KEEP_DAYS after it started.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';

// 'shown': what was typed is kept, except passwords; 'hidden': only that something was typed (watchalong.js)
export type Typed = 'shown' | 'hidden';
export type Session = {
  id: number;
  purpose: string;
  ref: string;
  typed: Typed;
  origins: string[];
  started: string;
  ended: string | null;
  bytes: number;
};
// rrweb's events: its type (0-6), when on the page's clock, and what happened
export type RecordedEvent = { type: number; timestamp: number; data: Record<string, unknown> };
export type Recording = { session: Session; events: RecordedEvent[]; clockMs: number };

// A batch: twenty times HQ's full snapshot with a canvas frame (0.4 MB at 744 × 1133, measured), so a bigger page of
// ours still fits; the page never posts more at once (watchalong.js). A session: a call's longest, 3 hours
// (coordinator call.ts CALL_MS), of HQ with canvas frames at 0.5 a second, 1.9 MB a minute as stored (measured), with
// some to spare.
export const BATCH_BYTES = 8 << 20,
  SESSION_BYTES = 400 << 20;
export const KEEP_DAYS = 90;
const DAY_MS = 86_400_000;
const EVENT_TYPES = 7;

// Where a store keeps its sessions: the app's database and a folder of its own, and who hears each batch as it's kept
// (the mirror, the moments).
export type Heard = (id: number, events: RecordedEvent[], at: number) => void;
export type Store = { db: DatabaseSync; dir: string; heard?: Heard };

// A store on this database and folder (made if missing; only the app's own user may read it)
export function open(db: DatabaseSync, dir: string, heard?: Heard): Store {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  db.exec(`create table if not exists watchalong_sessions (id integer primary key autoincrement, purpose text not null,
    ref text not null, typed text not null, key_hash text not null, started text not null, ended text,
    bytes integer not null default 0)`);
  const columns = db.prepare('pragma table_info(watchalong_sessions)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'origins'))
    db.exec(`alter table watchalong_sessions add column origins text not null default '[]'`);
  return { db, dir, heard };
}

// A new session, and the key its page posts with (origins)
export function start({ db }: Store, purpose: string, ref: string, typed: Typed, origins: string[] = []) {
  const key = randomBytes(24).toString('base64url');
  const id = Number(
    db
      .prepare(
        'insert into watchalong_sessions (purpose, ref, typed, origins, key_hash, started) values (?, ?, ?, ?, ?, ?)',
      )
      .run(purpose, ref, typed, JSON.stringify(origins), hash(key), new Date().toISOString()).lastInsertRowid,
  );
  return { id, key };
}

// A batch from the page, as its body came in: the HTTP status to answer. A wrong key is 404 too, so a guess learns
// nothing. A batch past BATCH_BYTES is 413; one past the session's room is 507, and the session is full.
export function add(store: Store, id: number, key: string, body: Buffer) {
  const session = find(store, id);
  if (!session || !sameKey(keyOf(store, id), key)) return 404;
  if (session.ended) return 409;
  if (body.length > BATCH_BYTES) return 413;
  const events = batchOf(body);
  if (!events) return 400;
  const at = Date.now();
  const line = gzipSync(`${JSON.stringify({ at, events })}\n`);
  if (session.bytes + line.length > SESSION_BYTES) return 507;
  appendFileSync(fileOf(store, id), line, { mode: 0o600 });
  store.db.prepare('update watchalong_sessions set bytes = bytes + ? where id = ?').run(line.length, id);
  store.heard?.(id, events, at);
  return 200;
}

// Every session of this purpose and thing ends (the call is over): their pages hear 409 from then on
export function end({ db }: Store, purpose: string, ref: string) {
  db.prepare('update watchalong_sessions set ended = ? where purpose = ? and ref = ? and ended is null').run(
    new Date().toISOString(),
    purpose,
    ref,
  );
}

// A session's events in order, and how far the page's clock ran behind the server's (add clockMs to an event's
// timestamp for the server's time): the smallest gap between a batch's arrival and its last event
export function read(store: Store, id: number): Recording | undefined {
  const session = find(store, id);
  if (!session) return undefined;
  const batches = session.bytes ? lines(gunzipSync(readFileSync(fileOf(store, id)))) : [];
  const events = batches.flatMap(batch => batch.events);
  const gaps = batches.filter(batch => batch.events.length).map(batch => batch.at - batch.events.at(-1)!.timestamp);
  return { session, events, clockMs: gaps.length ? Math.min(...gaps) : 0 };
}

export function find({ db }: Store, id: number) {
  const row = db.prepare(`select ${COLUMNS} from watchalong_sessions where id = ?`).get(id);
  return row && sessionOf(row);
}
// The sessions of one thing, oldest first
export const sessionsOf = ({ db }: Store, purpose: string, ref: string) =>
  db
    .prepare(`select ${COLUMNS} from watchalong_sessions where purpose = ? and ref = ? order by id`)
    .all(purpose, ref)
    .map(sessionOf);
const COLUMNS = 'id, purpose, ref, typed, origins, started, ended, bytes';
const sessionOf = (row: Record<string, unknown>) => ({ ...row, origins: JSON.parse(String(row.origins)) }) as Session;

// Sessions past KEEP_DAYS go
export function sweep(store: Store, now = Date.now()) {
  const before = new Date(now - KEEP_DAYS * DAY_MS).toISOString();
  const old = store.db.prepare('select id from watchalong_sessions where started < ?').all(before) as { id: number }[];
  for (const { id } of old) remove(store, id);
}
// One thing's sessions at once (its record was deleted)
export const forget = (store: Store, purpose: string, ref: string) =>
  sessionsOf(store, purpose, ref).forEach(session => remove(store, session.id));
function remove(store: Store, id: number) {
  rmSync(fileOf(store, id), { force: true });
  store.db.prepare('delete from watchalong_sessions where id = ?').run(id);
}

const fileOf = ({ dir }: Store, id: number) => `${dir}/${id}.ndjson.gz`;
const keyOf = ({ db }: Store, id: number) =>
  (db.prepare('select key_hash from watchalong_sessions where id = ?').get(id) as { key_hash: string }).key_hash;

// A page's batch, { events: [...] }, each an rrweb event; undefined when it isn't one
function batchOf(body: Buffer) {
  let posted: unknown;
  try {
    posted = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  const events = (posted as { events?: unknown })?.events;
  return Array.isArray(events) && events.every(isEvent) ? (events as RecordedEvent[]) : undefined;
}
const isEvent = (event: unknown) => {
  const { type, timestamp, data } = (event ?? {}) as Partial<RecordedEvent>;
  return (
    Number.isInteger(type) &&
    type! >= 0 &&
    type! < EVENT_TYPES &&
    Number.isFinite(timestamp) &&
    typeof data === 'object' &&
    data !== null
  );
};

const lines = (text: Buffer) =>
  text
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { at: number; events: RecordedEvent[] });

const hash = (key: string) => createHash('sha256').update(key).digest('base64url');
const sameKey = (stored: string, key: string) => {
  const want = Buffer.from(stored),
    got = Buffer.from(hash(key));
  return want.length === got.length && timingSafeEqual(want, got);
};
