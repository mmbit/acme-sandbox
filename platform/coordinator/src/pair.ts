// Two of the board's own devices paired for one session: the first shows a
// one-time code, the second types or scans it, and from then on what each sends reaches the other live. The relay never
// looks inside an event: HQ's book sends its marks, notes, page turns and fold through it.
//   POST /api/pair {}                     { pair, side: 'a', key, code, expires }: a pairing waiting for its other device
//   POST /api/pair { pair, key }          the same with a fresh code while it waits (the old code dies)
//   POST /api/pair/join { code }          { pair, side: 'b', key }
//   GET  /api/pair/live?pair=&key=        Server-Sent Events of { tag, payload }: the other side's, verbatim, and the
//                                         server's own { tag: 'pair', payload: { state } } (PairState)
//   POST /api/pair/send { pair, key, events: [{ tag, payload }] }   relayed to the other side, in order
//   POST /api/pair/end { pair, key }      ended for both
// A side's key proves which side a call comes from. hq.db keeps the pairing with only the code's and keys' hashes (it's
// read widely) and never an event (house rule 7): the events live in memory, the last few per side for a stream that
// reconnects. A restart loses those, and each side hears 'paired' again when its stream returns, so it sends its state
// again.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';

type Side = 'a' | 'b';
// waiting: the other side hasn't joined yet. paired: both have (on the join, and again on each (re)connect after it).
// away: the other side's stream dropped. back: it returned. ended: closed by a side or the sweep, and the stream ends.
type PairState = 'waiting' | 'paired' | 'away' | 'back' | 'ended';
type PairEvent = { tag: string; payload: Record<string, unknown> };
type Row = {
  id: string;
  code_expires: number;
  key_a: string;
  key_b: string | null;
  joined: number | null;
  ended: number | null;
};
type Refusal = [number, string];

db.exec(`create table if not exists pairs (id text primary key, code_hash text, code_expires integer not null,
  key_a text not null, key_b text, created integer not null, joined integer, ended integer);
  create index if not exists pairs_code on pairs (code_hash)`);

// A code is typed by hand, so it's short: 6 digits, good once and for a minute, and asked for only behind the board's
// login. That leaves a guesser a million codes to try within the minute.
const CODE_MS = 60_000;
// A waiting pairing outlives its code by a minute, so a fresh code asked as the old one runs out still finds it.
const CODE_GRACE_MS = 60_000;
// A pairing both devices have left for this long ends: nothing stays open for a device that's gone for good.
const QUIET_MS = 10 * 60_000;
// An ended pairing's row goes after a day: a late call from a sleeping tab still hears 'ended', not 'unknown'.
const ENDED_KEPT_MS = 24 * 3_600_000;
// What the coordinator's memory holds for a side whose stream is away, to replay on its return: the last 200 events,
// and at most 16 MB of them (8 of the biggest a send carries, SEND_MAX), as the coordinator shares its memory limit.
const RING_EVENTS = 200,
  RING_BYTES = 16 * 1024 ** 2;
// A send's body: an open mark carries all its strokes. Past this the sender is refused (413), as no mark comes near it.
export const SEND_MAX = 2 * 1024 ** 2;
// A comment line this often keeps a proxy from closing a stream it thinks idle.
const PING_MS = 25_000;
// Caddy and any other proxy pass each event on at once, and nothing keeps a copy.
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
};
const TAG = /^[a-z:-]{1,24}$/;
const SERVER_TAG = 'pair';

// Each pairing's live side in memory: its streams, the events kept for each side, and since when neither side has had
// one open (the start of this process for a pairing that came through a restart).
type Kept = { id: number; line: string; bytes: number };
type Channel = { stream?: ServerResponse; kept: Kept[]; bytes: number; connected: boolean; toldAway: boolean };
type Live = { next: number; paired: boolean; quietSince: number; sides: Record<Side, Channel> };
const live = new Map<string, Live>();
const STARTED = Date.now();
let stopping = false;

export function createPair(body: any) {
  if (body?.pair !== undefined) return freshCode(body);
  const pair = randomBytes(12).toString('base64url'),
    key = randomBytes(24).toString('base64url'),
    now = Date.now();
  const code = newCode(now);
  db.prepare('insert into pairs (id, code_hash, code_expires, key_a, created) values (?, ?, ?, ?, ?)').run(
    pair,
    hash(code),
    now + CODE_MS,
    hash(key),
    now,
  );
  return { pair, side: 'a', key, code, expires: now + CODE_MS };
}

