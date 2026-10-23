// The shop's one parcel: every paid line of a basket goes to the printer as one Print API order, shipped when its slowest
// item is made. Each product hands HQ its line's items and print files instead of placing an order of its own; HQ places
// the order once every line's are in, to the address the customer gave at the shop's checkout, and reads its status and
// tracking back for every line.
//
//   POST /api/pay/parcel/items {line, items: [{productId, quantity, pageCount?, options?: [{id, value}],
//        files?: ['content']}]}
//        what a paid line is made of, as Print API takes it (files: the print files each item needs, content by default),
//        for one copy: HQ orders each item the line's quantity times over
//   POST /api/pay/parcel/file?line=ln_...&item=0&file=content   one print file as the body (PDF, PNG or JPEG, with its
//        content-type). Once every item's files are in, the line is handed over; sending one again changes nothing.
//   POST /api/pay/parcel/cancel {line}   takes a paid line out of its parcel before printing. Print API cancels whole
//        orders only, so the parcel's order is cancelled and placed again without it; refused once printing started.
//        Only then can the line be refunded (POST /api/pay/line/refund refuses a line still in a parcel that hasn't
//        shipped).
//   The line's view (GET /api/pay/line) carries `parcel`: {status: waiting|placed|printing|shipped|cancelled, handed,
//        removed: null|asked|done, express, shipped_at, tracking, error, with: [{shop, reference}]}. A parcel Print API cancelled
//        itself is `cancelled`: each product refunds its line, as for its own order before. `error` (why a waiting parcel
//        isn't placed yet) is for the product's operator, never shown to the customer.
// Print API's order ids are ours, <parcel>-<round> (a new round each time the parcel is placed again), its items
// <position>-<n> (the line's place in the basket, then its item). The files stay in HQ until the parcel is printing or
// shipped (Print API has them then), and never past two months after the payment while it may still be placed. A cancel
// changes no clock (DECISIONS, 2026-10-14): a line taken out keeps its files with the parcel's, and a cancelled parcel's
// go 90 days after the payment, as the lines' words do (payments.tick); a line whose customer asked us to delete their
// details (POST /api/pay/line/forget) loses its files as soon as its parcel can't be placed with it. A parcel still
// waiting when its delivery address goes (at most 30 days after the payment) is cancelled; once a placed parcel's
// address is gone, no line can be taken out of it.
// A company's kits may add items of their own to the parcel's order (extras: a card with a code, a gift, say), decided again
// each time the order is placed; parcel_extras says which went in. A document (a sheet of what's in the parcel, say) is made
// after them and is the one item the parcel never goes without: it waits instead.
// A line may hand over spare files with its items, which aren't printed as they are but are there for those kits (a small
// version of its design for a gift, say): `spares: ['name']` with its items, then POST /api/pay/parcel/file?line=ln_...&spare=name.
// The line is handed over once every item's files and every spare are in.
// A kit's own item may hold its file back for a while (holdUntil: the buyer still picks how it looks, say): the order goes
// to Print API at once with every other file, and the parcel waits for that one, for at most the hold plus two minutes'
// grace and the next round (HELD_LATEST_MS). Its file goes up when the kit releases it, with new bytes or as stored, or
// as stored once the grace is over, whatever happens (heldLapsed says so, and the placing logs it). It goes up as the
// placing sends any file: read back until Print API accepts it, and the parcel placed again without the item when Print
// API won't take it.
// A parcel can be hurried before printing (a company's own tool decides when: hurryQuote() and hurry()): it goes to Print
// API at express speed, its order cancelled and placed again the same way if Print API has it already, and it stays
// express (`express` in the line's view) whatever is placed again after, while express still ships by the day it was
// hurried for.
// A parcel can be placed again by hand (a company's own tool, for a person in Care or Process: again()): a placed one
// whose order is still Created, cancelled and placed again as it is, each kit deciding its own items again (a card it
// went without, say); one Print API cancelled, placed again from Print API's own record of that order (the same items, to
// the same address) with the print files a person gives.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { db } from './db.ts';
import { FRONT } from './approvals.ts';
import * as printapi from './printapi.ts';
import { type Caller, type Line, caller, isTesterOrder, json, keepAddress, lineForgotten, lineParts, lineRefundGuards, log, ownLine,
  BODY_BYTES, everyParcel, parcelCancelled, recordsEnded, retakeTesterOrder, serial, shipBy, shipDay } from './payments.ts';   // recordsEnded
import { manifest } from './manifests.ts';
import { readJson } from '../../../shared/routes/routes.ts';

// Parcels.
// - speed: 'Express' once hurried, or null for Print API's standard.
// - hurry: 'asked' while cancellation to place the order again at express speed is unanswered.
// - hurry_by: the last useful express shipping day, checked when cancellation is accepted and before placing the order.
// - again: 'asked' while cancellation to place the order again by hand is unanswered.
// - kept: a JSON list of the kit's items placed again by hand with a person's file, in place of what the kit makes now.
db.exec(`create table if not exists parcels (id text primary key, session text not null unique, mode text not null,
  status text not null, round integer not null default 1, order_status text, shipped_at text, tracking text, error text,
  nagged text, created text not null, placed_at text, checked integer not null default 0, updated text not null,
  speed text, hurry text, hurry_by text, again text, kept text)`);
// A parcel line's spares lists its spare file names as JSON.
// forget_asked: its customer asked us to delete their details (payments.forgetLine).
db.exec(`create table if not exists parcel_lines (parcel text not null, line text not null unique, position integer not null,
  items text, handed text, removed text, spares text, forget_asked text, primary key (parcel, line))`);
// The company's own extras: round says which round of the order holds each item.
// dropped: when Print API refused its file.
// held_until: the extra's file waits here for its kit until then, with the parcel waiting for it.
// document: 1 for a company document (documents below), which the parcel never goes without.
db.exec(`create table if not exists parcel_extras (parcel text not null, name text not null, product text not null,
  round integer, dropped text, held_until text, document integer, primary key (parcel, name))`);
// Only baskets paid from the day parcels came in have one: a basket paid before was placed by its products themselves.
// Paid is when its lines turned paid (payments.settle), not when its checkout was opened.
db.prepare("insert or ignore into settings (key, value) values ('parcels_from', ?)").run(new Date().toISOString());
const FROM = (db.prepare("select value from settings where key = 'parcels_from'").get() as { value: string }).value;
const PAID_SINCE = 'exists (select 1 from pay_lines l where l.session = payments.id and l.paid_at >= ?)';

type Parcel = { id: string; session: string; mode: printapi.Mode; status: 'waiting' | 'placed' | 'printing' | 'shipped' | 'cancelled';
  round: number; order_status: string | null; shipped_at: string | null; tracking: string | null; error: string | null;
  nagged: string | null; created: string; placed_at: string | null; checked: number; updated: string;
  speed: 'Express' | null; hurry: 'asked' | null; hurry_by: string | null; again: 'asked' | null; kept: string | null };
type Part = { parcel: string; line: string; position: number; items: string | null; handed: string | null; removed: 'asked' | 'done' | null;
  spares: string | null; forget_asked: string | null };
type Item = { productId: string; quantity: number; pageCount?: number; options?: { id: string; value: string }[]; files: string[] };

// ---- the company's own items in the parcel. Each kit in extras is asked
// in turn each time the parcel's order is placed, with the parcel, its lines (each with its items and its spare files'
// names), every item of theirs, and the extras the kits before it chose; it answers its own items with their files (none:
// an empty list, or null). Names are the kit's own, unique in the parcel. An extra never stops the parcel: when its
// kit fails, Print API refuses the order with it, or Print API won't take its file (the order is cancelled while still
// Created and placed again), the parcel goes without it, and once its file was refused, without it from then on.
// holdUntil (an ISO time): its files wait here until release() or that time plus the grace, the order placed at Print API
// at once and the parcel waiting for them meanwhile.
export type ExtraFile = { bytes: Uint8Array; type: string };
// (pageCount: a print of that many pages)
export type Extra = { name: string; productId: string; quantity: number; pageCount?: number; options?: { id: string; value: string }[];
  files: Record<string, ExtraFile>; holdUntil?: string };
export type ExtraLine = { line: string; position: number; items: Item[]; spares: string[] };
export type ExtraOrder = { parcel: Parcel; lines: ExtraLine[]; items: Item[]; chosen: Extra[] };
export type ExtraFor = (order: ExtraOrder) => Promise<Extra[] | Extra | null>;
export const extras: ExtraFor[] = [];
// A company's documents in the parcel (a sheet saying what's in it, with the safety words that must travel with it, say):
// asked as extras are, after every kit in extras, with all their items chosen, and again whenever those change (the
// order placed without them). Unlike an extra the parcel never goes without one: when its kit throws (its message says
// why: a sheet that doesn't fit, say), Print API refuses the order with it, or won't take its file, the parcel isn't
// placed and waits with why, tried again each round (a person can place it again by hand). No held files. Each
// document's kit decides its own making time into everyParcel (payments.ts), if every parcel has one.
export const documents: ExtraFor[] = [];
const EXTRA = /^[a-z0-9_]{1,40}$/;
const extraItem = (name: string) => `x-${name}`;   // its item id in the order: the lines' are <position>-<n>
const extraOf = (itemId: unknown) => (/^x-([a-z0-9_]{1,40})$/.exec(String(itemId)) ?? [])[1] ?? null;
// The extras the parcel's order holds now (its current round), and the ones Print API wouldn't take
export const extrasIn = (parcel: string) => (db.prepare(`select e.name from parcel_extras e join parcels p on p.id = e.parcel
  where e.parcel = ? and e.round = p.round and e.dropped is null`).all(parcel) as { name: string }[]).map(e => e.name);
// The documents the parcel's order holds now (its current round).
export const documentsIn = (p: Pick<Parcel, 'id' | 'round'>) => (db.prepare(`select name from parcel_extras where parcel = ? and round = ?
  and document = 1`).all(p.id, p.round) as { name: string }[]).map(e => e.name);
const droppedIn = (parcel: string) =>
  new Set((db.prepare('select name from parcel_extras where parcel = ? and dropped is not null').all(parcel) as { name: string }[]).map(e => e.name));
// A line's spare file, for a company's kit making its extra (null when it isn't here: never sent, or gone with the line)
export function spare(parcel: string, line: string, name: string) {
  const found = EXTRA.test(name) ? storedAt(`${DIR}/${parcel}/${line}-spare-${name}`) : null;
  return found ? { bytes: new Uint8Array(readFileSync(found.path)), type: found.type } : null;
}

