// The board's Sketchbook (HQ's sketchbook app): small pen drawings it keeps, labels, archives and deletes, and sends to
// the CEO one at a time.
//   - A sketch is its ink (shared/review/ink.js strokes, on a page of w × h CSS px) and the picture HQ draws of it at
//     every save. The picture is stripped as the board's pictures are (pictures.ts) and kept in the data volume, never
//     the repo: sketches/<id>-<random>.png|jpg (0700/0600). Each save gives it a new name, so no browser shows an old one.
//   - Send puts a copy of the picture on the intercom as a line from the board (chat.ts say). The copy is a picture of
//     its own (pictures.ts), so the line stays whole once the sketch is deleted.
//   - Any job reads every sketch (hq sketches, hq sketch <id>): the board shares them with the whole team.
//   - who: whose Sketchbook a sketch is in. The board's is 'board'.
//   - People the board invites may have a Sketchbook of their own (sketchpeople.ts), seen by the board on a shelf each.
//     Their Send is their line on the intercom (chat.ts fromGuest), as outside text.
//   - Scraps: pictures placed on the page under the ink ({ file, x, y, w, h, tilt }, in the page's px and degrees). HQ
//     uploads each (POST /api/sketches/scrap), stripped as the picture is, and kept as sketches/<id>-s-<random>.png|jpg.
//     Review mode sends a page's picture to the Sketchbook too (fromReview): it waits on its sketch until the board
//     places it (waiting).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import sharp from 'sharp';
import { columnsOf, db, once } from './db.ts';
import * as pictures from './pictures.ts';
import * as chat from './chat.ts';
import { keepFile, refuse, reply } from './uploads.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { MAX_POINTS, SAVE_MAX, type Refused, isRefused, pageSide, labelOf, inkOf, pictureOf } from './sketchchecks.ts';
import { BOOK_FULL, GUEST_SPACE, bookFull, books, openRoom, ownerOf, sendAsGuest, spaceAfter } from './sketchpeople.ts';
// prettier-ignore
import { DIR, WAITING_MAX, type Scrap, isScrap, scrapFiles, full, lastOpened, scrapUrl, waitingOf, keepScrap, scrapsOf, sweep } from './sketchscraps.ts';

export { DIR, MAX_POINTS, SAVE_MAX, GUEST_SPACE }; // (MAX_POINTS, SAVE_MAX, GUEST_SPACE)
const BOARD = 'board';
mkdirSync(DIR, { recursive: true, mode: 0o700 });
// (autoincrement: a sketch's number in a line or a job never comes to mean another one once it's deleted)
// picture: its file's name in DIR, or null before anything's drawn. strokes: the ink's count. sent: the last send.
db.exec(`create table if not exists sketches (id integer primary key autoincrement, who text not null default 'board',
  label text not null default '', archived integer not null default 0, created text not null, updated text not null,
  w integer not null, h integer not null, ink text not null default '[]', strokes integer not null default 0,
  picture text, sent text, scraps text not null default '[]', waiting text not null default '[]', opened text)`);
// scraps: the pictures placed on it, a JSON list. waiting: those review mode sent, not placed yet ([{ file }]). opened:
// when HQ last read it whole, for review mode's "the last sketch".
once('sketches-scraps', () => {
  const columns = columnsOf('sketches');
  if (!columns.includes('scraps')) db.exec("alter table sketches add column scraps text not null default '[]'");
  if (!columns.includes('waiting')) db.exec("alter table sketches add column waiting text not null default '[]'");
  if (!columns.includes('opened')) db.exec('alter table sketches add column opened text');
});

type Sketch = {
  id: number;
  who: string;
  label: string;
  archived: number;
  created: string;
  updated: string;
  w: number;
  h: number;
  strokes: number;
  picture: string | null;
  sent: string | null;
  scraps: string;
};
type Refusal = number | [number, string];
// Every column but the ink, which only a drawing reads (and waiting, which only HQ's page reads)
const COLUMNS = 'id, who, label, archived, created, updated, w, h, strokes, picture, sent, scraps';

