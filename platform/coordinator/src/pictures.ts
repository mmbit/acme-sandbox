// The board's pictures on the intercom and on calls: a phone photo, a screenshot, a pasted image, for feedback on HQ
// itself or an idea from an outside site, where review mode's pin doesn't reach.
//   - HQ uploads each picture as soon as it's picked or pasted (POST /api/pictures, the raw JPEG or PNG). Like a
//     desk-phone photo, it's cut down to what shows the picture (photos.ts: no GPS, no Exif), or refused. The type is
//     read from the bytes, never from the header alone.
//   - On a live call, HQ's call screen uploads with ?call=<id>&key=<the call's key>. The picture goes to the voice line
//     (forVoice), which shows it to the call agent with the board's next words.
//   - Files live in the coordinator's data volume, never the repo: pictures/<id>.jpg|png (0700/0600). HQ shows them
//     from its own origin only (behind the board's session): product hosts never reach /api.
//   - An intercom picture waits unattached until the board sends its line (chat.ts say()), or removes it from its tray
//     (forget). HQ shows the waiting ones again when the intercom opens (unsent). One never sent goes after a day.
//   - A desk-phone card's answer takes them too: HQ uploads with ?request=<id>,
//     the picture waits for that card's answer, apart from the intercom's tray, and goes with it (answerRequest,
//     jobs.ts).
//   - Agents save them with `hq picture <id>` (forWorker), once the line or answer they went with is sent: any job may
//     save an intercom line's; a card answer's follows the card's access (jobs.ts cardAccess); a call's picture is for
//     whoever hq call shows its lines to (memory.ts callAccess).
//
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { DATA_DIR } from './config.ts';
import { stripJpeg, stripPng } from './photos.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { keepFile, refuse, reply } from './uploads.ts';
import * as memory from './memory.ts';
import { cardAccess, customerCard, handedCustomerData, takesPictures, type Reader } from './jobs.ts';

export const DIR = `${DATA_DIR}/pictures`;
// 3.5 MB stays under the model's 5 MB per picture once base64-encoded (a call sends it that way). HQ redraws a picture
// at most 2560 px on its long side as a JPEG first, which is well under.
export const MAX_BYTES = 3.5 * 1024 * 1024,
  PER_LINE = 6,
  PER_CALL = 30,
  WAITING = 24;
const UNSENT_MS = 24 * 3600_000;
mkdirSync(DIR, { recursive: true, mode: 0o700 });
// (autoincrement: a number in a line or a transcript never comes to mean another picture once one is deleted)
// chat: the intercom line it went with. call: the call it was shown on. request: the desk-phone card it waits for.
// answered: 1 once it went with that card's answer.
db.exec(`create table if not exists pictures (id integer primary key autoincrement, created text not null, type text not null,
  bytes integer not null, chat integer, call integer, request integer, answered integer not null default 0)`);