// Whether an extra would ship after the parcel's own items: each product's standard making time and cut-off hour as Print
// API says (GET /products/{id} productionTimes, read once a day), summed like a line's ship day (payments.shipDay). Each
// kit asks it for its own items. 'unknown' when Print API's times can't be read.
export type ProductionTime = { speed: string; days: number; limitHour: number };
export async function shipsAfterItems(mode: printapi.Mode, productId: string, items: { productId: string }[], now = Date.now()) {
  const own = await standardTime(mode, productId);
  const theirs = await Promise.all(items.map(item => standardTime(mode, item.productId)));
  if (!own || theirs.some(time => !time)) return 'unknown';
  // and what every parcel holds besides, which it ships with
  const besides = everyParcel.map(x => ({ speed: 'Standard', days: x.days, limitHour: x.cutoff }));
  return shipsLater(own, [...(theirs as ProductionTime[]), ...besides], now);
}
// The days an extra and the parcel's items ship, ordered now, when the extra's is later; else null
export function shipsLater(extra: ProductionTime, items: ProductionTime[], now: number) {
  const shipsOn = (time: ProductionTime) => shipDay(now, time.days, time.limitHour);
  const parcelDay = items.map(shipsOn).reduce((a, b) => (b > a ? b : a));
  const extraDay = shipsOn(extra);
  return extraDay > parcelDay ? { extra: extraDay, parcel: parcelDay } : null;
}
export async function standardTime(mode: printapi.Mode, productId: string) {
  return (await productionTimes(mode, productId))?.find(time => time.speed === 'Standard') ?? null;
}
const SPEC_TTL = 24 * 60 * 60_000;
const specs = new Map<string, { at: number; times: ProductionTime[] }>();
async function productionTimes(mode: printapi.Mode, productId: string) {
  const key = `${mode}:${productId}`;
  const known = specs.get(key);
  if (known && Date.now() - known.at < SPEC_TTL) return known.times;
  const answer = await printapi.call(mode, 'GET', `/products/${encodeURIComponent(productId)}`);
  const list = answer.status === 200 ? answer.body?.productionTimes : null;
  const fine = (t: any) => typeof t?.speed === 'string' && Number.isInteger(t.days) && Number.isInteger(t.limitHour);
  const times = Array.isArray(list) && list.every(fine) ? (list as ProductionTime[]) : null;
  if (times) specs.set(key, { at: Date.now(), times });
  return times;
}

const MIN = 60_000, DAY = 24 * 60 * MIN;
const CHECK_EVERY = 10 * MIN;       // a placed parcel's status at Print API
const NAG_AFTER = 2 * DAY;          // a parcel still waiting for a product's files: a person looks
const GIVE_UP_AFTER = 30 * DAY;     // a parcel never placed: cancelled (the address is kept at most as long, payments.tick)
const STUCK_AFTER = 60 * DAY;       // any parcel's files still here: they go, a person looks
const KEEP_CANCELLED = 90 * DAY;    // a cancelled parcel's files, as the lines' words
const MAX_ITEMS = 20;
const HELD_GRACE_MS = 2 * MIN;      // a held file's kit has this long past its hold to send it, then the stored one goes
const HOLD_MAX_MS = 60 * MIN;       // a held file waits at most this long after the placing
const TICK_EVERY = 2 * MIN;         // the parcels' round (tick)
// A held file goes up at the latest this long after its hold: the grace, then the next round places it as stored
export const HELD_LATEST_MS = HELD_GRACE_MS + TICK_EVERY;
const WORD = /^[A-Za-z0-9_.-]{1,80}$/, LINE = /^ln_[a-f0-9]{24}$/;
const PRINTING = 'printing has started: it can no longer be cancelled';
const NO_ADDRESS = "this parcel's delivery address is no longer kept (30 days after the payment), so it can't be placed again "
  + 'without this line: it prints as it is, and the line can be refunded once it has shipped';
const EXTENSIONS: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
const DIR = `${DATA_DIR}/parcels`;
const stamp = () => new Date().toISOString();
const row = (id: string) => db.prepare('select * from parcels where id = ?').get(id) as Parcel | undefined;
const parts = (parcel: string) => db.prepare('select * from parcel_lines where parcel = ? order by position').all(parcel) as Part[];
const partOf = (line: string) => db.prepare('select * from parcel_lines where line = ?').get(line) as Part | undefined;
const orderId = (p: Parcel) => `${p.id}-${p.round}`;
// Print API's environment a parcel is printed in: its payment's mode, but a tester's order (payments.ts paidByTester), paid
// in test mode on the preview shop, is printed and sent for real
export const printer = (p: Pick<Parcel, 'mode' | 'session'>): printapi.Mode => (isTesterOrder(p.session) ? 'live' : p.mode);
// a cancellation of the parcel's order is unanswered: for lines taken out, or to place it again at express speed
const cancelling = (p: Parcel) => p.hurry === 'asked' || p.again === 'asked' || parts(p.id).some(x => x.removed === 'asked');
const orderPath = (id: string) => `/orders/${encodeURIComponent(id)}`;
const inQueue = <T>(parcel: string, run: () => Promise<T>) => serial(`parcel:${parcel}`, run);
function update(id: string, fields: Partial<Parcel>) {
  const keys = Object.keys(fields);
  const values = keys.map(k => (fields as any)[k]);
  db.prepare(`update parcels set ${keys.map(k => `${k} = ?`).join(', ')}, updated = ? where id = ?`).run(...values, stamp(), id);
}

// ---- a basket's parcel: made the first time anyone asks after the payment (a product's line, or the timer), with every
// line the payment charged, in basket order
function parcelOf(session: string) {
  const pay = db.prepare(`select id, mode from payments where id = ? and basket is not null and status = 'paid'
    and ${PAID_SINCE}`).get(session, FROM) as { id: string; mode: string } | undefined;
  if (!pay) return undefined;
  db.prepare("insert or ignore into parcels (id, session, mode, status, created, updated) values (?, ?, ?, 'waiting', ?, ?)")
    .run(`pc_${randomBytes(8).toString('hex')}`, session, pay.mode, stamp(), stamp());
  const parcel = db.prepare('select * from parcels where session = ?').get(session) as Parcel;
  // a line refunded before its parcel was made is out of it from the start; the shop's own lines (payments.ownLines) are
  // its kits' to put in, as extras
  db.prepare(`insert or ignore into parcel_lines (parcel, line, position, removed) select ?, sl.line, sl.position,
    case when l.refund_status = 'succeeded' then 'done' end from session_lines sl join pay_lines l on l.id = sl.line
    where sl.session = ? and l.goes_with is null`).run(parcel.id, session);
  return parcel;
}

// ---- the product's side
async function paidLine(c: Caller, id: string): Promise<{ line: Line; parcel: Parcel } | [number, string]> {
  const own = LINE.test(id) ? await ownLine(c, id) : null;
  if (!own) return [404, 'no such line for this product'];
  const parcel = own.line.status === 'paid' && own.line.session ? parcelOf(own.line.session) : undefined;
  if (!parcel) return [409, 'this line is not paid'];
  return { line: own.line, parcel };
}

async function setItems(c: Caller, b: any) {
  const found = await paidLine(c, String(b.line ?? ''));
  if (Array.isArray(found)) return found;
  const asked = itemsOf(b.items);
  if (typeof asked === 'string') return [400, asked];
  // a line of copies: each item that many times in the order, from the one print file
  const items = asked.map(it => ({ ...it, quantity: it.quantity * found.line.quantity }));
  // its spare files' names
  const spares = b.spares ?? [];
  if (!Array.isArray(spares) || spares.length > 4 || new Set(spares).size < spares.length || spares.some((n: unknown) => !EXTRA.test(String(n))))
    return [400, 'spares: up to 4 names of spare files (a-z, 0-9, _)'];
  return inQueue(found.parcel.id, async () => {
    const part = partOf(found.line.id)!;
    if (part.removed) return [409, 'this line was taken out of its parcel'];
    if (part.items === JSON.stringify(items) && part.spares === JSON.stringify(spares)) return view(found.line);   // named again: the files sent stay
    if (part.handed) return [409, "this line's items are handed over already"];
    const closed = closedTo(part);
    if (closed) return closed;
    db.prepare('update parcel_lines set items = ?, spares = ? where line = ?').run(JSON.stringify(items), JSON.stringify(spares), part.line);
    dropFiles(part.parcel, part.line);   // files sent for other items before
    return view(found.line);
  });
}
// The items as Print API takes them, each with the files it needs (content unless named)
function itemsOf(v: unknown): Item[] | string {
  const shape = `items: 1 to ${MAX_ITEMS} of {productId, quantity, pageCount?, options?: [{id, value}], files?: ['content', ...]}`;
  if (!Array.isArray(v) || !v.length || v.length > MAX_ITEMS) return shape;
  const items: Item[] = [];
  for (const it of v) {
    const files = it?.files === undefined ? ['content'] : it.files, options = it?.options ?? [];
    if (!WORD.test(String(it?.productId)) || !Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 100) return shape;
    if (it.pageCount !== undefined && (!Number.isInteger(it.pageCount) || it.pageCount < 1 || it.pageCount > 1000)) return shape;
    if (!Array.isArray(options) || options.some((o: any) => !WORD.test(String(o?.id)) || !WORD.test(String(o?.value)))) return shape;
    if (!Array.isArray(files) || !files.length || files.length > 4 || new Set(files).size < files.length) return shape;
    if (files.some((f: unknown) => !WORD.test(String(f)))) return shape;
    items.push({ productId: it.productId, quantity: it.quantity, ...(it.pageCount === undefined ? {} : { pageCount: it.pageCount }),
      ...(options.length ? { options: options.map((o: any) => ({ id: o.id, value: o.value })) } : {}), files });
  }
  return items;
}

async function putFile(c: Caller, req: IncomingMessage, url: URL) {
  const found = await paidLine(c, String(url.searchParams.get('line') ?? ''));
  if (Array.isArray(found)) return found;
  const item = Number(url.searchParams.get('item') ?? 'x'), name = String(url.searchParams.get('file') ?? 'content');
  const spareName = url.searchParams.get('spare');
  const known = partOf(found.line.id)!;
  const items: Item[] | null = JSON.parse(known.items ?? 'null'), spares: string[] = JSON.parse(known.spares ?? '[]');
  if (!items) return [409, 'name its items first (POST /api/pay/parcel/items)'];
  if (spareName !== null ? !spares.includes(spareName) : !Number.isInteger(item) || !items[item]?.files.includes(name))
    return [400, `item and file, or spare: one the line's items name (item 0 to ${items.length - 1}), or one of its spares`];
  const file = await readFile(req);
  if (!Buffer.isBuffer(file)) return file;
  return inQueue(found.parcel.id, async () => {
    const part = partOf(found.line.id)!;
    if (part.removed) return [409, 'this line was taken out of its parcel'];
    if (part.handed) return view(found.line);   // sent again after a lost answer
    const closed = closedTo(part);
    if (closed) return closed;
    if (part.items !== JSON.stringify(items) || part.spares !== known.spares) return [409, "the line's items changed meanwhile: send its files again"];
    mkdirSync(`${DIR}/${part.parcel}`, { recursive: true, mode: 0o700 });
    const base = spareName !== null ? `${DIR}/${part.parcel}/${part.line}-spare-${spareName}` : filePath(part, item, name);
    for (const ext of Object.values(EXTENSIONS)) rmSync(`${base}.${ext}`, { force: true });
    writeFileSync(`${base}.${EXTENSIONS[file.type!]}`, file, { mode: 0o600 });
    const spared = spares.every(n => storedAt(`${DIR}/${part.parcel}/${part.line}-spare-${n}`));
    if (spared && items.every((it, n) => it.files.every(f => stored(part, n, f)))) {
      db.prepare('update parcel_lines set handed = ? where line = ?').run(stamp(), part.line);
      log(`${c.slug} handed its ${c.mode} line for ${found.line.reference} to parcel ${part.parcel}.`);
      placeSoon(part.parcel);
    }
    return view(found.line);
  });
}
async function readFile(req: IncomingMessage): Promise<(Buffer & { type?: string }) | [number, string]> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > printapi.MAX_FILE) { req.resume(); return [413, `a print file: at most ${printapi.MAX_FILE / 1048576} MB`]; }
    chunks.push(chunk);
  }
  const file: Buffer & { type?: string } = Buffer.concat(chunks);
  if (file.length < 100 || !printapi.fileType(type, file)) return [400, 'a print file: a JPEG, PNG or PDF as the body, with its content-type'];
  file.type = type;
  return file;
}
// A line still to be handed over goes in only while its parcel waits: one given up (or cancelled by Print API) takes no
// more files, so none is kept past the parcel's end
function closedTo(part: Part): [number, string] | null {
  const status = row(part.parcel)!.status;
  if (status === 'waiting') return null;
  dropFiles(part.parcel, part.line);
  return [409, `this line's parcel is ${status}: it takes nothing more`];
}
// A file's path without its extension; the stored one, with its type, or null
const filePath = (part: Part, item: number, name: string) => `${DIR}/${part.parcel}/${part.line}-${item}-${name}`;
const stored = (part: Part, item: number, name: string) => storedAt(filePath(part, item, name));
function storedAt(base: string) {
  const candidates = Object.entries(EXTENSIONS).map(([type, ext]) => ({ type, path: `${base}.${ext}` }));
  return candidates.find(f => existsSync(f.path)) ?? null;
}
function dropFiles(parcel: string, line?: string) {
  if (!line) return rmSync(`${DIR}/${parcel}`, { recursive: true, force: true });
  let names: string[] = [];
  try { names = readdirSync(`${DIR}/${parcel}`); } catch { /* none sent yet */ }
  for (const name of names.filter(n => n.startsWith(`${line}-`))) rmSync(`${DIR}/${parcel}/${name}`, { force: true });
}

