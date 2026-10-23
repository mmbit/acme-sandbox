// The photo studio: the board's own photos of the company's real products, made into product shots by an image model
// (imagemodel.ts) that changes the light, background and framing but never the product, and approved by the board
// before anything uses them.
//   - On when brand.yaml has a `studio` block (template/company/brand.yaml): its keeper, model, monthly cap, products
//     and shot styles. Off, HQ shows no Studio app and no darkroom, and every route here answers 404.
//   - The crew decides which photos get made, never the board, and the keeper works only on a shot asked for: whoever
//     owns a page asks for its photo (hq studio request: the product, what the photo must show, the pages it goes on),
//     and the keeper hears at once, as a job. The keeper adds a desk-phone card's product shots for it, the board's
//     photos of the product (hq studio add --request); a check photo (a ruler beside it) never comes in. Each is cut
//     down to what shows the picture (photos.ts: no GPS, no Exif) and goes to the keeper as one job.
//   - The keeper edits each through HQ (the key never leaves it), checks the edit against the original, edits again
//     until the product is exactly as it is, and puts the good ones in the board's batch with what to check on each.
//     What no edit gets right stays with the crew: the keeper drops the photo, or hands the request back to its asker
//     with what it needs. The board never sees a failure.
//   - The board accepts each or sends it back with a comment, one at a time beside its original, seeing the page it
//     goes on and what it must show. Every decision is kept (who, when, the file's sha256): the record that a person
//     checked each photo shows its product as it really is.
//   - Only approved photos reach agents for use (hq studio get), each edit carrying the AI-edit mark in its metadata
//     (shared/provenance). Once the board has approved some, the keeper gets a job to place them, and says where each
//     went (hq studio placed): the board finds an approved photo by its page and says it should change.
//   - Photos added before the board has saved the model's key wait: the keeper's job comes once the key is in (watch).
//   - The keeper may turn the original by quarter turns (a shot the board took sideways: the photo keeps its turn),
//     crop it before the model (it frames the shot) and keep boxes of it, the board's own pixels, pasted back over the
//     edit after (print too small for any model to copy): retouch.ts.
//   - Files live in the coordinator's data volume, never the repo: studio/<photo>/original.jpg|png and <edit>.jpg|png,
//     and <edit>-in.jpg|png, the turned or cropped original that edit came from.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pictureSize } from '../../../shared/pictures/size.ts';
import { markAiEdited } from '../../../shared/provenance/provenance.ts';
import { formats } from '../../../shared/format/format.js';
import { brand, ceo } from './company.ts';
import { DATA_DIR } from './config.ts';
import { columnsOf, db, inOneStep, once } from './db.ts';
import { publish } from './events.ts';
import * as model from './imagemodel.ts';
import * as jobs from './jobs.ts';
import { codeOf, STANDING } from './jobcodes.ts';
import * as photos from './photos.ts';
import { sendToBoard } from './push.ts';
import * as retouch from './retouch.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { keepFile, reply } from './uploads.ts';

export const DIR = `${DATA_DIR}/studio`;
const MAX_NOTE = 200,
  MAX_PLACES = 10,
  MAX_URL = 400,
  MAX_KEEPER_NOTE = 600,
  MAX_EDITS = 8,
  MAX_AT_ONCE = 3,
  MAX_JSON = 256 * 1024, // (a decision on every waiting photo, a few thousand { id, edit })
  // (a request's pages, the keeper's checks for the board and their length, the exact text, the developing jobs a photo
  // outlives before it's dropped)
  MAX_PAGES = 3,
  MAX_CHECKS = 3,
  MAX_CHECK = 90,
  MAX_TEXT = 600,
  MAX_LAPSES = 1;
const WATCH_MS = Number(process.env.STUDIO_WATCH_MS ?? 60_000);
const DEFAULTS = { model: 'gemini-nano-banana-2.1', size: '2K' as model.Size, monthly_usd: 20 };
// The image model's bill: US dollars, and its month on UTC's calendar
const usdFormats = formats({ locales: { en: 'en-US' }, currency: 'USD', timeZone: 'UTC' });
const dollars = (usd: number) => usdFormats.money(Math.round(usd * 100), 'en', { wholeWithoutCents: true });
// What every edit must hold to, whatever the company's shot: the line between a touched-up photo and a misleading one
const RULES = `Edit this photo of a real product into a professional product photo.
Change only the light, the colour balance of the surroundings, the sharpness, the background and setting, the crop and framing, and tidy dust and glare.
Keep the product exactly as it is in the photo: its shape and proportions, its size against everything around it, its colours (a paper's white or cream as it really is), its print and every letter of its text, its material and finish, and any flaw it has. Don't make it look newer, shinier or better made than it is, and add nothing to it or take nothing away from it.
Any prop is plainly scenery (a table, a plant, a book), never anything that could pass for part of the product or something that comes with it.
Add no people, hands, faces or animals, and no other products. A person already in the photo stays exactly as they are.`;

// (failed: the model's error, the keeper's to edit again; stopped: dropped by the crew, out of every list. Neither
// reaches the board)
export type Status =
  'new' | 'editing' | 'edited' | 'waiting' | 'approved' | 'declined' | 'withdrawn' | 'failed' | 'stopped';
type Photo = {
  id: number;
  created: string;
  added_by: string;
  product: string;
  style: string;
  note: string | null;
  asked: string | null;
  status: Status;
  type: string;
  edit: number | null;
  error: string | null;
  develop_job: number | null;
  place_job: number | null;
  edits_from: number | null;
  request: number | null;
  checks: string | null;
  text: string | null;
  lapses: number;
  turn: number;
};
type Request = {
  id: number;
  created: string;
  by: string;
  job: number | null;
  product: string;
  pages: string;
  place: string | null;
  show: string;
  status: 'open' | 'done' | 'returned';
  keeper_job: number | null;
  why: string | null;
};
type Me = { id: number; agent: string };
export class StudioError extends Error {
  status: number;
  constructor(status: number, why: string) {
    super(why);
    this.status = status;
  }
}
const refuse = (status: number, why: string): never => {
  throw new StudioError(status, why);
};

db.exec(`create table if not exists studio_photos (id integer primary key, created text not null, added_by text not null,
  product text not null, style text not null, note text, asked text, status text not null, type text not null,
  edit integer, error text, develop_job integer, place_job integer, edits_from integer, request integer, checks text,
  text text, lapses integer not null default 0, turn integer not null default 0)`);
// (edits_from: the photo's newest edit when the board last sent it back: the edit cap counts the edits after it; turn:
// degrees clockwise, by quarter turns)
// (crop: the original's box the edit was made from, "x,y,w,h"; keep: JSON, the boxes kept and where, or why not;
db.exec(`create table if not exists studio_edits (id integer primary key, photo integer not null, at text not null,
  by text not null, model text not null, size text not null, prompt text not null, usd real not null, type text, failed text,
  crop text, keep text)`);
db.exec(`create table if not exists studio_decisions (id integer primary key, photo integer not null, edit integer not null,
  decision text not null, by text not null, at text not null, sha256 text not null)`);
// (the board's list looks up each photo's edits and decisions: without these, its cost climbs with photos times edits)
db.exec('create index if not exists studio_edits_photo on studio_edits (photo)');
db.exec('create index if not exists studio_decisions_photo on studio_decisions (photo)');
db.exec('create table if not exists studio_jobs (job integer primary key, kind text not null)');
// each withdrawal, apart from what becomes of the photo after it: the edit taken back, the job that placed it, and the
// keeper's job that takes its copies down
db.exec(`create table if not exists studio_takedowns (id integer primary key, photo integer not null, edit integer not null,
  place_job integer, at text not null, job integer)`);