// ---------------------------------------------------------------- the board's upload (HQ session, HQ's own Origin)
// POST /api/pictures[?call=<id>&key=<key> | ?request=<id>]: one picture as the body. A call must be live and the key
// its own; a card must be open and take an answer; an intercom picture waits for its line.
export async function upload(req: IncomingMessage, res: ServerResponse) {
  const query = new URL(req.url ?? '/', 'http://x').searchParams;
  const callId = Number(query.get('call') ?? 0),
    card = Number(query.get('request') ?? 0);
  forgetUnsent();
  if (card && !answerable(card)) return refuse(req, res, 409, 'that card is no longer waiting for an answer');
  // A call that leaves nothing behind is deleted (call.ts handOver, ledger.ts sweep), and its number can go to the next
  // call, while HQ still redraws a picture picked on it or sends its body. The key HQ had when the board picked it
  // names that call's token, which is that call's alone. The same token, still live, once the body is read means the
  // same call.
  const token = callId ? liveToken(callId) : undefined;
  if (callId && !(token && sameKey(token, query.get('key') ?? ''))) return refuse(req, res, 409, 'that call has ended');
  if (full(callId, card)) return refuse(req, res, 429, 'too many pictures at once');
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png') return refuse(req, res, 415, 'a JPEG or PNG only');
  const raw = await readBody(req, MAX_BYTES);
  if (!raw) return refuse(req, res, 413, 'too large');
  const p = picture(raw);
  if (!p) return reply(res, 400, { error: 'not a picture we can read' }, true);
  // Again, with no await before the insert: the call may have ended, and other uploads may have filled the tray or the
  // call's share while this body came in.
  if (callId && liveToken(callId) !== token) return reply(res, 409, { error: 'that call has ended' }, true);
  if (card && !answerable(card))
    return reply(res, 409, { error: 'that card is no longer waiting for an answer' }, true);
  if (full(callId, card)) return refuse(req, res, 429, 'too many pictures at once');
  const id = store(p, callId || null, card || null);
  return reply(res, 200, { id, type: p.type, bytes: p.clean.length });
}
// A stripped picture's row and file, for a call, a card or the intercom (call and card null).
function store(p: { type: string; clean: Buffer }, call: number | null, card: number | null) {
  const id = Number(
    db
      .prepare('insert into pictures (created, type, bytes, call, request) values (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), p.type, p.clean.length, call, card).lastInsertRowid,
  );
  keepFile(file({ id, type: p.type }), p.clean);
  return id;
}
// GET /api/pictures/waiting[?request=<id>]: the board's tray as the coordinator knows it, every picture uploaded for a
// line and not sent yet. HQ shows them again when the intercom (or the card) opens, after a reload too, so the board
// can send or remove what counts against WAITING: without it, pictures left after a reload would block new ones for a
// day.
export function unsent(card = 0) {
  forgetUnsent();
  return {
    pictures: db
      .prepare(`select id, type from pictures where ${UNSENT} and request is ? order by id`)
      .all(card || null),
  };
}
// Waiting for a line or a card's answer
const UNSENT = 'chat is null and call is null and answered = 0';
const isWaiting = (p: Picture) => p.chat === null && p.call === null && !p.answered;
// POST /api/pictures/forget: the board took a picture out of its tray. Only one still waiting for its line goes: a sent
// picture belongs to its line, a call's to its call.
export function forget(id: number) {
  const p = row(id);
  if (!p || !isWaiting(p)) return 404;
  drop([p]);
  return { forgotten: p.id };
}
// Pictures picked for a line the board never sent
const forgetUnsent = () =>
  drop(
    db
      .prepare(`select id, type from pictures where ${UNSENT} and created < ?`)
      .all(new Date(Date.now() - UNSENT_MS).toISOString()) as { id: number; type: string }[],
  );
function drop(list: { id: number; type: string }[]) {
  for (const p of list) {
    rmSync(file(p), { force: true });
    db.prepare('delete from pictures where id = ?').run(p.id);
  }
}
// (call.ts: a restarted call agent goes on with the same token, and the token is deleted when its call is)
const liveToken = (call: number) =>
  (
    db
      .prepare(
        `select t.hash from call_tokens t join calls c on c.id = t.call
  where c.id = ? and c.status = 'live'`,
      )
      .get(call) as { hash: string } | undefined
  )?.hash;
const sameKey = (hash: string, key: string) => {
  const want = Buffer.from(callKey(hash)),
    got = Buffer.from(key);
  return want.length === got.length && timingSafeEqual(want, got);
};
// Whether this key is the live call's own (watchalong.ts too).
export const opensCall = (call: number, key: string) => {
  const token = liveToken(call);
  return !!token && sameKey(token, key);
};
// A call's key for HQ's uploads, from its token's hash (call.ts context(), through the voice line): one call's alone,
// and it says nothing about the token
export const callKey = (hash: string) => createHash('sha256').update(`call pictures ${hash}`).digest('base64url');
// The call's share (PER_CALL), or the intercom's tray or a card's
const full = (call: number, card = 0) =>
  call
    ? count('select count(*) n from pictures where call = ?', call) >= PER_CALL
    : card
      ? count(`select count(*) n from pictures where ${UNSENT} and request = ?`, card) >= WAITING
      : count(`select count(*) n from pictures where ${UNSENT} and request is null`) >= WAITING;
// A card that takes pictures with its answer: open, and one whose answer takes them
const answerable = (card: number) => {
  const r = db.prepare("select secrets, kind from requests where id = ? and status = 'open'").get(card) as
    { secrets: string | null; kind: string } | undefined;
  return !!r && takesPictures(r);
};
const count = (sql: string, ...values: number[]) => (db.prepare(sql).get(...values) as { n: number }).n;
// What the bytes are, whatever the header says: a JPEG or a PNG, stripped, or null. (the book's uploads too)
export function picture(raw: Buffer) {
  if (raw[0] === 0xff && raw[1] === 0xd8) {
    const clean = stripJpeg(raw);
    return clean && { type: 'image/jpeg', clean };
  }
  const clean = stripPng(raw);
  return clean && { type: 'image/png', clean };
}

// The pictures the board picked for its next intercom line, or for a card's answer (`card`) (`ids`), and those of them
// no longer waiting for it (`missing`): gone after a day unsent, removed in another tab, or sent already. null: not a
// list of pictures.
export function waiting(v: unknown, card = 0) {
  if (v == null) return { ids: [], missing: [] };
  if (!Array.isArray(v) || v.length > PER_LINE) return null;
  const ids = [...new Set(v.map(Number))];
  if (!ids.every(id => Number.isInteger(id) && id > 0)) return null;
  return {
    ids,
    missing: ids.filter(id => {
      const p = row(id);
      return !p || !isWaiting(p) || (p.request ?? 0) !== card;
    }),
  };
}
// (keep and lineOf, the old Sketchbook's Send's, are gone)
export const attach = (ids: number[], line: number) => {
  for (const id of ids) db.prepare('update pictures set chat = ? where id = ?').run(line, id);
};
// They went with the card's answer
export const answered = (ids: number[]) => {
  for (const id of ids) db.prepare('update pictures set answered = 1 where id = ?').run(id);
};
// What an agent reads next to a line or a call: the pictures and how to look at them, or ''.
// (theirs: the line is an invited person's, not the board's, chat.ts 'guest')
export function mention(ids: number[], theirs = false) {
  if (!ids.length) return '';
  const list = ids.map(id => `#${id}`).join(ids.length === 2 ? ' and ' : ', ');
  const one = ids.length === 1,
    some = one ? 'a picture' : `${ids.length} pictures`;
  return (
    `(${theirs ? `${one ? 'A picture' : some} came with their line` : `The board attached ${some}`}, ${list}. Save ${one ? 'it' : 'them'} with ` +
    `\`hq picture ${ids.join(' ')}\`, then read the file${one ? '' : 's'} to look at ${one ? 'it' : 'them'}.)`
  );
}
export const ofLine = (line: number) =>
  (db.prepare('select id from pictures where chat = ? order by id').all(line) as { id: number }[]).map(p => p.id);
// Every line's pictures at once, for a read of many lines (intercom.ts)
export function ofLines() {
  const lines = new Map<number, number[]>(),
    rows = db.prepare('select id, chat from pictures where chat is not null order by id').all() as {
      id: number;
      chat: number;
    }[];
  for (const p of rows) lines.set(p.chat, [...(lines.get(p.chat) ?? []), p.id]);
  return lines;
}
// A call that leaves nothing behind (nobody spoke: call.ts, ledger.ts) takes its pictures with it: its number can be
// used again, and the next call with it must not find them.
export const forgetCall = (call: number) =>
  drop(db.prepare('select id, type from pictures where call = ?').all(call) as { id: number; type: string }[]);
export const ofCall = (call: number) =>
  (db.prepare('select id from pictures where call = ? order by id').all(call) as { id: number }[]).map(p => p.id);

// GET /api/pictures/file?id=<id>: for HQ's chat and call screen. Never a page on HQ's origin: an image or nothing.
// Never kept in the browser's cache either: once the session ends or the picture is gone, it's gone (like the board's
// photos).
export function serve(req: IncomingMessage, res: ServerResponse) {
  const p = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')));
  if (!p) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, {
    'content-type': p.type,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  res.end(readFileSync(file(p)));
}

// ---------------------------------------------------------------- the voice line: a picture shown on its live call
export function forVoice(id: number, call: number) {
  const p = row(id);
  if (!p || !call || p.call !== call || !db.prepare("select 1 from calls where id = ? and status = 'live'").get(call))
    return 404;
  return { id: p.id, type: p.type, data: readFileSync(file(p)).toString('base64') };
}

// ---------------------------------------------------------------- agents: hq picture <id>
// Who may save a picture: whoever may read what it came with.
//   - A card answer's, once it's sent: whoever hq photos shows that card's photos to (jobs.ts cardAccess: the agent who
//     asked, a job queued after the card; a customer card's, its reader, refused with why).
//   - A call's: whoever hq call shows the call's lines to (memory.ts callAccess: the jobs that work for the call, and
//     not while it's live). One about a customer the job wasn't handed is refused with why, as hq call is.
//   - An intercom line's, once it's sent: any job.
// Anything else is 404, the same as a picture that doesn't exist.
export function forWorker(id: number, me: Reader) {
  const p = row(id);
  if (!p) return 404;
  if (p.request) return p.answered ? fromCard(p, p.request, me) : 404;
  if (!p.call) return p.chat != null ? saved(p) : 404;
  const access = memory.callAccess(p.call, me);
  if (access !== true) return access;
  // a customer call's picture: its reader holds their details
  if (memory.customerCall(p.call)) handedCustomerData(me.id);
  return saved(p);
}
// A card answer's picture: a customer card's reader holds their details from then on
function fromCard(p: Picture, card: number, me: Reader) {
  const access = cardAccess(card, me);
  if (access !== true) return access;
  if (customerCard(card)) handedCustomerData(me.id);
  return saved(p);
}
const saved = (p: Picture) => ({
  id: p.id,
  type: p.type,
  bytes: p.bytes,
  created: p.created,
  from: p.call ? `call #${p.call}` : p.request ? `card #${p.request}` : 'the intercom',
  data: readFileSync(file(p)).toString('base64'),
});

// ---------------------------------------------------------------- shared
const file = (p: { id: number; type: string }) => `${DIR}/${p.id}.${p.type === 'image/png' ? 'png' : 'jpg'}`;
type Picture = {
  id: number;
  created: string;
  type: string;
  bytes: number;
  chat: number | null;
  call: number | null;
  request: number | null;
  answered: number;
};
const row = (id: number) =>
  (Number.isInteger(id) && id > 0 ? db.prepare('select * from pictures where id = ?').get(id) : undefined) as
    Picture | undefined;