// Taking a line out before printing: at once while the parcel has no order at Print API (or Print API cancelled it);
// while its order is still Created there, by cancelling that order and placing the parcel again without the line. A
// waiting parcel can have one too: a placing that failed half-way (files not accepted yet) leaves its order Created.
async function removeLine(c: Caller, b: any) {
  const found = await paidLine(c, String(b.line ?? ''));
  if (Array.isArray(found)) return found;
  const refused = await inQueue(found.parcel.id, async (): Promise<[number, string] | null> => {
    const part = partOf(found.line.id)!, p = row(part.parcel)!;
    if (part.removed === 'done') return null;
    if (p.status === 'cancelled') { takeOut(part, c); return null; }
    if (p.status === 'placed' && !addressOf(p)) return [409, NO_ADDRESS];
    // the order is being cancelled already: the line goes with the others asked for, and where that stands is read again
    if (cancelling(p)) { markAsked(part); return settleCancellation(p); }
    if (p.status !== 'waiting' && p.status !== 'placed') return [409, PRINTING];
    if (p.status === 'placed' && !existsSync(`${DIR}/${p.id}`)) return [409, "this parcel's files are gone: a person looks at it"];
    // Print API cancels only a Created order at once; anything later is a request someone may turn down, so it's asked
    // only of an order that hasn't started
    const now = p.status === 'placed' || printapi.keys(printer(p)) ? await printapi.call(printer(p), 'GET', orderPath(orderId(p))) : null;
    if (p.status === 'waiting' && (!now || now.status === 404)) { takeOut(part, c); placeSoon(p.id); return null; }
    if (now!.status !== 200) return [502, `Print API answered ${now!.status}: try again in a minute`];
    if (now!.body?.status !== 'Created') {
      await refresh(p, now!.body);
      if (row(p.id)!.status !== 'cancelled') return [409, PRINTING];
      takeOut(part, c);
      return null;
    }
    markAsked(part);   // first: if Print API's answer is lost, the next read finds the cancellation and settles it
    const reason = 'One item of the parcel was cancelled: placed again without it';
    const asked = await printapi.call(printer(p), 'POST', `${orderPath(orderId(p))}/cancellation`, { reason });
    if (asked.status >= 300 && asked.status !== 409) { unmark(p); return [502, `Print API answered ${asked.status}: try again in a minute`]; }
    log(`${c.slug} took its ${c.mode} line for ${found.line.reference} out of parcel ${p.id}: its order ${orderId(p)} is being `
      + 'cancelled to be placed again.');
    return settleCancellation(p);
  });
  return refused ?? view(found.line);
}
const markAsked = (part: Part) => { db.prepare("update parcel_lines set removed = 'asked' where line = ?").run(part.line); };
const unmark = (p: Parcel) => { db.prepare("update parcel_lines set removed = null where parcel = ? and removed = 'asked'").run(p.id); };
// the cancellation is off (never received, turned down, or given up): the lines asked for stay in, and a parcel asked to
// go express prints as it was
const callOff = (p: Parcel) => {
  unmark(p);
  if (row(p.id)!.hurry === 'asked') update(p.id, { hurry: null, speed: null });
  if (row(p.id)!.again === 'asked') update(p.id, { again: null });
};
function takeOut(part: Part, c: { slug: string; mode: string }) {
  db.prepare("update parcel_lines set removed = 'done' where line = ?").run(part.line);
  log(`${c.slug} took its ${c.mode} line out of parcel ${part.parcel} before printing.`);
}
// Where the parcel order's cancellation stands: accepted, the lines asked for are out and the rest is placed again (at
// express speed, if that's what it was asked for and express still ships by its hurry_by: else as it was); turned down,
// they stay in and printing goes on as it was; never received (a request lost on the way), they stay in
async function settleCancellation(p: Parcel): Promise<[number, string] | null> {
  const asked = parts(p.id).filter(x => x.removed === 'asked');
  if (!asked.length && p.hurry !== 'asked' && p.again !== 'asked') return null;
  const c = await printapi.call(printer(p), 'GET', `${orderPath(orderId(p))}/cancellation`);
  const status = String(c.body?.status ?? c.body ?? '');
  const order = status === 'Accepted' ? null : await printapi.call(printer(p), 'GET', orderPath(orderId(p)));
  if (status === 'Accepted' || order?.body?.status === 'Cancelled') {
    // accepted too late for express to ship by the hurry's day: nothing is spent on it (review finding)
    const late = p.hurry === 'asked' && p.hurry_by !== null && await missesDay(p, p.hurry_by);
    for (const part of asked) takeOut(part, { slug: lineProduct(part.line), mode: p.mode });
    update(p.id, { status: 'waiting', round: p.round + 1, order_status: null, placed_at: null, error: null, hurry: null, again: null, ...(late ? { speed: null } : {}) });
    const how = [asked.length ? `without the ${asked.length === 1 ? 'line' : 'lines'} taken out` : '',
      p.hurry !== 'asked' ? '' : late ? `at standard speed (express would no longer ship by ${p.hurry_by})` : 'at express speed',
      p.again === 'asked' ? 'by hand' : ''];
    log(`Parcel ${p.id}'s order ${orderId(p)} is cancelled: placing it again ${how.filter(Boolean).join(', ')}.`);
    placeSoon(p.id);
    return null;
  }
  if (status === 'None') { callOff(p); return [502, 'Print API never got the cancellation: try again in a minute']; }
  // turned down, or never answered before the parcel shipped
  if (status === 'Failed' || order?.body?.status === 'Shipped') {
    callOff(p);
    log(`Parcel ${p.id}: Print API turned down cancelling its order ${orderId(p)}, so it prints as it is.`);
    return [409, PRINTING];
  }
  return null;   // Requested: Print API answers later (the timer reads it again)
}
function lineProduct(line: string) {
  const found = db.prepare('select product from pay_lines where id = ?').get(line) as { product: string } | undefined;
  return found?.product ?? 'a product';
}