// ---------------------------------------------------------------- the board's (HQ session, HQ's own Origin)
// Every route below is the board's own book's; an invited person's routes are the same ones with who theirs (guestRoom)
// and their own addresses (base).
// GET /api/sketches: newest drawn first, archived ones too (HQ sorts them apart).:
// and the invited people's, each person's on a shelf of their own ({ name, on: whether they have it now, sketches }), for
// the board to look at
export const listSketches = () => ({ sketches: listed(BOARD).map(s => summary(s)), guests: shelves() });
// GET /api/sketches/ink?id=: one sketch with its strokes, to draw on again, its scraps and those waiting to be placed
// (scraps, waiting, opened)
export function getSketch(id: number, who = BOARD, base = HQ_BASE) {
  const s = row(id, who);
  if (!s) return 404;
  const { ink } = db.prepare('select ink from sketches where id = ?').get(s.id) as { ink: string };
  db.prepare('update sketches set opened = ? where id = ?').run(new Date().toISOString(), s.id);
  const url = (file: string) => scrapUrl(s.id, file, base);
  return {
    ...summary(s, true, base),
    ink: JSON.parse(ink),
    scraps: (JSON.parse(s.scraps) as Scrap[]).map(c => ({ ...c, url: url(c.file) })),
    waiting: waitingOf(s.id).map(c => ({ file: c.file, url: url(c.file) })),
  };
}
// POST /api/sketches/create { label?, w, h }: a blank page, w × h CSS px
export function createSketch(b: any, who = BOARD, base = HQ_BASE): Refusal | ReturnType<typeof summary> {
  const w = pageSide(b?.w),
    h = pageSide(b?.h),
    label = labelOf(b?.label ?? '');
  if (isRefused(w)) return w;
  if (isRefused(h)) return h;
  if (isRefused(label)) return label;
  if (who !== BOARD && bookFull(who)) return [413, BOOK_FULL];
  return summary(row(insertSketch(w, h, label, who), who)!, true, base);
}
// A blank page of who's (the board's), its id (shared with fromReview; who:
function insertSketch(w: number, h: number, label: string, who = BOARD) {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare('insert into sketches (who, label, created, updated, w, h) values (?, ?, ?, ?, ?, ?)')
      .run(who, label, now, now, w, h).lastInsertRowid,
  );
}
// POST /api/sketches/save { id, ink, picture, scraps }: the whole ink, and the page as HQ drew it (a PNG or JPEG data
// URL, or null while nothing's drawn). The old picture goes once the new one is kept.: and the scraps placed on it. Those leave waiting, and scrap files nothing names
// go once they're a day old.
// (an invited person's book takes GUEST_SPACE at most)
export function saveSketch(b: any, who = BOARD, base = HQ_BASE): Refusal | ReturnType<typeof summary> {
  const s = row(Number(b?.id), who);
  if (!s) return 404;
  const ink = inkOf(b.ink);
  if (isRefused(ink)) return ink;
  const scraps = scrapsOf(b.scraps, s.id);
  if (isRefused(scraps)) return scraps;
  // (HQ draws the page whenever anything's on it)
  if (scraps.length && b.picture == null) return [400, 'a sketch with pictures on it has a picture'];
  const drawn = b.picture == null ? null : pictureOf(b.picture);
  if (isRefused(drawn)) return drawn;
  if (who !== BOARD && spaceAfter(s, JSON.stringify(ink).length, drawn) > GUEST_SPACE) return [413, BOOK_FULL];
  const name = drawn && `${s.id}-${randomBytes(4).toString('hex')}.${drawn.type === 'image/png' ? 'png' : 'jpg'}`;
  if (drawn && name) keepFile(`${DIR}/${name}`, drawn.clean);
  const placed = new Set(scraps.map(c => c.file));
  const waiting = waitingOf(s.id).filter(c => !placed.has(c.file));
  db.prepare(
    'update sketches set ink = ?, strokes = ?, picture = ?, scraps = ?, waiting = ?, updated = ? where id = ?',
  ).run(
    JSON.stringify(ink),
    ink.length,
    name,
    JSON.stringify(scraps),
    JSON.stringify(waiting),
    new Date().toISOString(),
    s.id,
  );
  if (s.picture) rmSync(`${DIR}/${s.picture}`, { force: true });
  // A scrap this save takes off the page gets its day from now, not from its upload: undo in an open page may place it again
  const taken = new Date();
  for (const c of JSON.parse(s.scraps) as Scrap[])
    if (!placed.has(c.file)) utimesSync(`${DIR}/${c.file}`, taken, taken);
  sweep(s.id, [...placed, ...waiting.map(c => c.file)]);
  return summary(row(s.id, who)!, true, base);
}
// POST /api/sketches/label { id, label }
export function labelSketch(b: any, who = BOARD, base = HQ_BASE): Refusal | ReturnType<typeof summary> {
  const s = row(Number(b?.id), who);
  if (!s) return 404;
  const label = labelOf(b.label);
  if (isRefused(label)) return label;
  db.prepare('update sketches set label = ? where id = ?').run(label, s.id);
  return summary(row(s.id, who)!, true, base);
}
// POST /api/sketches/archive { id, archived }
export function archiveSketch(b: any, who = BOARD, base = HQ_BASE): Refusal | ReturnType<typeof summary> {
  const s = row(Number(b?.id), who);
  if (!s) return 404;
  if (typeof b.archived !== 'boolean') return [400, 'archived is true or false'];
  db.prepare('update sketches set archived = ? where id = ?').run(Number(b.archived), s.id);
  return summary(row(s.id, who)!, true, base);
}
// POST /api/sketches/delete { id }: the row, its picture and its scraps, gone. A copy it was sent with stays with its
// line.
export function deleteSketch(id: number, who = BOARD) {
  const s = row(id, who);
  if (!s) return 404;
  if (s.picture) rmSync(`${DIR}/${s.picture}`, { force: true });
  for (const file of scrapFiles(s.id)) rmSync(`${DIR}/${file}`, { force: true });
  db.prepare('delete from sketches where id = ?').run(s.id);
  return { ok: true };
}
// POST /api/sketches/send { id }: the sketch to the CEO, as the board's line on the intercom with a copy of its picture
// (an invited person's as their own line, chat.ts fromGuest)
export function sendSketch(id: number, who = BOARD) {
  const s = row(id, who);
  if (!s) return 404;
  if (!s.picture) return [409, "nothing's drawn on this sketch yet"] as Refusal;
  // (the board reads the line in its intercom too: the CEO finds hq sketch in hq's help)
  const name = s.label ? `“${s.label}” (sketch #${s.id})` : `sketch #${s.id}`,
    drawn = readFileSync(`${DIR}/${s.picture}`);
  // (an invited person's: sketchpeople.ts sendAsGuest)
  const copy = who === BOARD ? pictures.keep(drawn).id : sendAsGuest(who, s, name, drawn);
  if (isRefused(copy)) return copy;
  if (who === BOARD) chat.say(`From the Sketchbook: ${name}.`, undefined, undefined, [copy]);
  const sent = new Date().toISOString();
  db.prepare('update sketches set sent = ? where id = ?').run(sent, s.id);
  return { sent, line: pictures.lineOf(copy), picture: copy };
}
// GET /api/sketches/picture?id=<id>[&v=<its file's name>]: never a page on HQ's origin, and never kept in a cache
// (the board sees every book's, a person only their own: who)
export function servePicture(req: IncomingMessage, res: ServerResponse, who: string | null = null) {
  const s = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  if (!s?.picture) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  serveFile(res, s.picture); // (shared with a scrap's)
}
// One of DIR's pictures as the answer: an image or nothing, never kept in a cache.
function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, {
    'content-type': typeOf(file),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  res.end(readFileSync(`${DIR}/${file}`));
}