// where the keeper placed each approved edit (a page's address), for the board to find it by
db.exec(`create table if not exists studio_places (photo integer not null, edit integer not null, url text not null,
  at text not null, job integer, primary key (photo, edit, url))`);
// The shots asked for: a page's owner asks (hq studio request), the keeper answers with photos of it, each in the
// board's batch only for an open request. pages: JSON, up to MAX_PAGES addresses, or place, words for where when
// there are more. open, then done (a photo of it placed) or returned (to its asker, with why: what the keeper needs).
// On a photo: its request, the keeper's checks for the board (JSON, a few lines), the product's exact printed text
// for the model (text), and how often its developing job ended before it was done (lapses).
db.exec(`create table if not exists studio_requests (id integer primary key, created text not null, by text not null,
  job integer, product text not null, pages text not null, place text, show text not null, status text not null,
  keeper_job integer, why text, closed text)`);
once('studio-columns', () => {
  const addMissing = (table: string, columns: string[]) => {
    const have = columnsOf(table);
    for (const column of columns)
      if (!have.includes(column.split(' ')[0])) db.exec(`alter table ${table} add column ${column}`);
  };
  addMissing('studio_edits', ['crop text', 'keep text']);
  addMissing('studio_photos', [
    'request integer',
    'checks text',
    'text text',
    'lapses integer not null default 0',
    'turn integer not null default 0',
  ]);
});
// an edit the coordinator was making when it stopped never came back
db.prepare(
  `update studio_photos set status = 'failed', error = 'HQ restarted during the edit: edit it again' where status = 'editing'`,
).run();
mkdirSync(DIR, { recursive: true, mode: 0o700 });

// ---- the company's settings (brand.yaml studio)
type Product = { id: string; name: string; about?: string };
type Style = { id: string; name: string; prompt: string; ratio?: string };
// a fix for a problem that keeps coming back, in the model's words, that the keeper adds to an edit by its id
type Fix = { id: string; name?: string; prompt: string };

export const runs = () => {
  const s = brand().studio;
  return !!s && typeof s === 'object';
};
const keeper = () => String(brand().studio?.keeper ?? ceo());

export function settings() {
  const s = brand().studio;
  if (!s || typeof s !== 'object') return refuse(404, 'the studio is off: the company has no studio settings');
  const products: Product[] = Array.isArray(s.products) ? s.products : [];
  const styles: Style[] = Array.isArray(s.styles) ? s.styles : [];
  const chosen = { model: String(s.model ?? DEFAULTS.model), size: (s.size ?? DEFAULTS.size) as model.Size };
  if (!model.MODELS.includes(chosen.model) || !model.SIZES.includes(chosen.size))
    refuse(
      500,
      `the studio's settings name a model or size HQ doesn't know (models: ${model.MODELS.join(', ')}; sizes: ${model.SIZES.join(', ')})`,
    );
  const notes: string[] = (Array.isArray(s.notes) ? s.notes : []).map(String);
  const fixes: Fix[] = Array.isArray(s.fixes) ? s.fixes : [];
  return {
    keeper: keeper(),
    ...chosen,
    monthlyUsd: Number(s.monthly_usd ?? DEFAULTS.monthly_usd),
    products,
    styles,
    fixes,
    notes,
  };
}
type Settings = ReturnType<typeof settings>;
const nameOf = (list: { id: string; name: string }[], id: string) => list.find(x => x.id === id)?.name ?? id;

// ---- the photos and their files
const photo = (id: number) => db.prepare('select * from studio_photos where id = ?').get(id) as Photo | undefined;
const ext = (type: string) => (type === 'image/png' ? 'png' : 'jpg');
const originalFile = (p: Photo) => `${DIR}/${p.id}/original.${ext(p.type)}`;
const editFile = (p: Photo, edit: number) => {
  const e = db.prepare('select type from studio_edits where id = ?').get(edit) as { type: string };
  return `${DIR}/${p.id}/${edit}.${ext(e.type)}`;
};
// the original as it went to the model for that edit, when the keeper cropped or turned it
const inputFile = (p: Photo, edit: number) => `${DIR}/${p.id}/${edit}-in.${ext(p.type)}`;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const oneLine = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\p{C}\s]+/gu, ' ')
    .trim()
    .slice(0, max) || null;

// The board's own words on a photo (a comment, what should change), whole, its line breaks kept: only the request's
// size (MAX_JSON, readJsonBody) bounds them
const boardNote = (v: unknown) => {
  const lines = String(v ?? '')
    .split(/\r\n?|\n/)
    .map(line => line.replace(/[\p{C}\s]+/gu, ' ').trim());
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || null
  );
};

// The product's printed text, one line: refused when too long, never cut, for the model is told it is exact
const exactText = (v: unknown) => {
  const text = oneLine(v, MAX_TEXT + 1);
  if (text && text.length > MAX_TEXT) refuse(400, `--text takes ${MAX_TEXT} characters at most: it is the exact print`);
  return text;
};