// ---- placing the parcel's order, once every line still in it is handed over. Like a product's own order before: our id
// first, so a retry after a lost answer finds the order (Print API refuses an id twice), then the files still awaited.
const placeSoon = (id: string) => {
  place(id).catch(err => console.error(`Parcels: could not place ${id}:`, err instanceof Error ? err.message : err));
};
export const place = (id: string) => inQueue(id, async () => {
  const p = row(id);
  if (p?.status !== 'waiting') return;
  const all = parts(id), active = all.filter(x => !x.removed);
  if (cancelling(p)) return;
  if (!active.length) {
    update(id, { status: 'cancelled', error: null });
    return log(`Parcel ${id} (${p.mode}) is cancelled: every line was taken out.`);
  }
  if (active.some(x => !x.handed)) return;
  let why;
  try { why = await placeOrder(p, active); }
  catch (err) { if (!(err instanceof printapi.PrintApiError)) throw err; why = err.message; }
  if (!why) return;
  // why it isn't placed yet: kept as its error, tried again on the next round
  if (why !== p.error) log(`Parcel ${id} (${p.mode}) not placed yet: ${why}.`);
  update(id, { error: why });
});
// null once the order is placed and every file accepted, else why not (yet)
async function placeOrder(p: Parcel, active: Part[]): Promise<string | null> {
  const deliver = addressOf(p);
  if (!deliver) return "its delivery address is gone, so it can't be placed";
  if (!printapi.keys(printer(p))) return `no Print API ${printer(p)} keys on the server yet`;
  const order = await findOrPlace(p, active, JSON.parse(deliver));
  if (typeof order === 'string') return order;
  // a retry can find the order gone on (or cancelled) after a lost answer: then it's only read back
  const created = statusOf(order.status) === 'placed';
  // a kit's item whose file is held goes up later
  const held = heldExtras(p);
  const sent = created ? await upload(p, active, order, held) : { why: null, extrasRefused: new Map<string, string>() };
  const back = await printapi.call(printer(p), 'GET', orderPath(orderId(p)));
  const items = ((back.body?.items ?? []) as any[]).filter(it => !held.has(extraOf(it?.id) ?? ''));
  // Print API won't take a company's own item: placed again without it
  const refused = new Map([...(created && back.status === 200 ? extraFilesRefused(items) : []), ...sent.extrasRefused]);
  // a document never goes without: the parcel waits for a person
  const docs = [...refused].filter(([name]) => documentsIn(p).includes(name));
  if (docs.length) return `NEEDS A PERSON: its ${docs.map(([name, w]) => `${name} can't go (${w})`).join('; ')}, and it never goes without`;
  if (refused.size) return placeWithoutExtras(p, refused);
  if (sent.why) return sent.why;
  const waiting = created ? filesAwaited(items) : [];
  const unaccepted = back.status === 200 ? waiting.join(', ') : back.status;
  if (back.status !== 200 || waiting.length) return `its files aren't all accepted yet (${unaccepted})`;
  if (held.size) return `its ${[...held].join(', ')} waits for its kit to send its file`;
  update(p.id, { placed_at: stamp(), error: null });
  log(`Parcel ${p.id} (${isTesterOrder(p.session) ? "a tester's, printed live" : p.mode}) placed at Print API as ${orderId(p)}, `
    + `${active.length} ${active.length === 1 ? 'line' : 'lines'}.`);
  for (const name of lapsedExtras(p))
    log(`NEEDS A PERSON: parcel ${p.id}'s ${name} went with the file stored at its placing: its kit didn't send its own by two `
      + 'minutes after its hold (down, or its file failing).');
  await refresh(row(p.id)!, back.body);
  return null;
}
// The parcel's order at Print API, or why there's none
async function findOrPlace(p: Parcel, active: Part[], address: Record<string, string>): Promise<any> {
  // (tester: a tester's order, as Print API's own list shows it)
  const id = orderId(p), metadata = JSON.stringify({ product: FRONT, parcel: p.id, ...(isTesterOrder(p.session) ? { tester: true } : {}) });
  let found = await printapi.call(printer(p), 'GET', orderPath(id));
  if (found.status === 404) {
    const lineItems = active.flatMap(part => (JSON.parse(part.items!) as Item[]).map((it, n) => ({ id: `${part.position}-${n}`,
      productId: it.productId, quantity: it.quantity, ...(it.pageCount === undefined ? {} : { pageCount: it.pageCount }),
      ...(it.options ? { options: it.options } : {}), files: null })));
    // hurried: at express speed only while it still ships by the hurry's day (a refused try is placed again later; review
    // finding)
    if (p.speed === 'Express' && p.hurry_by !== null && await missesDay(p, p.hurry_by)) {
      update(p.id, { speed: null });
      log(`Parcel ${p.id} (${p.mode}) goes to Print API at standard speed: express would no longer ship by ${p.hurry_by}.`);
    }
    const fresh = row(p.id)!, speed = fresh.speed === 'Express' ? { productionSpeed: 'Express' } : {};
    // with the company's own items if it has any (as hurried or not now), and without them if Print API refuses the order with them;
    // its documents made for the items it goes with, and never left out
    const chosen = await extrasFor(fresh, active);
    for (const withExtras of chosen.length ? [chosen, []] : [[]]) {
      const docs = await documentsFor(fresh, active, withExtras);
      if (typeof docs === 'string') return docs;
      const items = [...lineItems, ...[...withExtras, ...docs].map(x => ({ id: extraItem(x.name), productId: x.productId, quantity: x.quantity,
        ...(x.pageCount === undefined ? {} : { pageCount: x.pageCount }), ...(x.options ? { options: x.options } : {}), files: null }))];
      db.prepare('update parcel_extras set round = null where parcel = ? and round = ?').run(p.id, p.round);   // an earlier try's
      for (const [x, document] of [...withExtras.map(x => [x, null] as const), ...docs.map(x => [x, 1] as const)])
        db.prepare(`insert into parcel_extras (parcel, name, product, round, held_until, document) values (?, ?, ?, ?, ?, ?)
        on conflict (parcel, name) do update set product = excluded.product, round = excluded.round, held_until = excluded.held_until,
        document = excluded.document`).run(p.id, x.name, x.productId, p.round, x.holdUntil ?? null, document);
      const placed = await printapi.call(printer(p), 'POST', '/orders', { id, items, shipping: { preference: 'Auto', address }, metadata, ...speed });
      // 400: the id is taken (a lost answer, then it's ours: read below) or a refusal
      found = placed.status === 400 ? await printapi.call(printer(p), 'GET', orderPath(id)) : placed;
      if (found.status !== 404) break;
      if (withExtras.length) log(`Parcel ${p.id} (${p.mode}): Print API refused its order with its own items `
        + `(${withExtras.map(x => x.name).join(', ')}), so it goes without them.`);
      else if (docs.length) return `NEEDS A PERSON: Print API refused its order with its ${docs.map(x => x.name).join(', ')}, which it never goes without`;
    }
  }
  if (found.status >= 300) return `Print API answered ${found.status} (${id})`;
  if (parcelIn(found.body?.metadata) !== p.id) return `NEEDS A PERSON: Print API has an order ${id} that isn't this parcel's`;
  return found.body;   // an object: it carries the parcel's metadata
}
// The company's own items for this placing, from each kit in turn, their files kept with the parcel's until the order has
// them; none from a kit that failed, nor one whose file Print API refused before (the parcel never waits for them).
//
async function extrasFor(p: Parcel, active: Part[]): Promise<Extra[]> {
  for (const name of extraFiles(p.id)) rmSync(`${DIR}/${p.id}/${name}`, { force: true });   // an earlier try's
  const order = orderFor(p, active), dropped = droppedIn(p.id), chosen: Extra[] = [];
  for (const kit of extras) {
    let answer;
    try { answer = await kit({ ...order, chosen: [...chosen] }); }
    catch (err) {
      console.error(`Parcels: a kit's own item for ${p.id} failed, so it goes without it:`, err);
      continue;
    }
    for (const extra of [answer ?? []].flat()) {
      if (!ownItem(extra) || chosen.some(x => x.name === extra.name)) {
        console.error(`Parcels: an item of a kit's own for ${p.id} isn't one Print API takes, so it goes without it`);
        continue;
      }
      if (dropped.has(extra.name)) continue;
      chosen.push(holdAtMost(extra));
    }
  }
  // a kit's own item a person gave the file for, placing a cancelled parcel again by hand: as it went, in place of the
  // kit's own now
  for (const x of keptExtras(p).filter(x => !x.document)) {
    const extra = keptItem(p, x);
    if (!extra || dropped.has(x.name)) continue;
    const at = chosen.findIndex(c => c.name === x.name);
    if (at >= 0) chosen.splice(at, 1, extra); else chosen.push(extra);
  }
  keepFiles(p, chosen);
  return chosen;
}
// The parcel's documents for the items it goes with, or why it can't go: a kit
// that threw (its message), or an item Print API wouldn't take. A person's file for one, placing a cancelled parcel again
// by hand, goes in its place.
async function documentsFor(p: Parcel, active: Part[], withExtras: Extra[]): Promise<Extra[] | string> {
  const order = orderFor(p, active), made: Extra[] = [];
  for (const kit of documents) {
    let answer;
    try { answer = await kit({ ...order, chosen: [...withExtras] }); }
    catch (err) { return err instanceof Error && err.message ? err.message : "a document of its own couldn't be made"; }
    for (const doc of [answer ?? []].flat()) {
      if (!ownItem(doc) || [...withExtras, ...made].some(x => x.name === doc.name))
        return `NEEDS A PERSON: its ${doc?.name ?? 'document'} isn't an item Print API takes, and it never goes without`;
      made.push({ ...doc, holdUntil: undefined });
    }
  }
  for (const x of keptExtras(p).filter(x => x.document)) {
    const at = made.findIndex(d => d.name === x.name), doc = keptItem(p, x);
    if (at >= 0 && doc) made.splice(at, 1, doc);
  }
  for (const doc of made) for (const name of extraFiles(p.id).filter(n => n.startsWith(`extra-${doc.name}-`))) rmSync(`${DIR}/${p.id}/${name}`, { force: true });
  keepFiles(p, made);
  return made;
}
// What a company's kit is asked with: the parcel, its lines (their items and spare files' names) and every item of theirs
function orderFor(p: Parcel, active: Part[]) {
  const lines = active.map(part => ({ line: part.line, position: part.position, items: JSON.parse(part.items!) as Item[],
    spares: JSON.parse(part.spares ?? '[]') as string[] }));
  return { parcel: p, lines, items: lines.flatMap(l => l.items) };
}
// A kit's own item as Print API takes it: its name, product, quantity, pages and files
const ownItem = (x: Extra) => {
  const files = Object.entries(x?.files ?? {});
  return EXTRA.test(x?.name) && WORD.test(x.productId) && Number.isInteger(x.quantity) && x.quantity >= 1
    && (x.pageCount === undefined || (Number.isInteger(x.pageCount) && x.pageCount >= 1 && x.pageCount <= 1000))
    && files.length > 0 && files.every(([name, f]) => EXTRA.test(name) && !!EXTENSIONS[f.type] && !!printapi.fileType(f.type, Buffer.from(f.bytes)));
};
// A kit's item as a person's file placed it again by hand, or null when that file is gone
function keptItem(p: Parcel, x: KeptExtra): Extra | null {
  const file = storedAt(`${DIR}/${p.id}/kept-${x.name}-content`);
  const { document: _, ...item } = x;
  return file ? { ...item, files: { content: { bytes: new Uint8Array(readFileSync(file.path)), type: file.type } } } : null;
}
// Their files, kept with the parcel's until the order has them
function keepFiles(p: Parcel, items: Extra[]) {
  if (items.length) mkdirSync(`${DIR}/${p.id}`, { recursive: true, mode: 0o700 });
  for (const extra of items)
    for (const [name, f] of Object.entries(extra.files)) writeFileSync(`${DIR}/${p.id}/extra-${extra.name}-${name}.${EXTENSIONS[f.type]}`, f.bytes, { mode: 0o600 });
}
// A held file waits an hour at most
function holdAtMost(extra: Extra): Extra {
  if (extra.holdUntil === undefined) return extra;
  const until = Math.min(Date.parse(extra.holdUntil) || 0, Date.now() + HOLD_MAX_MS);
  return until > Date.now() ? { ...extra, holdUntil: new Date(until).toISOString() } : { ...extra, holdUntil: undefined };
}
const extraFiles = (parcel: string) => { try { return readdirSync(`${DIR}/${parcel}`).filter(n => n.startsWith('extra-')); } catch { return []; } };
// An extra's file in a state it can't go on from (still awaited after its upload, failed or cancelled): which, and why. A
// file Print API is still fetching or checking may yet be accepted.
const EXTRA_FILE_PENDING = new Set(['Accepted', 'UploadInProgress', 'DownloadPending', 'DownloadInProgress', 'DownloadRetryPending']);
function extraFilesRefused(items: unknown) {
  const refused = new Map<string, string>();
  for (const it of Array.isArray(items) ? items : []) {
    const name = extraOf(it?.id);
    const stuck = name && Object.values<any>(it?.files ?? {}).find(f => !EXTRA_FILE_PENDING.has(String(f?.status)));
    if (stuck) refused.set(name, `Print API has its file as ${word(stuck.status)}`);
  }
  return refused;
}
// The parcel's order, still Created, cancelled and placed again as the next round without the items Print API wouldn't
// take. When Print API doesn't cancel it at once, the parcel stays as it is, waiting, and says why.
async function placeWithoutExtras(p: Parcel, refused: Map<string, string>): Promise<string | null> {
  const names = [...refused.keys()].join(', '), why = [...refused].map(([name, w]) => `${name}: ${w}`).join('; ');
  const stays = `its ${names} can't go (${why}), and its order couldn't be cancelled to go without ${refused.size === 1 ? 'it' : 'them'}`;
  const now = await printapi.call(printer(p), 'GET', orderPath(orderId(p)));
  if (now.status !== 200 || now.body?.status !== 'Created') return stays;
  const reason = "One item's file wasn't taken: placed again without it";
  const asked = await printapi.call(printer(p), 'POST', `${orderPath(orderId(p))}/cancellation`, { reason });
  if (asked.body?.status !== 'Accepted') return stays;
  for (const name of extraFiles(p.id)) rmSync(`${DIR}/${p.id}/${name}`, { force: true });
  const drop = db.prepare('update parcel_extras set dropped = ? where parcel = ? and name = ?');
  for (const name of refused.keys()) drop.run(stamp(), p.id, name);
  update(p.id, { round: p.round + 1, order_status: null, placed_at: null, error: null });
  log(`Parcel ${p.id} (${p.mode}): its ${names} can't go (${why}), so its order ${orderId(p)} is cancelled and placed again without `
    + `${refused.size === 1 ? 'it' : 'them'}.`);
  placeSoon(p.id);
  return null;
}
// The files of an order's items Print API hasn't accepted (yet), as "<item> <file> <status>"
function filesAwaited(items: any[]) {
  const files = items.flatMap((it: any) => Object.entries<any>(it?.files ?? {}).map(([name, file]) => ({ item: it.id, name, file })));
  return files.filter(f => f.file?.status !== 'Accepted').map(f => `${f.item} ${f.name} ${word(f.file?.status)}`);
}
const parcelIn = (metadata: unknown) => { try { return JSON.parse(String(metadata))?.parcel ?? null; } catch { return null; } };
// The files Print API still awaits, sent. why: null once they are, else why not. extrasRefused: the company's own items
// whose file didn't go up (missing here, or refused), and why, while the lines' files still do.
async function upload(p: Parcel, active: Part[], order: any, held: Set<string>): Promise<{ why: string | null; extrasRefused: Map<string, string> }> {
  const extrasRefused = new Map<string, string>();
  for (const it of Array.isArray(order?.items) ? order.items : []) {
    const [position, n] = String(it?.id).split('-').map(Number), part = active.find(x => x.position === position);
    const extra = extraOf(it?.id);
    if (extra && held.has(extra)) continue;
    for (const [name, f] of Object.entries<any>(it?.files ?? {})) {
      if (f?.status !== 'AwaitingUpload' || typeof f.uploadUrl !== 'string' || !f.uploadUrl.startsWith('https://')) continue;
      const file = extra ? storedAt(`${DIR}/${p.id}/extra-${extra}-${name}`) : part ? stored(part, n, name) : null;
      if (!file && extra) { extrasRefused.set(extra, `its file isn't here (${word(name)})`); continue; }
      if (!file) return { why: `Print API awaits a file nobody sent (${it.id} ${word(name)})`, extrasRefused };
      const sent = await printapi.call(printer(p), 'POST', f.uploadUrl, new Uint8Array(readFileSync(file.path)), file.type);
      if (sent.status >= 300 && extra) { extrasRefused.set(extra, `Print API answered ${sent.status} to its file`); continue; }
      if (sent.status >= 300) return { why: `Print API answered ${sent.status} to the file for ${it.id} ${word(name)}`, extrasRefused };
    }
  }
  return { why: null, extrasRefused };
}
const word = (v: unknown) => String(v ?? 'unknown').replace(/[^A-Za-z]/g, '').slice(0, 24);