function freshCode(body: any) {
  const found = sideOf(body);
  if (Array.isArray(found)) return found;
  if (found.side !== 'a') return [403, 'only the device that shows the code asks for a fresh one'] as Refusal;
  if (found.row.joined) return [409, 'the other device has joined: no code is needed'] as Refusal;
  const now = Date.now(),
    code = newCode(now);
  db.prepare('update pairs set code_hash = ?, code_expires = ? where id = ?').run(
    hash(code),
    now + CODE_MS,
    found.row.id,
  );
  return { pair: found.row.id, side: 'a', key: String(body.key), code, expires: now + CODE_MS };
}

// A code no other waiting pairing shows now
function newCode(now: number) {
  const showing = db.prepare(
    'select 1 from pairs where code_hash = ? and joined is null and ended is null and code_expires > ?',
  );
  for (;;) {
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    if (!showing.get(hash(code), now)) return code;
  }
}

export function joinPair(body: any) {
  const code = String(body?.code ?? '').replace(/[\s-]/g, ''),
    now = Date.now();
  const noSuchCode: Refusal = [404, 'no such code: type the 6 digits the other device shows'];
  if (!/^\d{6}$/.test(code)) return noSuchCode;
  // (an old pairing's code may come round again: the one still waiting comes first)
  const row = db
    .prepare(
      `select * from pairs where code_hash = ?
       order by joined is null and ended is null and code_expires > ? desc, code_expires desc limit 1`,
    )
    .get(hash(code), now) as Row | undefined;
  if (!row) return noSuchCode;
  if (row.joined || row.ended || row.code_expires <= now)
    return [410, 'that code is used or past its minute: show a fresh one'] as Refusal;
  const key = randomBytes(24).toString('base64url');
  db.prepare('update pairs set key_b = ?, joined = ? where id = ?').run(hash(key), now, row.id);
  const pairing = live.get(row.id);
  if (pairing) {
    pairing.paired = true;
    tell(pairing, 'a', 'paired');
  }
  return { pair: row.id, side: 'b', key };
}

// GET /api/pair/live: the side's stream, or the refusal for the route to answer. The events it missed come first (after
// its Last-Event-ID, all of them on a first connect), then where the pairing stands.
export function listen(req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
  const found = sideOf({ pair: query.get('pair'), key: query.get('key') });
  if (Array.isArray(found)) return found;
  const { row, side } = found,
    pairing = liveOf(row),
    channel = pairing.sides[side],
    other = pairing.sides[otherOf(side)];
  res.writeHead(200, SSE_HEADERS);
  channel.stream?.end(); // (one stream a side: the newest)
  channel.stream = res;
  const after = Number(req.headers['last-event-id'] ?? 0) || 0;
  for (const kept of channel.kept) if (kept.id > after) res.write(kept.line);
  if (!pairing.paired) tell(pairing, side, 'waiting');
  else greet(pairing, channel, other, side);
  channel.connected = true;
  const ping = setInterval(() => res.write(':\n\n'), PING_MS);
  res.on('close', () => {
    clearInterval(ping);
    if (channel.stream !== res) return;
    channel.stream = undefined;
    if (stopping || live.get(row.id) !== pairing) return;
    if (!other.stream) pairing.quietSince = Date.now();
    else if (pairing.paired) {
      tell(pairing, otherOf(side), 'away');
      other.toldAway = true;
    }
  });
}

// A side's (re)connect once both have joined: 'paired', then 'away' while the other side is gone, and the other side
// hears 'back' when it heard this one was away
function greet(pairing: Live, channel: Channel, other: Channel, side: Side) {
  tell(pairing, side, 'paired');
  channel.toldAway = !other.stream && other.connected;
  if (channel.toldAway) tell(pairing, side, 'away');
  if (other.toldAway) {
    tell(pairing, otherOf(side), 'back');
    other.toldAway = false;
  }
}

export function sendEvents(body: any) {
  const found = sideOf(body);
  if (Array.isArray(found)) return found;
  const events = body.events;
  if (!Array.isArray(events) || !events.every(isEvent))
    return `events: a list of { tag, payload }, each tag a word of 1 to 24 of a-z, ':' and '-' (not '${SERVER_TAG}', the server's) and its payload an object`;
  if (!found.row.joined) return [409, "the other device hasn't joined yet"] as Refusal;
  const pairing = liveOf(found.row),
    to = otherOf(found.side);
  for (const { tag, payload } of events as PairEvent[]) deliver(pairing, to, { tag, payload });
  return { ok: true };
}