// (a photo answers its request, for its product)
type Adding = { request: Request; style: string; note: string | null; text: string | null; by: string };
function addPhoto(picture: Buffer, type: string, { request, style, note, text, by }: Adding) {
  const s = settings();
  if (!s.styles.some(t => t.id === style)) refuse(400, `no shot style "${style}" in the studio's settings`);
  const clean = type === 'image/png' ? photos.stripPng(picture) : photos.stripJpeg(picture);
  if (!clean) refuse(400, 'not a picture HQ can read');
  const { lastInsertRowid } = db
    .prepare(
      `insert into studio_photos (created, added_by, product, style, note, status, type, request, text)
    values (?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
    )
    .run(new Date().toISOString(), by, request.product, style, note, type, request.id, text);
  const id = Number(lastInsertRowid);
  keepFile(originalFile(photo(id)!), clean!);
  return id;
}

// ---- the board's Studio app (HQ's session, HQ's own origin): GET /api/studio and what's under it
export async function board(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x'),
    key = `${req.method} ${url.pathname}`,
    q = url.searchParams;
  try {
    if (key === 'GET /api/studio/original' || key === 'GET /api/studio/edited')
      return sendPicture(
        res,
        key.endsWith('original') ? 'original' : 'edited',
        Number(q.get('id')),
        Number(q.get('edit')),
      );
    const body = req.method === 'POST' ? await readJsonBody(req) : null;
    if (key === 'GET /api/studio') return await reply(res, 200, boardView());
    if (key === 'POST /api/studio/decide')
      return await reply(res, 200, { decided: decide(body.photos, String(body.decision), 'board', body.note) });
    if (key === 'POST /api/studio/reject') return await reply(res, 200, reject(body.photo, body.note));
    if (key === 'POST /api/studio/change') return await reply(res, 200, change(body.photo, body.note));
    return await reply(res, 404, { error: 'not found' });
  } catch (err) {
    if (!(err instanceof StudioError)) throw err;
    await reply(res, err.status, { error: err.message }, true);
    req.destroy();
  }
}

async function readJsonBody(req: IncomingMessage) {
  const raw = await readBody(req, MAX_JSON);
  if (!raw) return refuse(413, 'too large');
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return refuse(400, 'json body');
  }
}

// (what the board sees of each photo: the page it's for and what it must show, the keeper's checks; never a failure,
// a style or the crew's own notes.)
function boardView() {
  const s = settings(),
    month = spend();
  // (every photo the app draws: in the darkroom, waiting, approved; the rest stay with the crew, or in the record
  // alone)
  const list = db
    .prepare(
      `select * from studio_photos where status in ('new', 'editing', 'edited', 'waiting', 'approved') order by id desc`,
    )
    .all() as Photo[];
  return {
    key: model.hasKey(),
    keeper: s.keeper,
    month: { edits: month.edits, usd: Math.round(month.usd * 100) / 100 },
    products: s.products.map(({ id, name }) => ({ id, name })),
    photos: list.map(p => ({
      id: p.id,
      product: p.product,
      request: requestView(p.request),
      checks: checksOf(p),
      status: p.status,
      created: p.created,
      edit: p.edit,
      edited: p.edit ? editedAt(p.edit) : null,
      tries: tries(p.id),
      decided: lastDecision(p.id),
      places: p.status === 'approved' ? placesOf(p.id, p.edit) : [],
    })),
  };
}
const placesOf = (photo: number, edit: number | null) =>
  (
    db.prepare('select url from studio_places where photo = ? and edit = ? order by at').all(photo, edit) as {
      url: string;
    }[]
  ).map(x => x.url);
const editedAt = (edit: number) =>
  (db.prepare('select at from studio_edits where id = ?').get(edit) as { at: string }).at;
const tries = (id: number) =>
  (db.prepare('select count(*) as n from studio_edits where photo = ?').get(id) as { n: number }).n;
// (the cap's count: the edits since the board's last Send back or Reject)
const triesSinceRetry = (p: Photo) =>
  (
    db.prepare('select count(*) as n from studio_edits where photo = ? and id > ?').get(p.id, p.edits_from ?? 0) as {
      n: number;
    }
  ).n;
const lastDecision = (id: number) =>
  (db.prepare('select decision, by, at from studio_decisions where photo = ? order by id desc limit 1').get(id) as
    { decision: string; by: string; at: string } | undefined) ?? null;

// A picture for the app. An original never changes, nor an edit's file under its id, so the board's own browser keeps
// each a day rather than fetch megabytes on every redraw. An edit is asked for with &edit=<id>: the photo's current
// one, or one the board decided on (kept with its record). The original with &edit=<id> is the one that edit came from:
// the keeper's crop or turn of it, if any.
function sendPicture(res: ServerResponse, which: 'original' | 'edited', id: number, edit: number) {
  const p = photo(id),
    shown =
      p && (edit === p.edit || db.prepare('select 1 from studio_decisions where photo = ? and edit = ?').get(id, edit)),
    cropped = shown && existsSync(inputFile(p, edit)) ? inputFile(p, edit) : null,
    file = p && (which === 'original' ? (cropped ?? originalFile(p)) : shown ? editFile(p, edit) : null);
  if (!file || !existsSync(file)) return reply(res, 404, { error: 'no such picture' });
  const bytes = readFileSync(file);
  res.writeHead(200, {
    'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg',
    'content-length': bytes.length,
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
}

// The board's approve or decline of photos in its batch, or its withdrawal of approved ones: the number decided.
// Each decision is kept with the sha256 of the very file it was about. The board's comment on an approval goes to the
// keeper with the photo (asked, in the placing job's brief).
// Each photo comes with the edit the board saw: one that has a newer edit since refuses the whole decision, so the
// board decides on the very file it looked at.
export function decide(seen: unknown, decision: string, by: string, note?: unknown) {
  if (!['approved', 'declined', 'withdrawn'].includes(decision))
    refuse(400, 'decision: approved, declined or withdrawn');
  if (!Array.isArray(seen) || !seen.length) refuse(400, 'photos: one or more, each { id, edit }');
  const from = decision === 'withdrawn' ? 'approved' : 'waiting',
    at = new Date().toISOString();
  const list = (seen as { id: unknown; edit: unknown }[]).map(x => ({
    id: Number(x?.id),
    p: photo(Number(x?.id)),
    edit: Number(x?.edit),
  }));
  // (one decided on another device, or taken back to the darkroom, refuses the whole decision too)
  const gone = list.find(({ p }) => p?.status !== from || !p.edit);
  if (gone) refuse(409, `photo #${gone.id} isn't ${from} any more: look at it again`);
  const changed = list.find(({ p, edit }) => p!.edit !== edit);
  if (changed) refuse(409, `photo #${changed.p!.id} has a new edit since you looked: look at it again`);
  const record = db.prepare(
    'insert into studio_decisions (photo, edit, decision, by, at, sha256) values (?, ?, ?, ?, ?, ?)',
  );
  const comment = boardNote(note);
  let decided = 0;
  for (const { p } of list as { p: Photo & { edit: number } }[]) {
    record.run(p.id, p.edit, decision, by, at, sha256(editFile(p, p.edit)));
    if (decision === 'withdrawn')
      db.prepare('insert into studio_takedowns (photo, edit, place_job, at) values (?, ?, ?, ?)').run(
        p.id,
        p.edit,
        p.place_job,
        at,
      );
    db.prepare('update studio_photos set status = ? where id = ?').run(decision, p.id);
    if (decision === 'approved' && comment)
      db.prepare('update studio_photos set asked = ? where id = ?').run(comment, p.id);
    decided++;
  }
  if (decided && decision === 'approved') keeperJob('place');
  if (decided && decision === 'withdrawn') keeperJob('remove');
  if (decided) officeChanged();
  return decided;
}

// Back to the keeper, with what to put right: what the board's Reject and "this should change" decided (declined,
// withdrawn), its note already the board's words (boardNote). A failed photo has no such way back: failures stay with
// the crew.
function backToKeeper(id: number, note: string | null) {
  const p = photo(id);
  if (!p || !['declined', 'withdrawn'].includes(p.status))
    refuse(409, 'that photo is with the keeper already, or approved');
  db.prepare(
    `update studio_photos set status = 'new', asked = ?, error = null, develop_job = null, place_job = null, lapses = 0,
    edits_from = (select max(id) from studio_edits where photo = studio_photos.id)
    where id = ?`,
  ).run(note, id);
  // (a photo taken off its page leaves the page asking again)
  db.prepare(`update studio_requests set status = 'open', closed = null where id = ? and status = 'done'`).run(
    p!.request,
  );
  keeperJob('develop');
  officeChanged();
  return { ok: true };
}

// The board's Reject of a waiting photo it saw ({ id, edit }): declined, in the record as any decision, and back to the
// keeper with the board's comment, in one step
function reject(seen: unknown, note: unknown) {
  const words = boardNote(note);
  return inOneStep(() => {
    decide([seen], 'declined', 'board');
    return backToKeeper(Number((seen as { id?: unknown })?.id), words);
  });
}

// The board's "this should change" on an approved photo it saw ({ id, edit }): it comes off the sites (a withdrawal,
// the keeper's take-down job) and goes back to the keeper with the board's note, for a new edit to approve
function change(seen: unknown, note: unknown) {
  const reason = boardNote(note);
  if (!reason) refuse(400, 'say what should change');
  const id = Number((seen as { id?: unknown })?.id);
  return inOneStep(() => {
    // (the note first: the take-down job's brief, written as the withdrawal queues it, carries it too)
    db.prepare(`update studio_photos set asked = ? where id = ? and status = 'approved'`).run(reason, id);
    decide([seen], 'withdrawn', 'board');
    return backToKeeper(id, reason);
  });
}

// ---- the agents' side (hq studio)
const isKeeper = (me: Me) => me.agent === settings().keeper || me.agent === ceo();
const keeperOnly = (me: Me) => {
  if (!isKeeper(me)) refuse(403, `only the studio's keeper (${settings().keeper}) does this`);
};

// ---- the shots asked for
const request = (id: number) => db.prepare('select * from studio_requests where id = ?').get(id) as Request | undefined;
const pagesOf = (r: Request) => JSON.parse(r.pages) as string[];
// where a request's photo goes, as the board and the briefs say it: its pages, or the asker's words for many
const whereOf = (r: Request) => (r.place ?? pagesOf(r).join(', ')) || 'no page given';
function openRequest(id: unknown) {
  const r = request(Number(id));
  if (!r) refuse(400, 'say which shot request it answers: --request <id> (hq studio lists the open ones)');
  if (r!.status !== 'open') refuse(409, `request #${r!.id} is ${r!.status}: only an open request takes photos`);
  return r!;
}

// hq studio request: whoever owns a page asks for its photo: the product, what it must show, and the pages it goes on
// (or, for many, words for where). The keeper hears at once (its job), and answers with photos of it; it never asks
// itself, so nothing reaches the board's batch that no page needs.
export function requestForAgent(b: any, me: Me) {
  const s = settings(),
    product = String(b.product ?? ''),
    show = oneLine(b.show, MAX_NOTE),
    place = oneLine(b.where, MAX_NOTE),
    pages: string[] = (Array.isArray(b.pages) ? b.pages : []).map(String);
  if (me.agent === s.keeper)
    refuse(
      403,
      "the keeper answers shot requests: a page's owner asks for its photo (Growth, or whoever runs the page)",
    );
  if (!s.products.some(p => p.id === product))
    refuse(400, `no product "${oneLine(product, 40)}" in the studio's settings (hq studio lists them)`);
  if (!show) refuse(400, 'say what the photo must show: --show "..."');
  if (!pages.length && !place) refuse(400, 'say where it goes: --page <address> (up to 3), or --where "..." for more');
  if (pages.length > MAX_PAGES) refuse(400, `${MAX_PAGES} pages at most: for more, --where "..." says which`);
  const bad = pages.find(u => !isPage(u));
  if (bad !== undefined) refuse(400, `not a page's address (https://...): ${oneLine(bad, 80)}`);
  const { lastInsertRowid } = db
    .prepare(
      `insert into studio_requests (created, by, job, product, pages, place, show, status)
      values (?, ?, ?, ?, ?, ?, ?, 'open')`,
    )
    .run(
      new Date().toISOString(),
      me.agent,
      me.id || null,
      product,
      JSON.stringify(pages.map(u => new URL(u).href)),
      pages.length ? null : place,
      show,
    );
  keeperJob('request');
  return { id: Number(lastInsertRowid), keeper: s.keeper };
}

// hq studio return <request> --need: a shot the keeper can't make work goes back to whoever asked, with what it needs
// (a new test print, a page that shows it some other way): a job for them. Its photos still in hand are dropped.
export function returnForAgent(b: any, me: Me) {
  keeperOnly(me);
  const r = openRequest(b.id),
    need = oneLine(b.need, MAX_KEEPER_NOTE);
  if (!need) refuse(400, 'say what you need to make it work: --need "..."');
  const at = new Date().toISOString(),
    product = nameOf(settings().products, r.product);
  inOneStep(() => {
    db.prepare(`update studio_requests set status = 'returned', why = ?, closed = ? where id = ?`).run(need, at, r.id);
    db.prepare(
      `update studio_photos set status = 'stopped', error = ? where request = ? and status in ('new', 'edited', 'waiting', 'failed')`,
    ).run(`its request went back to ${r.by}: ${need}`, r.id);
  });
  const job = jobs.createJob({
    agent: r.by,
    code: r.job ? (codeOf(r.job) ?? undefined) : undefined, // (the asking task's code, jobcodes.ts.)
    title: `Studio: the photo you asked for (${product}) needs something first`,
    prompt: `${me.agent}, who keeps the photo studio, can't make the photo you asked for work as it stands (shot request #${r.id}: ${product}, for ${whereOf(r)}, showing "${r.show}").

What it needs: ${need}

Sort that out, or decide the page goes without this photo for now. Then ask again with \`hq studio request\` (the keeper hears at once). Nothing about it goes to the board unless the board has to decide something: a card of its own, then.`,
    queuedBy: me.agent,
  }).id;
  officeChanged();
  return { returned: r.id, job };
}

// What the board sees of a photo's request: the pages it goes on (or the words for where) and what it must show
const requestView = (id: number | null) => {
  const r = id ? request(id) : undefined;
  return r ? { id: r.id, pages: pagesOf(r), where: r.place, show: r.show } : null;
};
const checksOf = (p: Photo) => (p.checks ? (JSON.parse(p.checks) as string[]) : []);

export function listForAgent() {
  const s = settings(),
    list = db
      .prepare(`select * from studio_photos where status not in ('declined', 'withdrawn', 'stopped') order by id`)
      .all() as Photo[],
    open = db.prepare(`select * from studio_requests where status = 'open' order by id`).all() as Request[];
  return {
    keeper: s.keeper,
    key: model.hasKey(),
    model: s.model,
    size: s.size,
    month: { ...spend(), cap_usd: s.monthlyUsd },
    products: s.products,
    styles: s.styles.map(({ id, name }) => ({ id, name })),
    fixes: s.fixes.map(({ id, name }) => ({ id, name: name ?? id })),
    requests: open.map(r => ({
      id: r.id,
      product: r.product,
      by: r.by,
      where: whereOf(r),
      show: r.show,
      created: r.created,
    })),
    photos: list.map(p => ({
      id: p.id,
      request: p.request,
      product: p.product,
      style: p.style,
      status: p.status,
      note: p.note,
      text: p.text,
      turn: p.turn,
      asked: p.asked,
      checks: checksOf(p),
      tries: tries(p.id),
      error: p.error,
      created: p.created,
      added_by: p.added_by,
    })),
  };
}

// hq studio add: a desk-phone card's product shots (one field, or every saved one) into the studio, for an open
// request. Never a customer's card: its photos hold their details, and the studio sends them to the image model. The
// keeper may add any other card's; anyone else the cards they could read anyway.
export function addFromCard(b: any, me: Me) {
  const card = Number(b.card),
    access = jobs.cardAccess(card, me);
  if (access !== true && !(isKeeper(me) && !jobs.customerCard(card) && photos.forWorker(card) !== 404)) return access;
  if (jobs.customerCard(card))
    refuse(403, "a customer's card holds their details: its photos never go to the image model");
  const listed = photos.forWorker(card);
  if (listed === 404) return 404;
  const request = openRequest(b.request),
    wanted = listed.filter(f => f.saved && (b.field == null || f.field === Number(b.field))),
    shots = wanted.filter(f => f.shot === 'product');
  if (!wanted.length) refuse(404, 'no saved photo on that card (or in that field)');
  // (a check photo, taken with a ruler for us to judge a print, never goes to the model)
  if (!shots.length)
    refuse(
      409,
      `${b.field == null ? 'no product shot on that card' : 'that field is a check photo, not a product shot'}: only a card's product shots (hq ask --product-shot) come in`,
    );
  const text = exactText(b.text);
  const ids = shots.map(f =>
    addPhoto(readFileSync(photos.fileFor(card, f.field)!), f.type!, {
      request,
      style: String(b.style),
      note: oneLine(b.note, MAX_NOTE) ?? oneLine(f.label, MAX_NOTE),
      text,
      by: me.agent,
    }),
  );
  keeperJob('develop');
  officeChanged();
  return { ids };
}

// hq studio original|edited <id>: the keeper's look at a photo; hq studio get <id>: an approved one, for any agent to
// use
export async function pictureForAgent(b: any, me: Me, which: unknown) {
  if (which !== 'original' && which !== 'edited' && which !== 'approved')
    refuse(400, 'which: original, edited or approved');
  const p = photo(Number(b.id));
  if (!p) return 404;
  if (which !== 'approved') keeperOnly(me);
  if (which === 'approved' && p.status !== 'approved')
    refuse(403, `photo #${p.id} isn't approved by the board (it's ${p.status}): only approved photos may be used`);
  const file = which === 'original' ? originalFile(p) : p.edit ? editFile(p, p.edit) : null;
  if (!file) refuse(404, `photo #${p.id} has no edit yet`);
  // (the original as the model gets it, turned: the keeper's boxes are in its pixels; --turn shows it another way
  // first, the photo's own unchanged)
  const decision = which === 'approved' ? lastDecision(p.id) : null,
    turn = which === 'original' ? turnOf(b, p) : 0,
    bytes = turn ? await retouch.framed(readFileSync(file!), p.type, turn, null) : readFileSync(file!);
  return {
    type: file!.endsWith('.png') ? 'image/png' : 'image/jpeg',
    data: bytes.toString('base64'),
    product: p.product,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(turn ? { turn } : {}),
    ...(decision ? { approved: decision } : {}),
  };
}

// hq studio edit <id> [--note] [--turn] [--crop] [--keep...]: the image model edits the original (turned, or the
// keeper's crop of it) now, the boxes kept pasted back over its answer; the keeper looks at the result
const editing = new Set<number>();
export async function editForAgent(b: any, me: Me) {
  keeperOnly(me);
  const s = settings(),
    p = photo(Number(b.id));
  if (!p) return 404;
  refuseUnlessEditable(p);
  const usd = priceWithinCap(s),
    original = readFileSync(originalFile(p)),
    turn = turnOf(b, p),
    framing = framingOf(b, original, turn),
    fixes = fixesOf(s, b.fixes),
    shot = restyled(s, p, b, turn),
    prompt = promptFor(s, shot, oneLine(b.note, MAX_KEEPER_NOTE), fixes);
  editing.add(p.id);
  db.prepare(`update studio_photos set status = 'editing', error = null where id = ?`).run(p.id);
  officeChanged();
  const crop = framing.crop && retouch.boxText(framing.crop),
    record = db.prepare(`insert into studio_edits (photo, at, by, model, size, prompt, usd, type, failed, crop, keep)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    const input = framing.crop || turn ? await retouch.framed(original, p.type, turn, framing.crop) : original;
    const out = await model.edit({
      model: s.model,
      size: s.size,
      ratio: ratioFor(s, shot, input),
      prompt,
      picture: input,
      type: p.type,
    });
    const type = out.type === 'image/png' ? 'image/png' : 'image/jpeg',
      { picture, kept } = await keptIn(framing, input, out.picture, type),
      marked = markAiEdited(picture);
    const keptText = kept.length ? JSON.stringify(kept) : null,
      at = new Date().toISOString();
    const edit = Number(
      record.run(p.id, at, me.agent, s.model, s.size, prompt, usd, type, null, crop, keptText).lastInsertRowid,
    );
    takeEdit(p, edit, marked, input === original ? null : input, me.id || p.develop_job);
    return { id: p.id, edit, type, data: marked.toString('base64'), usd, month: spend(), turn, crop, kept };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err),
      billed = err instanceof model.ImageModelError && !err.billed ? 0 : usd;
    record.run(p.id, new Date().toISOString(), me.agent, s.model, s.size, prompt, billed, null, why, crop, null);
    db.prepare(`update studio_photos set status = 'failed', error = ? where id = ?`).run(why, p.id);
    return refuse(502, `photo #${p.id}: ${why}`);
  } finally {
    editing.delete(p.id);
    officeChanged();
  }
}

// Whether the photo can go to the model now: a status it edits from, the model's key, its tries since the board last sent
// it, and room among the edits in the model at once
function refuseUnlessEditable(p: Photo) {
  if (!['new', 'edited', 'waiting', 'failed'].includes(p.status))
    refuse(409, `photo #${p.id} is ${p.status}: nothing to edit`);
  if (!model.hasKey()) refuse(409, "the studio's image model has no key yet: the board adds it on the desk phone");
  if (triesSinceRetry(p) >= MAX_EDITS)
    refuse(
      429,
      `photo #${p.id} has had ${MAX_EDITS} edits since the board last sent it: drop it (hq studio stop), or hand its request back with what you need (hq studio return)`,
    );
  if (editing.size >= MAX_AT_ONCE)
    refuse(429, `${MAX_AT_ONCE} edits are already in the model: wait for one to come back`);
}

// What the edit costs, refused when it would take this month's edits past the studio's cap
function priceWithinCap(s: Settings) {
  const usd = model.price(s.model, s.size),
    month = spend();
  // (the edits in the model now count too: their rows come when they return)
  if (month.usd + (editing.size + 1) * usd > s.monthlyUsd)
    refuse(
      429,
      `this month's edits have cost ${dollars(month.usd)} of the studio's ${dollars(s.monthlyUsd)} cap: the next month starts on the 1st (UTC)`,
    );
  return usd;
}

// The edit back from the model becomes the photo's, kept with the turned or cropped input it was given (`framed`; stopped,
// if its request went back while the edit was in the model), and the edit it had goes unless the keeper decided on it
function takeEdit(p: Photo, edit: number, marked: Buffer, framed: Buffer | null, job: number | null) {
  const before = p.edit;
  keepFile(editFile(p, edit), marked);
  if (framed) keepFile(inputFile(p, edit), framed);
  // (the job that edits it has it now, not one on a call (0): an ended job's photos go back to the keeper, watch().

  db.prepare(
    `update studio_photos set edit = ?, develop_job = ?,
    status = case when (select status from studio_requests where id = request) = 'returned' then 'stopped' else 'edited' end,
    error = case when (select status from studio_requests where id = request) = 'returned'
      then 'its request went back to its asker while the edit was in the model' end
    where id = ?`,
  ).run(edit, job, p.id);
  if (before && !db.prepare('select 1 from studio_decisions where edit = ?').get(before))
    for (const file of [editFile(p, before), inputFile(p, before)]) rmSync(file, { force: true });
}

// The keeper's --style, --text and --turn for this edit and the ones after it: the photo takes them on
function restyled(s: Settings, p: Photo, b: any, turn: number) {
  const style = b.style == null ? p.style : String(b.style),
    text = b.text == null ? p.text : exactText(b.text);
  if (!s.styles.some(t => t.id === style))
    refuse(400, `no shot style "${oneLine(style, 40)}" in the studio's settings`);
  db.prepare('update studio_photos set style = ?, text = ?, turn = ? where id = ?').run(style, text, turn, p.id);
  return { ...p, style, text, turn };
}
// --turn: degrees clockwise from the board's original, by quarter turns; the photo's own turn without it
function turnOf(b: any, p: Photo) {
  if (b.turn == null) return p.turn;
  const turn = Number(b.turn);
  return [0, 90, 180, 270].includes(turn) && /^\d+$/.test(String(b.turn).trim())
    ? turn
    : refuse(
        400,
        `--turn takes 90, 180 or 270, degrees clockwise (0: as the board took it), not "${oneLine(b.turn, 20)}"`,
      );
}
// The fixes the keeper named for this edit, from the studio's settings
function fixesOf(s: Settings, ids: unknown) {
  return (Array.isArray(ids) ? ids : []).map(id => {
    const fix = s.fixes.find(f => f.id === String(id));
    return fix ?? refuse(400, `no fix "${oneLine(id, 40)}" in the studio's settings (hq studio lists them)`);
  });
}

// The keeper's --crop and --keep boxes, in the original's own pixels as turned: the crop within the photo, each kept
// box within the crop
function framingOf(b: any, original: Buffer, turn: number) {
  const size = pictureSize(original) ?? refuse(400, 'a picture without its size'),
    { width, height } = turn % 180 ? { width: size.height, height: size.width } : size,
    whole = { x: 0, y: 0, w: width, h: height },
    boxOf = (v: unknown, flag: string) =>
      retouch.boxFrom(v) ??
      refuse(400, `${flag} takes x,y,w,h in the original's own pixels (hq studio original), not "${oneLine(v, 40)}"`);
  const crop = b.crop == null ? null : boxOf(b.crop, '--crop'),
    frame = crop ?? whole;
  if (crop && !retouch.inside(crop, whole))
    refuse(400, `--crop ${retouch.boxText(crop)} goes past the original, ${width} × ${height}`);
  if (b.keep != null && !Array.isArray(b.keep)) refuse(400, '--keep takes boxes: x,y,w,h');
  const keeps = (b.keep ?? []).map((v: unknown) => {
    const box = boxOf(v, '--keep');
    if (!retouch.inside(box, frame))
      refuse(
        400,
        `--keep ${retouch.boxText(box)} goes past the ${crop ? 'crop' : 'original'}, ${retouch.boxText(frame)}`,
      );
    return box;
  }) as retouch.Box[];
  return { crop, keeps };
}

// The kept boxes found in the model's edit and pasted over it, each said as the keeper gave it (the original's pixels)
async function keptIn(framing: ReturnType<typeof framingOf>, input: Buffer, edit: Buffer, type: string) {
  if (!framing.keeps.length) return { picture: edit, kept: [] };
  const { x = 0, y = 0 } = framing.crop ?? {},
    inInput = framing.keeps.map(k => ({ ...k, x: k.x - x, y: k.y - y })),
    retouched = await retouch.keepBoxes(input, edit, type, inInput);
  return { ...retouched, kept: retouched.kept.map((k, i) => ({ ...k, box: framing.keeps[i] })) };
}

// hq studio ready <id>... --check "..."...: edited photos into the board's batch, each with the few things the board
// should check on it (the same for each id given), and only for an open request; the board hears once per batch
export function readyForAgent(b: any, me: Me) {
  keeperOnly(me);
  const ids: number[] = (Array.isArray(b.ids) ? b.ids : []).map(Number),
    checks = (Array.isArray(b.checks) ? b.checks : []).map((c: unknown) => oneLine(c, MAX_CHECK + 1)).filter(Boolean);
  const long = checks.find((c: string) => c.length > MAX_CHECK);
  if (long) refuse(400, `a check is ${MAX_CHECK} characters at most, to read at a glance: "${long}"`);
  if (!checks.length || checks.length > MAX_CHECKS)
    refuse(400, `give the board 1 to ${MAX_CHECKS} things to check on it, each a short line: --check "..."`);
  const unasked = ids.find(id => photo(id)?.status === 'edited' && request(photo(id)!.request ?? 0)?.status !== 'open');
  if (unasked !== undefined)
    refuse(409, `photo #${unasked} answers no open shot request: nothing reaches the board unless a page needs it`);
  const moved = ids.filter(id => photo(id)?.status === 'edited');
  if (!moved.length) refuse(409, 'none of those photos is edited and waiting for your check');
  for (const id of moved)
    db.prepare(`update studio_photos set status = 'waiting', asked = null, checks = ? where id = ?`).run(
      JSON.stringify(checks),
      id,
    );
  const waiting = (
    db.prepare(`select count(*) as n from studio_photos where status = 'waiting'`).get() as { n: number }
  ).n;
  sendToBoard({
    title: 'Studio',
    body: `${waiting} ${waiting === 1 ? 'photo waits' : 'photos wait'} for your look`,
    tag: 'studio',
    url: '/?open=studio',
  }).catch(err => console.error('Could not tell the board about the studio batch:', err));
  officeChanged();
  return { ready: moved, waiting };
}

// hq studio stop <id> --why: the keeper drops a photo no edit gets right, its reason kept; it never reaches the board.
// Its request stays open for another photo, or goes back to its asker (hq studio return).
export function stopForAgent(b: any, me: Me) {
  keeperOnly(me);
  const p = photo(Number(b.id)),
    why = oneLine(b.why, MAX_KEEPER_NOTE);
  if (!p) return 404;
  if (!why) refuse(400, 'say why: --why "..."');
  if (!['new', 'edited', 'failed'].includes(p.status)) refuse(409, `photo #${p.id} is ${p.status}: not yours to stop`);
  db.prepare(`update studio_photos set status = 'stopped', error = ? where id = ?`).run(why, p.id);
  officeChanged();
  return { ok: true };
}

// hq studio placed <id> <url>...: the pages the keeper placed an approved photo on, each by its address, so the board
// finds it by its page (its History) and can say it should change
export function placedForAgent(b: any, me: Me) {
  keeperOnly(me);
  const p = photo(Number(b.id));
  if (!p) return 404;
  if (p.status !== 'approved') refuse(409, `photo #${p.id} is ${p.status}: only an approved photo is placed`);
  const urls: string[] = (Array.isArray(b.urls) ? b.urls : []).map(String);
  if (!urls.length || urls.length > MAX_PLACES) refuse(400, `one to ${MAX_PLACES} page addresses`);
  const bad = urls.find(u => !isPage(u));
  if (bad !== undefined) refuse(400, `not a page's address (https://...): ${oneLine(bad, 80)}`);
  const at = new Date().toISOString(),
    add = db.prepare('insert or ignore into studio_places (photo, edit, url, at, job) values (?, ?, ?, ?, ?)');
  for (const url of urls) add.run(p.id, p.edit, new URL(url).href, at, me.id || null);
  // (its request is answered)
  db.prepare(`update studio_requests set status = 'done', closed = ? where id = ? and status = 'open'`).run(
    at,
    p.request,
  );
  return { places: placesOf(p.id, p.edit) };
}
function isPage(url: string) {
  if (url.length > MAX_URL) return false;
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

// hq studio record: every decision, oldest first: our record of who checked which file, and when
export const record = () => ({
  decisions: db
    .prepare(
      `select d.photo, p.product, p.style, d.decision, d.by, d.at, d.sha256,
  e.model from studio_decisions d join studio_photos p on p.id = d.photo join studio_edits e on e.id = d.edit order by d.id`,
    )
    .all(),
});

// ---- the edit's prompt and shape
// (the product's exact printed text and the keeper's named fixes)
function promptFor(s: Settings, p: Photo, keeperNote: string | null, fixes: Fix[] = []) {
  const product = s.products.find(x => x.id === p.product),
    style = s.styles.find(x => x.id === p.style);
  return [
    RULES,
    `The product: ${product?.name ?? p.product}.${product?.about ? ` ${product.about}` : ''}`,
    `The shot: ${style?.prompt ?? p.style}`,
    p.text &&
      `The text printed on the product reads exactly as follows, character for character (" / " marks a new line): ${p.text}. Every letter, digit and mark of it stays exactly so in the photo.`,
    p.note && `About this photo: ${p.note}`,
    ...fixes.map(f => f.prompt),
    p.asked && `Put this right from the last try: ${p.asked}`,
    keeperNote && `Also: ${keeperNote}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// The style's ratio, or the supported one nearest the photo's own
function ratioFor(s: Settings, p: Photo, original: Buffer) {
  const own = s.styles.find(x => x.id === p.style)?.ratio;
  if (own && model.RATIOS.includes(own)) return own;
  const { width, height } = pictureSize(original) ?? refuse(400, 'a picture without its size'),
    value = (r: string) => {
      const [w, h] = r.split(':').map(Number);
      return w / h;
    };
  return model.RATIOS.reduce((best, r) =>
    Math.abs(Math.log(value(r) / (width / height))) < Math.abs(Math.log(value(best) / (width / height))) ? r : best,
  );
}

// ---- the month's spend (UTC month), counted from the edits asked for
function spend() {
  const from = `${usdFormats.today().slice(0, 7)}-01`;
  const r = db
    .prepare('select count(*) as edits, ifnull(sum(usd), 0) as usd from studio_edits where at >= ?')
    .get(from) as { edits: number; usd: number };
  return { edits: r.edits, usd: Math.round(r.usd * 1000) / 1000 };
}

// ---- the darkroom in HQ's office view (GET /api/org's studio, and its live event)
export function office() {
  if (!runs()) return null;
  const count = (where: string) =>
    (db.prepare(`select count(*) as n from studio_photos where ${where}`).get() as { n: number }).n;
  return {
    keeper: keeper(),
    waiting: count(`status = 'waiting'`),
    developing: count(`status in ('new', 'editing', 'edited')`),
    editing: editing.size,
  };
}
const officeChanged = () => publish({ type: 'studio', studio: office() });

// ---- the keeper's jobs: one queued job to develop new photos, one to place approved ones, one to take withdrawn ones
// down (each withdrawal, studio_takedowns); what comes while it hasn't started joins it. New photos wait for the
// model's key: no job could edit them before it.
const photosOf = (column: 'develop_job' | 'place_job', job: number) =>
  db.prepare(`select * from studio_photos where ${column} = ? order by id`).all(job) as Photo[];
const KEEPER_JOBS = {
  // (the shots asked for)
  request: {
    verb: 'answer',
    word: STANDING.studioShots, // (each kind's its own task code word, jobcodes.ts.)
    joining: `update studio_requests set keeper_job = ? where status = 'open' and keeper_job is null`,
    brief: (s: Settings, job: number) =>
      requestBrief(
        s,
        db.prepare('select * from studio_requests where keeper_job = ? order by id').all(job) as Request[],
      ),
  },
  develop: {
    verb: 'develop',
    word: STANDING.studioDevelop,
    joining: `update studio_photos set develop_job = ? where status = 'new' and develop_job is null`,
    brief: (s: Settings, job: number) => developBrief(s, photosOf('develop_job', job)),
  },
  place: {
    verb: 'place',
    word: STANDING.studioPlace,
    joining: `update studio_photos set place_job = ? where status = 'approved' and place_job is null`,
    brief: (s: Settings, job: number) => placeBrief(s, photosOf('place_job', job)),
  },
  remove: {
    verb: 'take down',
    word: STANDING.studioTakedown,
    joining: 'update studio_takedowns set job = ? where job is null',
    brief: (s: Settings, job: number) => removeBrief(s, takedownsOf(job)),
  },
};
function keeperJob(kind: keyof typeof KEEPER_JOBS) {
  const s = settings();
  if (kind === 'develop' && !model.hasKey()) return;
  const queued = db
    .prepare(
      `select j.id from studio_jobs k join jobs j on j.id = k.job where k.kind = ? and j.agent = ?
    and j.status = 'queued' and j.session is null order by j.id desc limit 1`,
    )
    .get(kind, s.keeper) as { id: number } | undefined;
  const { verb, joining, brief: briefFor, word } = KEEPER_JOBS[kind];
  const job = queued?.id ?? jobs.createJob({ agent: s.keeper, word, title: 'Studio', prompt: '' }).id;
  if (!queued) db.prepare('insert into studio_jobs (job, kind) values (?, ?)').run(job, kind);
  db.prepare(joining).run(job);
  const brief = briefFor(s, job);
  db.prepare('update jobs set title = ?, prompt = ? where id = ?').run(brief.title, brief.prompt, job);
  publish({
    type: 'log',
    agent: s.keeper,
    text: `Studio: ${brief.n} to ${verb}, ${queued ? `added to job #${job}, which hasn't started yet` : `job #${job}`}`,
  });
}

// Every minute: photos whose developing job ended with them unfinished (a job that ends early, or a keeper who ended
// without ready, stop or return) go back to the keeper in a new job, once; the next time they're dropped, and their
// request stays open for the keeper. Never to the board. And new photos no job has taken yet (they came before the key)
// go to the keeper as soon as the key is in.
export function watch() {
  setInterval(() => {
    try {
      if (!runs()) return;
      const ended = db
        .prepare(
          `update studio_photos set status = case when lapses >= ${MAX_LAPSES} then 'stopped' else 'new' end,
          error = case when lapses >= ${MAX_LAPSES} then ? else ? end,
          develop_job = case when lapses >= ${MAX_LAPSES} then develop_job end, lapses = lapses + 1
          where status in ('new', 'edited', 'failed')
          and develop_job is not null and not exists (select 1 from jobs w where w.id in (${jobs.lineageFrom('select studio_photos.develop_job')})
          and w.status not in ('done', 'failed', 'cancelled')) returning status, request`,
        )
        .all(
          'Its developing jobs kept ending before it was done',
          'Its last developing job ended before it was done',
        ) as {
        status: Status;
        request: number | null;
      }[];
      for (const dropped of ended.filter(p => p.status === 'stopped')) askAgain(dropped.request);
      if (ended.length) officeChanged();
      if (
        model.hasKey() &&
        db.prepare(`select 1 from studio_photos where status = 'new' and develop_job is null`).get()
      )
        keeperJob('develop');
    } catch (err) {
      console.error("Studio: the keeper's job could not be queued:", err);
    }
  }, WATCH_MS).unref();
}

// A request whose last photo in play was just dropped goes back to the keeper in a new job, so the page's shot isn't
// left open with nobody on it
function askAgain(id: number | null) {
  const live = db
    .prepare(
      `select 1 from studio_photos where request = ? and status in ('new', 'editing', 'edited', 'waiting', 'failed')`,
    )
    .get(id);
  if (live || request(id ?? 0)?.status !== 'open') return;
  db.prepare('update studio_requests set keeper_job = null where id = ?').run(id);
  keeperJob('request');
}

// (its request)
const photoLine = (s: Settings, p: Photo, extra = '') => {
  const r = p.request ? request(p.request) : undefined;
  return (
    `- #${p.id}: ${nameOf(s.products, p.product)}, ${nameOf(s.styles, p.style)}` +
    `${r ? ` (request #${r.id}, for ${whereOf(r)})` : ''}` +
    `${p.note ? `, "${p.note}"` : ''}${p.asked ? `; the board asks: "${p.asked}"` : ''}${extra}`
  );
};
const requestLine = (s: Settings, r: Request) =>
  `- Request #${r.id} from ${r.by}: ${nameOf(s.products, r.product)}, for ${whereOf(r)}. It must show: ${r.show}`;

function requestBrief(s: Settings, list: Request[]) {
  const n = list.length;
  return {
    n,
    title: `Studio: ${n} ${n === 1 ? 'photo' : 'photos'} asked for`,
    prompt: `Pages need product photos: their owners asked the studio for them. You keep it, and you work only on shots asked for like these.
${readFirst(s)}
${list.map(r => requestLine(s, r)).join('\n')}

1. Plan each shot: what of the product, the angle, the setting (a shot style: \`hq studio\` lists them), and which of the board's test prints suits a shop (a test print's made-up name or details may not).
2. The board's photo: a product shot already on a desk-phone card, or one asked for on the next test-print card as a product shot (\`--product-shot "..."\`, with its angle and setting: no ruler, a clean background), through whoever sends that card. Never a card of your own to the board, and never a check photo (one with a ruler, taken for us to judge a print): HQ refuses those.
3. \`hq studio add --card <id> [--field <n>] --request <id> --style <id> [--note "..."] [--text "..."]\` brings it in for that request (HQ queues you its develop job).
4. A shot you can't make work as asked (no fitting print, a page that needs another angle than the board can take): \`hq studio return <request> --need "..."\` hands it back to whoever asked, with what you need. Nothing goes to the board.`,
  };
}
const readFirst = (s: Settings) => (s.notes.length ? `\nRead first: ${s.notes.join(', ')}.\n` : '');

// (step 2's --crop and --keep)
function developBrief(s: Settings, list: Photo[]) {
  const n = list.length;
  return {
    n,
    title: `Studio: ${n} new ${n === 1 ? 'photo' : 'photos'} to develop for the board's batch`,
    prompt: `New photos are in the studio (a desk-phone card's, added with hq studio add for a shot asked for), or the board sent some back. You keep it: edit each one, check it, and put the good ones in the board's batch.
${readFirst(s)}
New:
${list.map(p => photoLine(s, p)).join('\n')}

1. \`hq studio\` lists every photo in the studio. \`hq studio original <id>\` saves the board's photo for you to look at.
2. \`hq studio edit <id> [--note "..."] [--crop x,y,w,h] [--keep x,y,w,h]... [--text "..."] [--fix <id>]... [--style <id>]\` has the image model edit it (${usdFormats.number(model.price(s.model, s.size), 'en', { style: 'currency', currency: 'USD', minimumFractionDigits: 3 })} an edit, within a monthly cap of ${dollars(s.monthlyUsd)}) and saves the edit for you to look at. Compare it with the original closely: the product must be exactly as it is (its shape, its size against the room, its colours, its print and every letter, its material and finish, its flaws), nothing added to it or taken from it, and no people or hands. If anything changed, edit it again with a note on what to put right. HQ takes ${MAX_EDITS} edits of a photo at most each time the board sends it. A failure never goes to the board: one that still doesn't hold, or can't (the edit would change the product, the print doesn't suit the page), \`hq studio stop <id> --why "..."\` drops it (its request stays open for another photo), or \`hq studio return <request> --need "..."\` hands the request back to whoever asked with what you need. Every photo of yours ends ready, stopped or returned: one left as it is comes back to you in a new job once this one ends.
   - \`--crop\` sends the model only that box of the original (in its own pixels, as \`hq studio original\` saves it): crop to frame a product the board wants closer or centred. The board compares the edit with the crop.
   - \`--text\` gives the model the product's printed text exactly, character for character (" / " between lines); the photo keeps it for its later edits. Use it with \`--keep\` on small print, not instead of it.
   - \`--fix <id>\` (once per fix) adds a fix for a problem that keeps coming back, from the studio's settings (\`hq studio\` lists them; a new one is a line to whoever keeps the settings). \`--style <id>\` changes the photo's shot style from this edit on.
   - \`--keep\` (once per box, within the crop) pastes that box of the original back over the edit, found where the model put it, its light matched: keep any print whose letters are small in the original (a label, an address), its whole box. Check it letter by letter as before, and where it meets the edit. A box HQ can't find surely stays the model's, and the edit's answer says so.
3. \`hq studio ready <id>... --check "..." [--check "..."]...\` puts the good ones in the board's batch, with one to ${MAX_CHECKS} short lines of what the board should check on each (its letters, its colour, the cord whole): the board sees them with the page it goes on and what it must show. Only a photo for an open request goes. The board accepts or rejects each in the Studio, beside its original. Nothing else goes to the board: no card per photo.`,
  };
}

function placeBrief(s: Settings, list: Photo[]) {
  const n = list.length;
  return {
    n,
    title: `Studio: ${n} approved ${n === 1 ? 'photo' : 'photos'} to place`,
    prompt: `The board approved photos in the studio. Only photos the board approved may be used on our sites, and these are those:
${readFirst(s)}
${list.map(p => photoLine(s, p, `, approved ${lastDecision(p.id)?.at.slice(0, 16).replace('T', ' ')} UTC`)).join('\n')}

1. \`hq studio get <id>\` saves an approved photo as the board approved it. It carries the AI-edit mark in its metadata (IPTC digital source type). A copy at another size or format can lose it: publish JPEG or PNG only (the mark can't be written into other formats yet), mark every copy again after its last resize with \`node shared/provenance/provenance.ts <file>\`, and check each file as the site serves it with \`--check\`.
2. Place them where they belong, with what the notes above ask for on and around a photo (its words, its alt text, a page on how the photos are made). Whatever they ask a site to have goes live with its first photo, not before. "The board asks" is its comment as it approved one.
3. Once a photo is on its pages, \`hq studio placed <id> <url>...\` with each page's public address: the board finds the photo by it in the Studio's History.
4. A photo the board withdraws later, or says should change, comes off the sites: HQ queues you a job for that. \`hq studio\` lists the photos the board hasn't declined or withdrawn; \`hq studio get\` gives only the approved ones.`,
  };
}

// a withdrawal with its photo as it is now (a photo sent back and approved again since is placed anew)
type Takedown = Photo & { withdrawn_edit: number; placed_by: number | null; withdrawn_at: string };
const takedownsOf = (job: number) =>
  db
    .prepare(
      `select p.*, t.edit as withdrawn_edit, t.place_job as placed_by, t.at as withdrawn_at from studio_takedowns t
      join studio_photos p on p.id = t.photo where t.job = ? order by t.id`,
    )
    .all(job) as Takedown[];
const placedOn = (t: Takedown) => {
  const urls = placesOf(t.id, t.withdrawn_edit);
  return urls.length ? `; placed on ${urls.join(', ')}` : '';
};
function removeBrief(s: Settings, list: Takedown[]) {
  const n = list.length;
  return {
    n,
    title: `Studio: ${n} withdrawn ${n === 1 ? 'photo' : 'photos'} to take down`,
    prompt: `The board withdrew photos it had approved in the studio: they may no longer be used anywhere. Take every copy of them down.
${readFirst(s)}
${list.map(t => photoLine(s, t, `, edit ${t.withdrawn_edit} withdrawn ${t.withdrawn_at.slice(0, 16).replace('T', ' ')} UTC; its placing job was #${t.placed_by}${placedOn(t)}`)).join('\n')}

1. Find every copy: what its placing job put in the repo (its pull request, \`git log --all\` for the files), and each site as it serves them.
2. Take each one off, with whatever was made from it, and leave each page right without it (its words, its alt text; what the notes above ask for on the photos page). A placing job that hasn't run yet can't get them any more: \`hq studio get\` refuses a withdrawn photo.
3. Say in your report where each copy was and that it's gone.

One the board says should change (its note: "the board asks") is back with you in a develop job too: its new edit goes to the board as any other, and is placed anew once approved.`,
  };
}

// An agent route's answer: the value, or a refusal as [status, 'why'] for hq to print
export async function answer(work: () => unknown) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StudioError) return [err.status, err.message];
    throw err;
  }
}