// ---- a company's own item whose file is held. The ones the parcel's current order
// holds back now: once a hold is over, its stored file goes with the rest.
const heldSince = () => new Date(Date.now() - HELD_GRACE_MS).toISOString();
function heldExtras(p: Parcel) {
  const rows = db.prepare(`select name from parcel_extras where parcel = ? and round = ? and dropped is null and held_until > ?`)
    .all(p.id, p.round, heldSince()) as { name: string }[];
  return new Set(rows.map(x => x.name));
}
// The parcel's current order's items whose hold ended without their kit's release: their stored files go (or went)
function lapsedExtras(p: Parcel) {
  const rows = db.prepare(`select name from parcel_extras where parcel = ? and round = ? and dropped is null and held_until <= ?`)
    .all(p.id, p.round, heldSince()) as { name: string }[];
  return rows.map(x => x.name);
}
// Whether the parcel's item of this name goes with the file stored at its placing, its kit too late to send its own
export const heldLapsed = (parcel: string, name: string) => {
  const p = row(parcel);
  return !!p && lapsedExtras(p).includes(name);
};
// The waiting parcels whose order holds back a kit's item of this name now, for its kit to release
export const holding = (name: string) => db.prepare(`select p.id, p.session from parcels p join parcel_extras e on e.parcel = p.id
  and e.round = p.round where e.name = ? and p.status = 'waiting' and e.dropped is null and e.held_until > ?`)
  .all(name, heldSince()) as { id: string; session: string }[];
// Ends a held item's hold: its file goes up with the new bytes if its kit gives them (each file it had, as Print API takes
// it), else as stored at the placing, and the parcel's placing carries on as for any file. 'released' then, 'none' when
// the parcel holds no such file now (placed already, placed again without it, or its stored file gone after its hold).
export type Release = 'released' | 'none';
export const release = (parcel: string, name: string, files?: Record<string, ExtraFile>) => inQueue(parcel, async (): Promise<Release> => {
  const p = row(parcel);
  if (p?.status !== 'waiting' || !heldExtras(p).has(name)) return 'none';
  if (files) keepExtraFiles(p, name, files);
  db.prepare('update parcel_extras set held_until = null where parcel = ? and name = ?').run(p.id, name);
  placeSoon(p.id);
  return 'released';
});
// A kit's new bytes for its held item, over the stored ones: only files it had, as Print API takes them
function keepExtraFiles(p: Parcel, name: string, files: Record<string, ExtraFile>) {
  const kept = extraFiles(p.id).filter(f => f.startsWith(`extra-${name}-`));
  for (const [file, f] of Object.entries(files)) {
    const fine = EXTRA.test(file) && !!EXTENSIONS[f.type] && !!printapi.fileType(f.type, Buffer.from(f.bytes));
    const old = kept.find(k => k.replace(/\.[a-z]+$/, '') === `extra-${name}-${file}`);
    if (!fine || !old) {
      console.error(`Parcels: a kit's new file for ${p.id}'s ${name} isn't one it had, as Print API takes it, so the stored one goes`);
      continue;
    }
    rmSync(`${DIR}/${p.id}/${old}`, { force: true });
    writeFileSync(`${DIR}/${p.id}/extra-${name}-${file}.${EXTENSIONS[f.type]}`, f.bytes, { mode: 0o600 });
  }
}
const STATUS: Record<string, Parcel['status']> = { Created: 'placed', Processing: 'printing', Shipped: 'shipped', Cancelled: 'cancelled' };
const statusOf = (s: unknown) => STATUS[String(s)] ?? 'placed';