// ---------------------------------------------------------------- scraps.
// POST /api/sketches/scrap?id=<id>: one picture as the body, as the intercom's are (pictures.ts upload), kept as one of
// the sketch's scraps until a save places it. { file, url }.
// (who, base, and open: whether a person's book is still theirs past the await)
export async function uploadScrap(
  req: IncomingMessage,
  res: ServerResponse,
  who = BOARD,
  base = HQ_BASE,
  open: () => Refused | null = () => null,
) {
  const id = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id'));
  if (!row(id, who)) return refuse(req, res, 404, 'no such sketch');
  if (who !== BOARD && bookFull(who)) return refuse(req, res, 413, BOOK_FULL);
  if (full(id)) return refuse(req, res, 429, TOO_MANY_UPLOADS);
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png') return refuse(req, res, 415, 'a JPEG or PNG only');
  const raw = await readBody(req, pictures.MAX_BYTES);
  if (!raw) return refuse(req, res, 413, 'too large');
  const p = pictures.picture(raw);
  if (!p) return reply(res, 400, { error: 'not a picture we can read' }, true);
  // Again, past the await: the sketch may have been deleted, or filled from another tab, while the body came in
  const shut = open();
  if (shut) return reply(res, shut[0], { error: shut[1] }, true);
  if (!row(id, who)) return reply(res, 404, { error: 'no such sketch' }, true);
  if (full(id)) return reply(res, 429, { error: TOO_MANY_UPLOADS }, true);
  const file = keepScrap(id, p);
  return reply(res, 200, { file, url: scrapUrl(id, file, base) });
}
// GET /api/sketches/scrap?id=<id>&file=<file>: a scrap of the board's sketch, served as its picture is (who as servePicture's)
export function serveScrap(req: IncomingMessage, res: ServerResponse, who: string | null = null) {
  const query = new URL(req.url ?? '/', 'http://x').searchParams;
  const s = row(Number(query.get('id')), who),
    file = query.get('file') ?? '';
  if (!s || !isScrap(s.id, file) || !existsSync(`${DIR}/${file}`)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  serveFile(res, file);
}
const TOO_MANY_UPLOADS = 'too many uploads for this sketch today';
// a page made for review mode's picture: a landscape page about a laptop screen's size, whatever screen it was sent from
const REVIEW_PAGE = { w: 1200, h: 800 };
// A picture review mode sent (feedback.ts /__review/sketch), waiting on a sketch to be placed: the board's last one
// opened ('last', not archived, with room for it), or a new blank page ('new', or none). The bytes are read as an
// upload's are. { id, fresh }: fresh, a page made for it.
export function fromReview(raw: Buffer, to: 'new' | 'last'): Refused | { id: number; fresh: boolean } {
  const p = pictures.picture(raw);
  if (!p) return [400, 'not a picture we can read'];
  const { n } = db
    .prepare('select coalesce(sum(json_array_length(waiting)), 0) n from sketches where who = ?')
    .get(BOARD) as { n: number };
  if (n >= WAITING_MAX)
    return [429, `${WAITING_MAX} pictures are waiting in the Sketchbook already: open their sketches first`];
  const last = to === 'last' ? lastOpened(BOARD) : undefined;
  const id = last && !full(last) ? last : undefined;
  const target = id ?? insertSketch(REVIEW_PAGE.w, REVIEW_PAGE.h, '');
  const file = keepScrap(target, p);
  db.prepare('update sketches set waiting = ?, updated = ? where id = ?').run(
    JSON.stringify([...waitingOf(target), { file }]),
    new Date().toISOString(),
    target,
  );
  return { id: target, fresh: !id };
}

// ---------------------------------------------------------------- agents: hq sketches, hq sketch <id>
// The board's sketches, archived ones (archived) or the rest, without HQ's picture address.: the invited people's too, each with from, their name (null: the board's)
export const listForAgent = (archived: boolean) => ({
  sketches: (db.prepare(`select ${COLUMNS} from sketches order by updated desc, id desc`).all() as Sketch[])
    .filter(s => !!s.archived === archived)
    .map(s => ({ ...summary(s, false), from: ownerOf(s.who) })),
});
export function getForAgent(id: number) {
  const s = row(id, null);
  if (!s) return 404;
  const picture = s.picture && {
    type: typeOf(s.picture),
    data: readFileSync(`${DIR}/${s.picture}`).toString('base64'),
  };
  return { ...summary(s, false), from: ownerOf(s.who), picture: picture || null };
}

// ---------------------------------------------------------------- the voice line's: a call's sketch tool
// POST /api/voice/sketch { call, sketch }: on a live call with the board, one of its sketches for the call's agent
// (hq_tools.py's sketch tool, through the line, which counts the picture against the call's budget), archived ones
// too: by its number ('12', '#12'), or by a few words of its label (each word in it, any case; the latest change of
// those that match with something drawn, the rest named). Its picture is a PNG VOICE_PX on the long side at most: what
// the model sees of a bigger one, and within the API's 2,000 px for a request with over 20 pictures (a walk-through's).
const VOICE_PX = 1568,
  NAMED = 8;
export async function forVoice(b: any) {
  const call = Number(b?.call),
    asked = typeof b?.sketch === 'string' ? b.sketch.trim() : '';
  if (!call || !db.prepare("select 1 from calls where id = ? and status = 'live'").get(call)) return 404;
  if (!asked || asked.length > 200) return [400, "sketch is its number ('12') or a few words of its label"] as Refused;
  const all = listed(BOARD),
    name = (s: Sketch) => `#${s.id}${s.label ? ` “${s.label}”` : ''}`;
  const number = /^#?([0-9]{1,9})$/.exec(asked);
  const words: string[] = asked.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const found = number
    ? all.filter(s => s.id === Number(number[1]))
    : all.filter(s => words.length && words.every(w => s.label.toLowerCase().includes(w)));
  if (!found.length) {
    const some = all.slice(0, NAMED).map(name).join(', ');
    return [
      404,
      `No sketch ${number ? `#${number[1]}` : 'has those words in its label'}. ${some ? `The latest: ${some}.` : 'The Sketchbook is empty.'}`,
    ] as Refused;
  }
  const s = found.find(f => f.picture) ?? found[0];
  if (!s.picture) return [409, `Sketch ${name(s)} has nothing drawn on it yet.`] as Refused;
  const png = await sharp(readFileSync(`${DIR}/${s.picture}`))
    .resize(VOICE_PX, VOICE_PX, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const others = found
    .filter(f => f !== s)
    .slice(0, NAMED)
    .map(name);
  const line = [
    `Sketch ${name(s)}${s.archived ? ' (archived)' : ''}: drawn ${minute(s.created)} UTC, last changed ${minute(s.updated)} UTC${s.sent ? `, last sent to the CEO ${minute(s.sent)} UTC` : ''}.`,
    ...(others.length ? [`Its label's words match ${others.join(', ')} too.`] : []),
  ].join(' ');
  return { picture: { type: 'image/png', data: png.toString('base64') }, line };
}
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');

// ---------------------------------------------------------------- invited people's.
// The board's view of the invited people's books, each on a shelf of its own (sketchpeople.ts books)
const shelves = () => books().map(b => ({ name: b.name, on: b.on, sketches: listed(b.who).map(s => summary(s)) }));
// Their page's routes: the board's own, for their book
openRoom({
  list: (who, base) => ({ sketches: listed(who).map(s => summary(s, true, base)) }),
  get: getSketch,
  picture: servePicture,
  scrap: serveScrap,
  upload: uploadScrap,
  acts: {
    'POST create': createSketch,
    'POST save': saveSketch,
    'POST label': labelSketch,
    'POST archive': archiveSketch,
    'POST delete': (b, who) => deleteSketch(Number(b?.id), who),
    'POST send': (b, who) => sendSketch(Number(b?.id), who),
  },
  saveMax: SAVE_MAX,
});

// ---------------------------------------------------------------- shared
const listed = (who: string) =>
  db.prepare(`select ${COLUMNS} from sketches where who = ? order by updated desc, id desc`).all(who) as Sketch[];
// (who null, any book's: the board's eyes and the agents')
const row = (id: number, who: string | null = BOARD) =>
  (Number.isInteger(id) && id > 0
    ? who === null
      ? db.prepare(`select ${COLUMNS} from sketches where id = ?`).get(id)
      : db.prepare(`select ${COLUMNS} from sketches where id = ? and who = ?`).get(id, who)
    : undefined) as Sketch | undefined;
// HQ's addresses for the board's routes.
const HQ_BASE = '/api/sketches';
// What HQ and the agents read of a sketch. withPicture: HQ's address for its picture (v: the file's name, new at
// every save).
// pictures: how many are placed on it
// base: the routes' addresses, HQ's or a person's on the guest desk
function summary(s: Sketch, withPicture = true, base = HQ_BASE) {
  const { id, label, created, updated, w, h, strokes, sent } = s;
  const placed = (JSON.parse(s.scraps) as unknown[]).length;
  const shown = { id, label, archived: !!s.archived, created, updated, w, h, strokes, pictures: placed, sent };
  if (!withPicture) return shown;
  const picture = s.picture && `${base}/picture?id=${id}&v=${encodeURIComponent(s.picture)}`;
  return { ...shown, picture: picture || null };
}
const typeOf = (file: string) => (file.endsWith('.png') ? 'image/png' : 'image/jpeg');