const isEvent = (e: any) =>
  typeof e?.tag === 'string' &&
  TAG.test(e.tag) &&
  e.tag !== SERVER_TAG &&
  typeof e.payload === 'object' &&
  e.payload !== null &&
  !Array.isArray(e.payload);

export function endPair(body: any) {
  const found = sideOf(body);
  if (Array.isArray(found)) return found;
  end(found.row.id);
  return { ok: true };
}

// Each minute: a pairing never joined goes a minute after its code, a joined one both sides have left ends, and an
// ended one goes after a day.
export function sweep(now = Date.now()) {
  const waited = db
    .prepare('select id from pairs where joined is null and ended is null and code_expires < ?')
    .all(now - CODE_GRACE_MS);
  for (const { id } of waited as { id: string }[]) {
    closeStreams(id);
    db.prepare('delete from pairs where id = ?').run(id);
  }
  const open = db.prepare('select id from pairs where joined is not null and ended is null').all() as { id: string }[];
  for (const { id } of open) {
    const pairing = live.get(id);
    if (pairing?.sides.a.stream || pairing?.sides.b.stream) continue;
    if (now - (pairing?.quietSince ?? STARTED) >= QUIET_MS) end(id, now);
  }
  db.prepare('delete from pairs where ended < ?').run(now - ENDED_KEPT_MS);
}
export const startSweep = () =>
  setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.error('Could not sweep the pairings:', err);
    }
  }, 60_000);

// At a stop: the streams end without a word to the other side, and each device reconnects to the next coordinator.
export function endStreams() {
  stopping = true;
  for (const pairing of live.values()) for (const channel of Object.values(pairing.sides)) channel.stream?.end();
}

function end(id: string, now = Date.now()) {
  db.prepare('update pairs set ended = ? where id = ?').run(now, id);
  closeStreams(id);
}
// Each open stream hears 'ended' and closes, and the pairing's memory goes
function closeStreams(id: string) {
  const pairing = live.get(id);
  if (!pairing) return;
  live.delete(id);
  for (const side of ['a', 'b'] as const) {
    tell(pairing, side, 'ended');
    pairing.sides[side].stream?.end();
  }
}

// The pairing and the side a call's key proves, or why not: unknown, a key of neither side, or ended
function sideOf(body: any): { row: Row; side: Side } | Refusal {
  const row = db.prepare('select * from pairs where id = ?').get(String(body?.pair ?? '')) as Row | undefined;
  if (!row) return [404, 'no such pairing: pair the devices again'];
  const keyHash = hash(String(body.key ?? ''));
  const side = keyHash === row.key_a ? 'a' : keyHash === row.key_b ? 'b' : undefined;
  if (!side) return [403, "that key is neither side's"];
  if (row.ended) return [410, 'this pairing has ended: pair the devices again'];
  return { row, side };
}

function liveOf(row: Row) {
  const had = live.get(row.id);
  if (had) return had;
  const channel = (): Channel => ({ kept: [], bytes: 0, connected: false, toldAway: false });
  // Ids start at the clock, so the ones after a restart come after any a device saw before it.
  const pairing: Live = {
    next: Date.now(),
    paired: !!row.joined,
    quietSince: Date.now(),
    sides: { a: channel(), b: channel() },
  };
  live.set(row.id, pairing);
  return pairing;
}

// The server's own word to a side, live only: a side that reconnects hears where things stand then (greet)
const tell = (pairing: Live, side: Side, state: PairState) =>
  deliver(pairing, side, { tag: SERVER_TAG, payload: { state } }, false);

// An event to a side's stream, and kept for its replay unless it's the server's own
function deliver(pairing: Live, side: Side, event: PairEvent, keep = true) {
  const id = ++pairing.next,
    line = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`,
    channel = pairing.sides[side];
  if (keep) {
    const bytes = Buffer.byteLength(line);
    channel.kept.push({ id, line, bytes });
    channel.bytes += bytes;
    while (channel.kept.length > RING_EVENTS || channel.bytes > RING_BYTES)
      channel.bytes -= channel.kept.shift()!.bytes;
  }
  channel.stream?.write(line);
}

const otherOf = (side: Side): Side => (side === 'a' ? 'b' : 'a');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