// ---- reading it back: status, the day it shipped and its tracking link. A parcel Print API cancelled itself is cancelled
// for every line in it; once it's printing or shipped Print API has its files, so they go here (unless a cancellation
// asked before printing is still unanswered); a cancelled one keeps them as any cancel does (KEEP_CANCELLED).
async function refresh(p: Parcel, known?: any) {
  const order = known ?? (await printapi.call(printer(p), 'GET', orderPath(orderId(p)))).body;
  if (!order) return;
  if (cancelling(p)) {
    await settleCancellation(p);
    if (row(p.id)!.round !== p.round) return;   // cancelled for the lines taken out (or to go express): placed again
  }
  const status = statusOf(order.status), tracking = trackingOf(order.trackingUrl);
  // a tester's parcel is the board's to cancel (nothing was paid): its lines close with nothing to refund, and the
  // tester's voucher pays a basket again (payments.ts sentNothing).
  if (status === 'cancelled' && p.status !== 'cancelled')
    log(isTesterOrder(p.session)
      ? `Print API cancelled tester parcel ${p.id}'s order ${orderId(p)}: nothing to refund, and the tester's voucher works again.`
      : `NEEDS A PERSON: Print API cancelled parcel ${p.id}'s order ${orderId(p)} (${p.mode}). Each product refunds its line; look at why.`);
  update(p.id, { status, order_status: word(order.status), checked: Date.now(),
    ...(status === 'shipped' && !p.shipped_at ? { shipped_at: stamp() } : {}), ...(tracking && !p.tracking ? { tracking } : {}) });
  // a cancellation still unanswered may yet put the parcel back to waiting, to be placed again with these files
  if (status !== 'placed' && status !== 'cancelled' && !cancelling(row(p.id)!)) dropFiles(p.id);
}
// Print API's tracking link, only an https one ("not always right away": taken the first time it's there)
function trackingOf(u: unknown) {
  try { const url = new URL(String(u)); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}

// ---- what a line's view says about its parcel (payments.ts lineView), and what the rest of payments asks
function view(line: Line) {
  const part = partOf(line.id), p = part ? row(part.parcel) : undefined;
  if (!part || !p) return { line: line.id, parcel: null };
  return { line: line.id, ...parcelPart(part, p) };
}
// A line still in its parcel ships with its slowest line: its ship_by is the latest of theirs
function parcelPart(part: Part, p: Parcel) {
  const others = db.prepare(`select l.product, l.reference from parcel_lines pl join pay_lines l on l.id = pl.line
    where pl.parcel = ? and pl.line != ? and pl.removed is null order by pl.position`)
    .all(p.id, part.line) as { product: string; reference: string }[];
  const inParcel = db.prepare(`select l.* from parcel_lines pl join pay_lines l on l.id = pl.line
    where pl.parcel = ? and (pl.removed is null or pl.removed = 'asked')`).all(p.id) as Line[];
  const shipsWith = part.removed === 'done' ? {} : { ship_by: latestOf(inParcel.map(line => shipBy(line))) };
  return { ...shipsWith, parcel: { status: p.status, handed: !!part.handed, removed: part.removed, express: p.speed === 'Express', shipped_at: p.shipped_at,
    tracking: p.tracking, error: p.status === 'waiting' ? p.error : null,
    with: others.map(o => ({ shop: shopName(o.product), reference: o.reference })) } };
}
const latestOf = (stamps: string[]) => stamps.reduce((a, b) => (b > a ? b : a));
const shopName = (slug: string) => { const n = manifest(slug)?.name; return typeof n === 'string' && n.length <= 60 ? n : slug; };

lineParts.push(line => {
  if (line.status !== 'paid' || !line.session) return null;
  const p = parcelOf(line.session), part = partOf(line.id);
  return p && part ? parcelPart(part, row(p.id)!) : null;
});
// money back waits until the line is out of its parcel (or the parcel shipped, or Print API cancelled it): never a refund
// for something still going to print
lineRefundGuards.push((_c, line) => {
  const p = line.session ? parcelOf(line.session) : undefined, part = p ? partOf(line.id) : undefined;
  if (!part || !p || part.removed === 'done' || p.status === 'shipped' || p.status === 'cancelled') return null;
  return "this line is still in its parcel: take it out first (POST /api/pay/parcel/cancel), which stops its printing if it hasn't started";
});
// (at most 30 days, payments.tick) while the parcel may still be placed (again): waiting, placed, or a cancellation of its
// order unanswered, which puts it back to waiting once accepted
keepAddress.push(session => {
  const p = db.prepare('select * from parcels where session = ?').get(session) as Parcel | undefined;
  return !!p && mayBePlaced(p);
});
const mayBePlaced = (p: Parcel) => p.status === 'waiting' || p.status === 'placed' || cancelling(p);
// A line its customer asked us to delete keeps its print files only while its parcel may still be placed with it; the
// tick drops them once it can't.
lineForgotten.push(async line => {
  const part = partOf(line.id);
  if (!part) return;
  db.prepare('update parcel_lines set forget_asked = ? where line = ? and forget_asked is null').run(stamp(), line.id);
  await inQueue(part.parcel, async () => dropForgotten(row(part.parcel)!));
});
// A kit's own items copy a line's design (a magnet's file): with the parcel closed they go with it
function dropForgotten(p: Parcel) {
  const gone = parts(p.id).filter(x => x.forget_asked && (x.removed === 'done' || !mayBePlaced(p)));
  for (const part of gone) dropFiles(p.id, part.line);
  if (gone.length && !mayBePlaced(p)) for (const name of extraFiles(p.id)) rmSync(`${DIR}/${p.id}/${name}`, { force: true });
}
parcelCancelled.push(session => (db.prepare('select status from parcels where session = ?').get(session) as Pick<Parcel, 'status'> | undefined)?.status === 'cancelled');
// A paid basket's records ending (records.ts) end its parcel's
recordsEnded.push(session => {
  const p = parcelOf(session);
  if (!p) return;
  for (const table of ['parcel_lines', 'parcel_extras']) db.prepare(`delete from ${table} where parcel = ?`).run(p.id);
  db.prepare('delete from parcels where id = ?').run(p.id);
  rmSync(`${DIR}/${p.id}`, { recursive: true, force: true });
});
// hq orders: a parcel's live order is ours (a tester's, from: 'tester parcel': nothing paid for it)
printapi.registerOrders(id => {
  const m = /^(pc_[a-f0-9]{16})-\d+$/.exec(id), p = m ? row(m[1]) : undefined;
  return p ? { shop: FRONT, ours: { from: isTesterOrder(p.session) ? 'tester parcel' : 'parcel', status: p.status, amount: null, currency: null } } : null;
});

// For a reprint of one line (a company's own tool): the parcel's order it went in, the prefix of its items' ids there, and
// the Print API environment it was printed in
export function placedAs(line: string) {
  const part = partOf(line), p = part ? row(part.parcel) : undefined;
  return p && part && !part.removed && p.status !== 'waiting' ? { order: orderId(p), items: `${part.position}-`, printer: printer(p) } : null;
}

// A basket's parcel by its payment's session, for the job investigating its customer's care card (care.ts ordersForJob): its
// order at Print API and how it stands, ids and statuses only; null before HQ made it
export function parcelView(session: string) {
  const p = db.prepare('select * from parcels where session = ?').get(session) as Parcel | undefined;
  return p ? { order: orderId(p), status: p.status, order_status: p.order_status, shipped_at: p.shipped_at } : null;
}

// The lines that went in the same parcel as this one, itself included
export const linesWith = (line: string) => { const part = partOf(line); return part ? parts(part.parcel).map(x => x.line) : []; };

// The lines a basket's parcel holds, in the basket's order (one taken out left out; one whose taking out was never
// answered went with it), each followed by the shop's own lines going with it that were paid and not refunded (a refund
// that failed or was canceled isn't one): what its shipped email lists.
export function linesIn(session: string) {
  const things = db.prepare(`select l.* from parcels p join parcel_lines pl on pl.parcel = p.id join pay_lines l on l.id = pl.line
    where p.session = ? and (pl.removed is null or pl.removed = 'asked') order by pl.position`).all(session) as Line[];
  const own = (db.prepare(`select l.* from session_lines sl join pay_lines l on l.id = sl.line
    where sl.session = ? and l.goes_with is not null and l.status = 'paid' order by sl.position`).all(session) as Line[])
    .filter(l => !l.refund_status || l.refund_status === 'failed' || l.refund_status === 'canceled');
  return things.flatMap(thing => [thing, ...own.filter(l => l.goes_with === thing.id)]);
}

// ---- hurrying a parcel (a company's own tool decides when). Print API makes an order
// at express speed for about 7% more on its items (its product pages say so), sooner where the product allows it: fewer
// days, or a later cut-off hour (each product's productionTimes).
export const EXPRESS_EXTRA = 7;   // percent
const printProducts = new Map<string, { at: number; product: Promise<any> }>();
// a product's production times and cost at Print API, read at most hourly (the catalogue rarely changes)
function printProduct(mode: printapi.Mode, id: string) {
  const key = `${mode}:${id}`, known = printProducts.get(key);
  if (known && Date.now() - known.at < 60 * MIN) return known.product;
  const product = printapi.call(mode, 'GET', `/products/${encodeURIComponent(id)}`).then(r => {
    if (r.status !== 200 || !r.body) throw new printapi.PrintApiError(502, `Print API answered ${r.status} (GET /products/…)`);
    return r.body;
  });
  printProducts.set(key, { at: Date.now(), product });
  product.catch(() => printProducts.delete(key));
  return product;
}
export type HurryQuote = { hurry: 'possible' | 'already' | 'too_late';
  why: null | 'printing' | 'shipped' | 'cancelled' | 'not_in_parcel' | 'no_address' | 'no_express' | 'not_ready';
  country: string | null; ship_by: string | null; ship_by_express: string | null; extra: number | null };
// What hurrying the parcel a line is in would do now: whether it can still go express, the day it ships as it is, the day
// it would ship placed again at express speed now, and what that adds to Print API's bill (cents, excluding VAT; null when
// a product's cost can't be read). Print API is asked how the order stands first: the timer reads it only every 10
// minutes. As it is, the parcel ships on its slowest line's ship_by, or, once that day is past (an order Print API left
// Created), no sooner than a standard run started now would (review finding).
export async function hurryQuote(line: string, now = Date.now()): Promise<HurryQuote> {
  const known = partOf(line);
  const not = (hurry: HurryQuote['hurry'], why: HurryQuote['why'], country: string | null = null) =>
    ({ hurry, why, country, ship_by: null, ship_by_express: null, extra: null });
  if (!known) return not('too_late', 'not_in_parcel');
  return inQueue(known.parcel, async () => {
    const part = partOf(line)!, p = row(part.parcel)!;
    const payment = db.prepare('select country from payments where id = ?').get(p.session) as { country: string | null } | undefined;
    const country = payment?.country ?? null;
    if (part.removed) return not('too_late', 'not_in_parcel', country);
    if (p.speed === 'Express') return not('already', null, country);
    const { stops } = await atPrinter(p);
    if (stops) return not('too_late', stops, country);
    const fast = await express(p, now);
    if (typeof fast === 'string') return not('too_late', fast, country);
    const today = new Date(now).toISOString().slice(0, 10);
    // (a day already past: from now, with what every parcel holds besides)
    const fromNow = (l: Line) => latestOf([shipDay(now, l.ships_in, l.cutoff), ...everyParcel.map(x => shipDay(now, x.days, x.cutoff))]);
    const asItIs = activeLines(p).map(l => { const told = shipBy(l); return told >= today ? told : fromNow(l); });
    return { hurry: 'possible', why: null, country, ship_by: latestOf(asItIs), ship_by_express: fast.day, extra: fast.extra };
  });
}
const activeLines = (p: Parcel) => db.prepare(`select l.*, pl.items, pl.handed from parcel_lines pl join pay_lines l on l.id = pl.line
  where pl.parcel = ? and pl.removed is null order by pl.position`).all(p.id) as (Line & { items: string | null; handed: string | null })[];
// The day the parcel would ship placed at express speed now, and what that adds to Print API's bill. Not while a line
// isn't handed over (not_ready: what its items are, and whether Print API makes them at express speed, isn't known yet;
// once handed over they can't change), nor when an item's product is made at standard speed only (no_express: no Express
// in its productionTimes, like spiral books: its order would be refused or made at standard speed after all) (review findings)
async function express(p: Parcel, now: number): Promise<{ day: string; extra: number | null } | 'not_ready' | 'no_express'> {
  const lines = activeLines(p);
  if (lines.some(l => !l.handed)) return 'not_ready';
  let day = '', cost: number | null = 0;
  // its documents are made again at express speed with it, their cost (a few cents) left out of the extra
  const docs = db.prepare('select product from parcel_extras where parcel = ? and round = ? and document = 1').all(p.id, p.round) as { product: string }[];
  for (const doc of docs) {
    const times = (await printProduct(printer(p), doc.product))?.productionTimes;
    const fast = Array.isArray(times) ? times.find((t: any) => t?.speed === 'Express') : undefined;
    if (!fast || !Number.isInteger(fast.days) || !Number.isInteger(fast.limitHour)) return 'no_express';
    day = latestOf([day, shipDay(now, fast.days, fast.limitHour)]);
  }
  // no document rows yet (not placed, or its round just began): what every parcel holds goes at its standard time
  if (!docs.length) for (const x of everyParcel) day = latestOf([day, shipDay(now, x.days, x.cutoff)]);
  for (const l of lines) for (const it of JSON.parse(l.items!) as Item[]) {
    const product = await printProduct(printer(p), it.productId);
    const times = Array.isArray(product?.productionTimes) ? product.productionTimes : [];
    const fast = times.find((t: any) => t?.speed === 'Express');
    if (!fast) return 'no_express';
    const days = Number.isInteger(fast.days) && fast.days > 0 ? fast.days : l.ships_in;
    const cutoff = Number.isInteger(fast.limitHour) ? fast.limitHour : l.cutoff;
    day = latestOf([day, shipDay(now, days, cutoff)]);
    const itemCost = costOf(product, it);
    cost = cost === null || itemCost === null ? null : cost + itemCost * it.quantity;
  }
  return { day, extra: cost === null ? null : Math.ceil(cost * EXPRESS_EXTRA / 100) };
}
// express placed now would ship after `by` (or can't be had at all)
async function missesDay(p: Parcel, by: string) {
  const fast = await express(p, Date.now());
  return typeof fast === 'string' || fast.day > by;
}
// What Print API charges for one item, in cents: its base cost, and each page past the product's minimum (null: the
// catalogue doesn't say)
function costOf(product: any, it: Item) {
  const base = product?.cost?.base, perPage = product?.cost?.perExtraPage ?? 0, minimum = product?.minPageCount ?? 0;
  if (typeof base !== 'number' || typeof perPage !== 'number' || typeof minimum !== 'number') return null;
  const extraPages = it.pageCount === undefined ? 0 : Math.max(0, it.pageCount - minimum);
  return Math.round((base + perPage * extraPages) * 100);
}
// Why a parcel can't go express any more (stops: null while it can), with Print API's word on an order it has (order: it
// has one, still Created): once it's printing, shipped or cancelled, or it can't be placed again (its address or files gone)
async function atPrinter(p: Parcel): Promise<{ stops: HurryQuote['why']; order: boolean }> {
  if (p.status === 'cancelled' || p.status === 'printing' || p.status === 'shipped') return { stops: p.status, order: true };
  if (p.status === 'placed' && (!addressOf(p) || !existsSync(`${DIR}/${p.id}`))) return { stops: 'no_address', order: true };
  const now = p.status === 'placed' || printapi.keys(printer(p)) ? await printapi.call(printer(p), 'GET', orderPath(orderId(p))) : null;
  if (!now || (p.status === 'waiting' && now.status === 404)) return { stops: null, order: false };
  if (now.status !== 200) throw new printapi.PrintApiError(502, `Print API answered ${now.status} (GET /orders/…)`);
  if (now.body?.status === 'Created') return { stops: null, order: true };
  await refresh(p, now.body);
  const s = row(p.id)!.status;
  return { stops: s === 'cancelled' || s === 'shipped' ? s : 'printing', order: true };
}

// Hurry the parcel a line is in: at once while Print API has no order for it yet, else by cancelling its order (still
// Created: nothing printed) and placing it again at express speed, as a line taken out is. by (YYYY-MM-DD, or null): the
// last day it may ship at express speed and still be of use, checked before anything is cancelled and again if Print API
// accepts the cancellation later. Asking again is safe, it says how it stands: 'express' once it goes (or went) express,
// 'asked' while Print API hasn't answered the cancellation, 'too_late' once printing started or it can't go express (it
// can't be placed again, a line isn't handed over yet, or a product is made at standard speed only), 'misses_date' when
// express wouldn't ship by `by` (now, or once the cancellation came through: placed again as it was; nothing spent),
// 'try_again' when Print API didn't answer.
export type Hurried = 'express' | 'asked' | 'too_late' | 'misses_date' | 'try_again';
export async function hurry(line: string, by: string | null = null): Promise<Hurried> {
  const known = partOf(line);
  if (!known) return 'too_late';
  // no answer from Print API: as it stands (a cancellation asked stays asked: the next try reads it)
  return inQueue(known.parcel, () => hurryNow(line, by)).catch(err => { if (err instanceof printapi.PrintApiError) return 'try_again'; throw err; });
}
async function hurryNow(line: string, by: string | null): Promise<Hurried> {
  const part = partOf(line)!, p = row(part.parcel)!;
  if (part.removed) return 'too_late';
  if (p.hurry === 'asked') return settled(p);
  if (p.speed === 'Express') return 'express';
  const fast = await express(p, Date.now());
  if (typeof fast === 'string') return 'too_late';
  if (by !== null && fast.day > by) return 'misses_date';
  // a cancellation for a line taken out is under way: the parcel goes express when it's placed again
  if (cancelling(p)) { update(p.id, { speed: 'Express', hurry: 'asked', hurry_by: by }); return settled(row(p.id)!); }
  const at = await atPrinter(p);
  if (at.stops) return 'too_late';
  if (!at.order) {
    update(p.id, { speed: 'Express', hurry_by: by });
    log(`Parcel ${p.id} (${p.mode}) is hurried: it goes to Print API at express speed.`);
    placeSoon(p.id);
    return 'express';
  }
  update(p.id, { speed: 'Express', hurry: 'asked', hurry_by: by });   // first: if Print API's answer is lost, the next read settles it
  const asked = await printapi.call(printer(p), 'POST', `${orderPath(orderId(p))}/cancellation`, { reason: 'Placed again at express speed' });
  // an error may still have been taken: read where the cancellation stands rather than call the hurry off unread (it's
  // called off there if Print API never got it)
  if (asked.status >= 300 && asked.status !== 409) return settled(row(p.id)!);
  log(`Parcel ${p.id} (${p.mode}) is hurried: its order ${orderId(p)} is being cancelled to be placed again at express speed.`);
  return settled(row(p.id)!);
}
// where a hurry's cancellation stands, as far as Print API has answered
async function settled(p: Parcel): Promise<Hurried> {
  const refused = await settleCancellation(p), now = row(p.id)!;
  if (now.hurry === 'asked') return 'asked';
  if (now.speed === 'Express') return 'express';
  if (!refused) return 'misses_date';   // accepted, and placed again as it was (settleCancellation)
  return refused[0] === 502 ? 'try_again' : 'too_late';
}

// ---- placing a parcel again by hand (a company's own tool decides who may). A placed parcel whose order is still Created:
// its order is cancelled and placed again as it is, as for a hurry, each kit deciding its own items again. A parcel Print
// API cancelled: Print API's own record of that order gives its items (each line's by its place in the basket, and the
// kits') and the delivery address, which goes back to the basket's payment, kept while the parcel may be placed
// (keepAddress) and passed on to nobody. Each line's item takes the print file given for it (files: by its id in the order,
// 1-0; one file per item), and a kit's item one given for it as it went (kept), else its kit decides again; a tester's
// order takes its voucher back, unless the voucher has paid another order since. Answers how the parcel stands as its
// placing starts (againView), or why not.
export type AgainFile = { bytes: Uint8Array; type: string };
export async function again(id: string, files: Record<string, AgainFile> = {}): Promise<AgainView | [number, string]> {
  if (!row(id)) return [404, `no parcel ${id}`];
  const refused = await inQueue(id, async () => {
    const p = row(id)!;
    if (p.status !== 'cancelled') return cancelForAgain(p, files);
    return forgotten(p) ?? refundedLines(p) ?? fromRecord(p, files);
  });
  if (refused) return refused;
  placeSoon(id);   // its placing goes on after the answer (againRecord reads how it stands)
  return againView(id)!;
}
async function cancelForAgain(p: Parcel, files: Record<string, AgainFile>): Promise<[number, string] | null> {
  if (Object.keys(files).length) return [400, `print files go only with a parcel Print API cancelled, and this one is ${p.status}`];
  if (cancelling(p)) return settleCancellation(p);   // being cancelled already: placed again, its kits asked again, once Print API accepts
  if (p.status === 'waiting') return null;            // its kits are asked at its placing
  if (p.status !== 'placed') return [409, `this parcel is ${p.status}: it can't be placed again`];
  if (!addressOf(p) || !existsSync(`${DIR}/${p.id}`)) return [409, "this parcel's delivery address or files are gone, so it can't be placed again as it is"];
  const now = await printapi.call(printer(p), 'GET', orderPath(orderId(p)));
  if (now.status !== 200) return [502, `Print API answered ${now.status}: try again in a minute`];
  if (now.body?.status !== 'Created') { await refresh(p, now.body); return [409, PRINTING]; }
  update(p.id, { again: 'asked' });   // first: if Print API's answer is lost, the next read settles it
  const asked = await printapi.call(printer(p), 'POST', `${orderPath(orderId(p))}/cancellation`, { reason: 'Placed again by hand' });
  if (asked.status < 300 || asked.status === 409) log(`Parcel ${p.id} (${p.mode}) is placed again by hand: its order ${orderId(p)} is being cancelled.`);
  return settleCancellation(row(p.id)!);
}
// A customer who asked us to delete their details: their parcel isn't made again from Print API's record, which would
// bring their address and designs back. (exported for a company's own reprint tool)
export function forgotten(p: Pick<Parcel, 'session'>): [number, string] | null {
  const asked = (db.prepare('select forget_asked from payments where id = ?').get(p.session) as { forget_asked: string | null } | undefined)?.forget_asked;
  return asked ? [409, 'its customer asked us to delete their details: it isn\'t placed again by hand'] : null;
}
// A line refunded to its buyer is closed for good, so only a tester's parcel (nothing was paid) is placed again from a
// cancelled order
function refundedLines(p: Parcel): [number, string] | null {
  if (isTesterOrder(p.session)) return null;
  const refunded = db.prepare(`select 1 from parcel_lines pl join pay_lines l on l.id = pl.line where pl.parcel = ?
    and (l.refund is not null or l.refund_status is not null or l.refund_asked is not null)`).get(p.id);
  return refunded ? [409, "a line of this parcel was refunded to its buyer: it isn't placed again by hand (a reprint goes through the remedies)"] : null;
}
const ADDRESS_FIELDS = ['name', 'company', 'line1', 'line2', 'postCode', 'city', 'state', 'country'];
// An item of a cancelled order's record at Print API that can go again here (placeableItem)
type OrderItem = { id: string; productId: string; quantity: number; pageCount?: unknown; options?: unknown };
type CancelledOrder = { id: string; address: Record<string, string>; items: OrderItem[] };
// Each line's items in their order (none: the line was out of it), how many that is, and the kits' items given a file
type AgainPlan = { ofLine: Map<Part, OrderItem[]>; lineItems: number; kept: OrderItem[] };
async function fromRecord(p: Parcel, files: Record<string, AgainFile>): Promise<[number, string] | null> {
  const order = await cancelledOrder(p);
  if (Array.isArray(order)) return order;
  const refunded = refundedLines(p);   // a refund (its own queue) may have been asked while Print API answered
  if (refunded) return refunded;
  const plan = planAgain(order, parts(p.id), files);
  return Array.isArray(plan) ? plan : placeFromRecord(p, order, plan, files);
}
// Print API's record of the parcel's cancelled order: its delivery address and its items, or why it can't go again from it
async function cancelledOrder(p: Parcel): Promise<CancelledOrder | [number, string]> {
  if (!printapi.keys(printer(p))) return [503, `no Print API ${printer(p)} keys on the server yet`];
  const id = orderId(p), now = await printapi.call(printer(p), 'GET', orderPath(id)), o = now.body;
  if (now.status === 404) return [404, `Print API has no order ${id}`];
  if (now.status !== 200) return [502, `Print API answered ${now.status}: try again in a minute`];
  if (o?.status !== 'Cancelled') return [409, `Print API has order ${id} as ${word(o?.status)}, not cancelled`];
  if (parcelIn(o.metadata) !== p.id) return [409, `Print API's order ${id} isn't this parcel's`];
  const given = o.shipping?.address ?? {};
  const fields = ADDRESS_FIELDS.filter(k => typeof given[k] === 'string' && given[k]);
  const address = Object.fromEntries(fields.map(k => [k, given[k] as string]));
  if (['name', 'line1', 'postCode', 'city', 'country'].some(k => !address[k]))
    return [502, `Print API's record of order ${id} has no whole delivery address, so it can't be placed again from it`];
  const items: unknown[] = Array.isArray(o.items) ? o.items : [];
  if (!items.length || !items.every(placeableItem))
    return [409, `order ${id} has items that can't be placed again here (one print file per item only)`];
  return { id, address, items };
}
// A line's item (1-0) or a kit's (x-card), with a product, a quantity and one print file
function placeableItem(item: unknown): item is OrderItem {
  const it = (item ?? {}) as { id?: unknown; productId?: unknown; quantity?: unknown; files?: unknown };
  const ownId = /^\d+-\d+$/.test(String(it.id)) || !!extraOf(it.id);
  const oneFile = Object.keys(it.files ?? { content: 1 }).every(k => k === 'content');
  return ownId && WORD.test(String(it.productId)) && Number.isInteger(it.quantity) && Number(it.quantity) >= 1 && oneFile;
}
// A line's item id as its line's place in the basket and its own place among the line's items (1-0: [1, 0])
const itemPlace = (item: OrderItem) => String(item.id).split('-').map(Number) as [number, number];
// An item of Print API's record as it's placed again: its product, quantity, pages and options, one print file
function placedItem(item: OrderItem): Item {
  const options = (Array.isArray(item.options) ? item.options : []) as { id?: unknown; value?: unknown }[];
  const own = options.filter(o => WORD.test(String(o?.id)) && WORD.test(String(o?.value)))
    .map(o => ({ id: String(o.id), value: String(o.value) }));
  const pages = Number.isInteger(item.pageCount) ? { pageCount: Number(item.pageCount) } : {};
  return { productId: item.productId, quantity: item.quantity, ...pages, ...(own.length ? { options: own } : {}), files: ['content'] };
}
// Which of the order's items goes where, with the files given; or why they don't fit this parcel
function planAgain(order: CancelledOrder, all: Part[], files: Record<string, AgainFile>): AgainPlan | [number, string] {
  const { id, items } = order;
  for (const [item, f] of Object.entries(files)) {
    if (!items.some(it => it.id === item)) return [400, `order ${id} has no item ${item}: its items are ${items.map(it => it.id).join(', ')}`];
    if (!printapi.fileType(f.type, Buffer.from(f.bytes))) return [400, `the file for ${item}: a JPEG, PNG or PDF, with its type`];
  }
  const lineItems = items.filter(it => !extraOf(it.id));
  const missing = lineItems.filter(it => !files[it.id]).map(it => `${it.id} (${it.productId})`);
  if (missing.length) return [400, `a print file for each line's item: none for ${missing.join(', ')}`];
  const lost = lineItems.find(it => !all.some(part => part.position === itemPlace(it)[0]));
  if (lost) return [409, `item ${lost.id} of order ${id} is no line of this parcel`];
  const byPlace = (a: OrderItem, b: OrderItem) => itemPlace(a)[1] - itemPlace(b)[1];
  const ofLine = new Map(all.map(part => [part, lineItems.filter(it => itemPlace(it)[0] === part.position).sort(byPlace)]));
  if ([...ofLine.values()].some(own => own.some((it, n) => itemPlace(it)[1] !== n)))
    return [409, `order ${id} misses an item of one of its lines`];
  return { ofLine, lineItems: lineItems.length, kept: items.filter(it => extraOf(it.id) && files[it.id]) };
}
// The parcel made again as planned. A tester's order first takes its voucher back, and is refused when the voucher has
// paid another order since (both would print on one voucher); then its files and rows, and the delivery address back
// where a parcel's placing reads it (payments.ts keeps it while the parcel may be placed).
function placeFromRecord(p: Parcel, order: CancelledOrder, plan: AgainPlan, files: Record<string, AgainFile>): [number, string] | null {
  const since = isTesterOrder(p.session) ? retakeTesterOrder(p.session) : null;
  if (since) {
    const other = (db.prepare('select id from parcels where session = ?').get(since) as { id: string } | undefined)?.id;
    const named = other ? `parcel ${other}` : since;
    return [409, `its tester's voucher has paid another order since (${named}): it isn't placed again beside that one`];
  }
  dropFiles(p.id);
  mkdirSync(`${DIR}/${p.id}`, { recursive: true, mode: 0o700 });
  const write = (base: string, f: AgainFile) => writeFileSync(`${base}.${EXTENSIONS[f.type]}`, f.bytes, { mode: 0o600 });
  for (const [part, own] of plan.ofLine) {
    if (!own.length) { db.prepare("update parcel_lines set removed = 'done' where line = ?").run(part.line); continue; }
    db.prepare('update parcel_lines set items = ?, handed = ?, removed = null where line = ?')
      .run(JSON.stringify(own.map(placedItem)), stamp(), part.line);
    own.forEach((it, n) => write(filePath(part, n, 'content'), files[it.id]));
  }
  const kept = plan.kept.map(it => {
    const name = extraOf(it.id)!, { productId, quantity, pageCount, options } = placedItem(it);
    write(`${DIR}/${p.id}/kept-${name}-content`, files[it.id]);
    const document = documentsIn(p).includes(name);
    return { name, productId, quantity, ...(pageCount === undefined ? {} : { pageCount }), ...(options ? { options } : {}),
      ...(document ? { document } : {}) };
  });
  db.prepare('update payments set deliver = ? where id = ?').run(JSON.stringify(order.address), p.session);
  update(p.id, { status: 'waiting', round: p.round + 1, order_status: null, placed_at: null, shipped_at: null, tracking: null, error: null,
    nagged: null, checked: 0, again: null, kept: kept.length ? JSON.stringify(kept) : null });
  const whose = isTesterOrder(p.session) ? "a tester's, printed live" : p.mode;
  const asWent = kept.length ? `, ${kept.map(x => x.name).join(', ')} as ${kept.length === 1 ? 'it' : 'they'} went` : '';
  log(`Parcel ${p.id} (${whose}) is placed again by hand from Print API's record of its cancelled order ${order.id}: `
    + `${plan.lineItems} ${plan.lineItems === 1 ? 'item' : 'items'} with the files given${asWent}.`);
  return null;
}
type KeptExtra = Omit<Extra, 'files' | 'holdUntil'> & { document?: boolean };
const keptExtras = (p: Parcel): KeptExtra[] => JSON.parse(p.kept ?? '[]');
// How a parcel stands, for the tool that placed it again: ids and statuses only. items: Print API's record of its current
// order (each item's id, product and quantity), null when Print API has none.
export type AgainView = { parcel: string; status: Parcel['status']; order: string; order_status: string | null; again: 'asked' | null;
  extras: string[]; error: string | null; items: { id: string; productId: string; quantity: number }[] | null };
export function againView(id: string, items: AgainView['items'] = null): AgainView | null {
  const p = row(id);
  return p ? { parcel: p.id, status: p.status, order: orderId(p), order_status: p.order_status, again: p.again, extras: extrasIn(p.id),
    error: p.status === 'waiting' ? p.error : null, items } : null;
}
export async function againRecord(id: string) {
  const p = row(id);
  if (!p) return null;
  const o = printapi.keys(printer(p)) ? await printapi.call(printer(p), 'GET', orderPath(orderId(p))) : null;
  const items = o?.status === 200 && Array.isArray(o.body?.items)
    ? (o.body.items as any[]).map(it => ({ id: String(it?.id), productId: String(it?.productId), quantity: Number(it?.quantity) })) : null;
  return againView(id, items);
}
// A parcel by its own id, or by its order's at Print API (<parcel>-<round>), with the basket's payment it's for
export function parcelNamed(name: string) {
  const p = row((/^(pc_[a-f0-9]{16})(-\d+)?$/.exec(name) ?? [])[1] ?? '');
  return p ? { id: p.id, session: p.session } : null;
}

// ---- every 2 minutes: a parcel for each new paid basket, parcels ready placed (a failed try again), a cancellation
// Print API hadn't answered, a parcel never placed given up, placed parcels' status read every 10 minutes (shipped ones
// until their tracking link is in), and any parcel's files still here two months after the payment dropped. One
// parcel's failure leaves the others to go on.
export async function tick(now = Date.now()) {
  const since = latestOf([new Date(now - 30 * DAY).toISOString(), FROM]);
  for (const pay of db.prepare(`select id from payments where basket is not null and status = 'paid' and ${PAID_SINCE}
    and not exists (select 1 from parcels where session = payments.id)`).all(since) as { id: string }[]) parcelOf(pay.id);
  for (const p of db.prepare("select * from parcels where status = 'waiting'").all() as Parcel[]) await alone(p, async () => {
    if (cancelling(p)) await inQueue(p.id, async () => { await settleCancellation(row(p.id)!); });
    if (Date.parse(p.created) < now - GIVE_UP_AFTER || !addressOf(p)) return inQueue(p.id, () => giveUp(row(p.id)!));
    await place(p.id);
    const fresh = row(p.id)!;
    if (!p.nagged && Date.parse(p.created) < now - NAG_AFTER && fresh.status === 'waiting') {
      update(p.id, { nagged: stamp() });
      const why = parts(p.id).some(x => !x.removed && !x.handed) ? "a product's print files"
        : `Print API to take it (${fresh.error ?? 'a cancellation of its order unanswered'})`;
      log(`NEEDS A PERSON: parcel ${p.id} (${p.mode}) has waited two days for ${why}; the customer paid on ${p.created.slice(0, 10)}.`);
    }
  });
  const due = db.prepare(`select * from parcels where checked < ? and (status in ('placed', 'printing')
    or (status = 'shipped' and tracking is null and shipped_at > ?))`).all(now - CHECK_EVERY, new Date(now - 7 * DAY).toISOString()) as Parcel[];
  for (const p of due) await alone(p, () => inQueue(p.id, async () => {
    const fresh = row(p.id)!;
    if (fresh.status === p.status) await refresh(fresh);
  }));
  const stuckSince = new Date(now - STUCK_AFTER).toISOString();
  const old = db.prepare("select * from parcels where created < ? and status != 'cancelled'").all(stuckSince) as Parcel[];
  for (const p of old.filter(x => existsSync(`${DIR}/${x.id}`))) await alone(p, () => inQueue(p.id, () => dropStuck(row(p.id)!)));
  const keptSince = new Date(now - KEEP_CANCELLED).toISOString();
  for (const p of db.prepare("select id from parcels where created < ? and status = 'cancelled'").all(keptSince) as { id: string }[])
    if (existsSync(`${DIR}/${p.id}`)) await inQueue(p.id, async () => dropFiles(p.id));
  const forgotten = db.prepare('select distinct parcel from parcel_lines where forget_asked is not null').all() as { parcel: string }[];
  for (const { parcel } of forgotten.filter(x => existsSync(`${DIR}/${x.parcel}`)))
    await inQueue(parcel, async () => dropForgotten(row(parcel)!));
}
// A parcel still holding print files two months after the payment (an order Print API left Created, a cancellation it
// never answered, trouble on its side) keeps them no longer, whatever its status: the privacy pages promise them gone 90
// days after the order at the latest. A cancellation still unanswered is read once more and, still unanswered, given up:
// the lines asked for stay in, and a hurry is off (were Print API to cancel the order after all, the whole parcel is
// cancelled and each product refunds its line). A person looks at why.
async function dropStuck(p: Parcel) {
  dropFiles(p.id);
  const asked = cancelling(p);
  log(`NEEDS A PERSON: parcel ${p.id}'s order ${orderId(p)} (${p.mode}) is still ${p.order_status ?? p.status} two months after `
    + `the payment on ${p.created.slice(0, 10)}${asked ? ', a cancellation asked of it unanswered' : ''}. Its files here are `
    + "deleted, so it can't be placed again nor a line taken out of it now; look at why.");
  if (!asked) return;
  await settleCancellation(p);
  if (cancelling(row(p.id)!)) callOff(p);
}
const alone = (p: Parcel, run: () => Promise<unknown>) =>
  run().catch(err => console.error(`Parcels: parcel ${p.id} failed this round:`, err instanceof Error ? err.message : err));
function addressOf(p: Parcel) {
  const pay = db.prepare('select deliver from payments where id = ?').get(p.session) as { deliver: string | null } | undefined;
  return pay?.deliver;
}

// A parcel still waiting when its delivery address goes can never be placed: it's cancelled, its files kept as a
// cancelled parcel's (KEEP_CANCELLED), and each product refunds its line, as for a parcel Print API cancelled. An order a failed placing left at Print API is cancelled first; one that went on is read back.
async function giveUp(p: Parcel) {
  if (p.status !== 'waiting') return;
  const now = printapi.keys(printer(p)) ? await printapi.call(printer(p), 'GET', orderPath(orderId(p))) : null;
  if (now && now.status !== 404) {
    if (now.status !== 200) return;   // read again next time
    if (now.body?.status !== 'Created') return refresh(p, now.body);
    const reason = 'Never complete: cancelled before printing';
    const asked = await printapi.call(printer(p), 'POST', `${orderPath(orderId(p))}/cancellation`, { reason });
    if (asked.body?.status !== 'Accepted') return;   // read again next time
  }
  update(p.id, { status: 'cancelled' });
  const why = p.error ?? "a product's print files never came";
  const note = isTesterOrder(p.session)
    ? `Tester parcel ${p.id} could never be placed (${why}), and its delivery address is kept no longer: it's cancelled and `
      + `its files kept 90 days. Nothing to refund, and the tester's voucher works again.`
    : `NEEDS A PERSON: parcel ${p.id} (${p.mode}) could never be placed (${why}), and its delivery address is kept no longer: `
      + `it's cancelled and its files kept 90 days. Each product refunds its line; the customer paid on ${p.created.slice(0, 10)}.`;
  log(note);
}
export const start = () => {
  setInterval(() => tick().catch(err => console.error('Parcels: the check failed:', err instanceof Error ? err.message : err)), TICK_EVERY);
};

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x'), route = `${req.method} ${url.pathname}`;
  const c = caller(req);
  if (Array.isArray(c)) { req.resume(); return json(res, c[0], { error: c[1] }); }
  try {
    let r;
    if (route === 'POST /api/pay/parcel/file') { r = await putFile(c, req, url); if (!req.readableEnded) req.resume(); }
    else {
      const b = req.method === 'POST' ? await readJson(req, BODY_BYTES) : null;
      if (!b || typeof b !== 'object')
        return req.method === 'POST' ? json(res, 400, { error: 'json body' }) : json(res, 404, { error: 'not found' });
      if (route === 'POST /api/pay/parcel/items') r = await setItems(c, b);
      else if (route === 'POST /api/pay/parcel/cancel') r = await removeLine(c, b);
      else r = [404, 'not found'];
    }
    return Array.isArray(r) ? json(res, r[0] as number, { error: r[1] }) : json(res, 200, r);
  } catch (err) {
    if (err instanceof printapi.PrintApiError) return json(res, 502, { error: `Print API: ${err.status || 'no answer'}` });
    throw err;
  }
}
