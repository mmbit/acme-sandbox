// The guest desk: agents correspond with a named outside colleague (an accountant, a landlord's admin) on a page of
// their own, never by email. An agent writes the guest a request (hq guest): a checklist of documents to mail in,
// questions, tasks to do elsewhere and things to know. The board gets it on the desk phone as a card, gives the guest's
// email address the first time, and shares the request's link (the card's Share). The guest proves the address with a
// code (mailout.ts), then ticks, answers and asks about each item there; every step reaches the agent who wrote it as
// outside data (never instructions), and the agent answers on the item. The board reads along on the card.
//   - A link is /guest/<token>: an HMAC of the request and its nonce under a key only the server holds, so the card can
//     show it again while the database keeps only its sha256. A new nonce (the board's New link) ends the old one.
//   - A verified guest gets a cookie for /guest/ (30 days) that opens their own requests only, nothing else of the company.
//   - No customer's own details go to a guest: a job that holds them (jobs.ts holdsCustomerData) neither writes a request
//     nor answers one.
//   - A closed request is read-only, and its link opens nothing KEEP_DAYS after it closed.
//   - A request opens only once the board shares it from its card (released): a guest is known by name, so a new request
//     for an Anna already known would otherwise open on her page at once. The card shows the masked address it goes to.
//   - A request can have several people working through it together: the guest the
//     agent wrote to, and whoever the board invites on the card (a name and an address). Each has a link of their own (the
//     code goes to their own address), sent and removed on its own; their steps reach the agent under their name. With
//     two or more, the page gives each a colour, names them in a small legend at the top and marks what each ticked,
//     answered or asked in theirs. With one, the page has neither. The board can remove anyone, the last one too, and
//     invite someone else in their place.
//   - The same sign-in opens other modules' doors (shares.ts: a preview shared for outside notes): a link of the same
//     shape whose page, once the guest has proved the address, leads on to what was shared. The guest's session also takes
//     them on to a page a door opens without its link (onward: a demo the shared deck links to).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db, redacted, redactedJson } from './db.ts';
import { publish } from './events.ts';
import { ORIGIN, PUBLIC_HOST, REPO_DIR } from './config.ts';
import { brand, brandLook, ceo, companyFormats, names } from './company.ts';
import { LANGUAGES, type BoardLanguage } from './language.ts';
import { createRequest, closeRequest, findAgent, holdsCustomerData } from './jobs.ts';
import { clientOf } from './auth.ts';
import { inside } from './files.ts';
import { serverKey } from './secrets.ts';
import { darkLogo, logo } from './pages.ts';
import * as mailout from './mailout.ts';
import * as messages from './messages.ts';
import * as cardFiles from './cardfiles.ts';   // an item's files to download, kept with the card
import * as asking from '../../hq/shell/questions.js';   // a question item's shape, answer and field, shared with the desk phone's cards

// Guest tables.
// - guest_requests.numbered: the highest item number used, so an addition never reuses a dropped one's (hq guest drop).
// - guest_items.person, guest_messages.person: who ticked, answered or asked on an item.
// - guest_items.type, guest_items.unit: a question's type and unit (questions.js).
// - guest_codes: per guest, proving their address whichever of their links asked for it.
db.exec(`
  create table if not exists guests (name text primary key collate nocase, email text, created text not null, revoked text,
    verified text, lang text, title text);
  create table if not exists guest_requests (id integer primary key, created text not null, guest text not null collate nocase,
    agent text not null, job integer, title text not null, body text not null, status text not null default 'open', request integer,
    before text, closed text, numbered integer);
  create table if not exists guest_items (request integer not null, n integer not null, section text not null, kind text not null,
    title text not null, detail text, options text, optional integer not null default 0, state text, answer text, updated text,
    person text, type text, unit text, primary key (request, n));
  create table if not exists guest_messages (id integer primary key, item integer not null, who text not null,
    text text not null, ts text not null, point integer, person text, pictures text);
  create table if not exists guest_codes (id integer primary key, guest text not null collate nocase, hash text not null,
    expires integer not null, tries integer not null default 0, created integer not null);
  create table if not exists guest_sessions (hash text primary key, guest text not null collate nocase, expires integer not null);
  create table if not exists guest_people (request integer not null, guest text not null collate nocase, nonce text not null,
    link text not null unique, added text not null, released text, withdrawn text, primary key (request, guest))`);
// colleagues: the email domain whose people a request's guests may invite themselves (the card's switch, off: null);
// invited_by: the guest who invited a person that way
if (!(db.prepare('pragma table_info(guest_requests)').all() as { name: string }[]).some(c => c.name === 'colleagues'))
  db.exec('alter table guest_requests add column colleagues text');
if (!(db.prepare('pragma table_info(guest_people)').all() as { name: string }[]).some(c => c.name === 'invited_by'))
  db.exec('alter table guest_people add column invited_by text');
// what a request says and the guest's words: the guest, the agent and the board read them
redacted('guest_requests', 'title', 'body', 'before');
redacted('guest_items', 'section', 'title', 'detail', 'answer', 'unit'); redactedJson('guest_items', 'options');
redacted('guest_messages', 'text');
redacted('guests', 'title');

// guest_messages.item is the request's id (its name from before the checklist); point: the item; pictures: an agent's
// reply's, as JSON (their paths in the repo)
type Request = { id: number; created: string; guest: string; agent: string; job: number | null; title: string; body: string;
  status: string; request: number | null; before: string | null; closed: string | null; numbered: number | null; colleagues: string | null };
// One of a request's people: their link (a nonce of their own) and whether the board has shared it or withdrawn them, with
// their guest's address and state
type Person = { request: number; guest: string; nonce: string; added: string; released: string | null; withdrawn: string | null;
  email: string | null; revoked: string | null; verified: string | null; lang: string | null; invited_by: string | null };
type Item = { request: number; n: number; section: string; kind: Kind; title: string; detail: string | null; options: string | null;
  optional: number; state: string | null; answer: string | null; person: string | null; type: string | null; unit: string | null };
type Guest = { name: string; email: string | null; revoked: string | null; verified: string | null; lang: string | null; title: string | null };
type Message = { id: number; who: string; person: string | null; text: string; ts: string; pictures: string | null };
type Kind = 'document' | 'question' | 'task' | 'info';
export type Lang = keyof typeof COPY;
type Copy = (typeof COPY)[Lang];

const NAME = /^\p{Lu}[\p{L}\p{M}' .-]{0,59}$/u, MAX_TITLE = 140, MAX_LINE = 200, MAX_INTRO = 2000, MAX_TEXT = 8000;
// A request is one page an outside person works through, written by an agent: a job stuck in a loop, or steered by
// text it read, could hand a guest a wall of items they give up on. These keep it to what a person finishes in a sitting,
// and the agent splits the rest into a later request.
const MAX_ITEMS = 40, MAX_SECTIONS = 12, KINDS = ['document', 'question', 'task', 'info'];
const CODE_MS = 10 * 60_000, TRIES = 5, CODES_PER_HOUR = 3, SESSION_DAYS = 30, KEEP_DAYS = 30;
const REQUESTS_PER_HOUR = 10, STEPS_PER_HOUR = 120;   // a job's requests; a guest's ticks, answers and questions on one
const PER_IP = { send: 10, verify: 30, invite: 10 };              // an hour, per client (auth.ts clientOf: an IPv6 /64 is one)
// Local runs (tests, dev) are mailout's test mode: the code comes back on the page. The server is live: it sends, or says
// it can't yet.
const MODE = PUBLIC_HOST === 'localhost' ? 'test' : 'live';

// ---- the link and the code: signed with the guest desk's own key, next to the key store (like payments.key)
const KEY = serverKey('guest');
const sign = (s: string) => createHmac('sha256', KEY).update(s).digest('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
// (a person's link: their request and their own nonce)
const tokenOf = (id: number, nonce: string) => sign(`link:${id}:${nonce}`);
const linkOf = (p: Pick<Person, 'request' | 'nonce'>) => `${ORIGIN}/guest/${tokenOf(p.request, p.nonce)}`;
const fresh = (id: number) => { const nonce = randomBytes(16).toString('hex'); return { nonce, link: sha256(tokenOf(id, nonce)) }; };

const request = (id: number) => db.prepare('select * from guest_requests where id = ?').get(id) as Request | undefined;
const guest = (name: string) => db.prepare('select * from guests where name = ?').get(name) as Guest | undefined;
const items = (id: number) => db.prepare('select * from guest_items where request = ? order by n').all(id) as Item[];
const thread = (id: number, n: number) => db.prepare('select id, who, person, text, ts, pictures from guest_messages where item = ? and point = ? order by id').all(id, n) as Message[];
const agentName = (id: string) => String(findAgent(id)?.name ?? id);
const documents = () => { const d = String(brand().mail?.domain ?? ''); return d ? `documents@${d}` : null; };
const langOf = (g: Pick<Guest, 'lang'>): Lang => g.lang && Object.hasOwn(COPY, g.lang) ? g.lang as Lang : 'en';
const hourAgo = () => new Date(Date.now() - 3600e3).toISOString();
const expired = (r: Request) => !!r.closed && Date.parse(r.closed) < Date.now() - KEEP_DAYS * 864e5;
// a@example.nl → a••••@example.nl: the page says where the code goes without showing the address
const masked = (email: string) => `${email[0]}••••${email.slice(email.indexOf('@'))}`;
// The items that ask for something (info only tells), and those the guest has done
const progress = (list: Item[]) => { const asks = list.filter(i => i.kind !== 'info'); return { done: asks.filter(i => i.state).length, total: asks.length }; };
// A question item as the shared engine reads it (questions.js), and its answer as a person reads it (Yes, 3.5 mm): in the
// guest's language on their page, in English for the agent and the board's card
const asked = (i: Item) => ({ title: i.title, ...(i.type ? { type: i.type } : {}), ...(i.unit ? { unit: i.unit } : {}), ...(i.options ? { options: JSON.parse(i.options) as string[] } : {}) });
const saidOf = (i: Item, lang: Lang = 'en') => i.answer && i.kind === 'question' ? asking.said(asked(i), i.answer, lang) : i.answer;

// ---- a request's people
// In the order they were added: the first is the guest its agent wrote to. Still on it: not withdrawn from it, and their
// guest's access not revoked.
const people = (id: number) => db.prepare(`select p.request, p.guest, p.nonce, p.added, p.released, p.withdrawn, g.email, g.revoked, g.verified, g.lang,
  p.invited_by from guest_people p join guests g on g.name = p.guest where p.request = ? order by p.rowid`).all(id) as Person[];
const active = (p: Person) => !p.withdrawn && !p.revoked;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// One more person on a request, or one withdrawn back on it: a link of their own, which opens once the board shares it
function enrol(id: number, name: string) {
  const { nonce, link } = fresh(id);
  db.prepare(`insert into guest_people (request, guest, nonce, link, added) values (?, ?, ?, ?, ?)
    on conflict (request, guest) do update set nonce = excluded.nonce, link = excluded.link, released = null, withdrawn = null, invited_by = null`)
    .run(id, name, nonce, link, new Date().toISOString());
}
// The person a card's button is for: the one it names, or without a name the one the card is about (the only one still
// on the request, else the guest its agent wrote to)
function personOf(r: Request, name?: unknown) {
  const all = people(r.id), stillOn = all.filter(active);
  if (typeof name === 'string' && name) return all.find(p => sameName(p.guest, name));
  return stillOn.length === 1 ? stillOn[0] : all.find(p => sameName(p.guest, r.guest));
}
// Why nobody can open a request any more, or null while someone can: 'revoked' (the board revoked the guest access of
// everyone on it) or 'withdrawn' (it removed them, or removed some and revoked the rest)
function nobody(r: Request): 'revoked' | 'withdrawn' | null {
  const all = people(r.id);
  if (all.some(active)) return null;
  return all.every(p => p.revoked) ? 'revoked' : 'withdrawn';
}
// What the agent reads when nobody can: why its addition or answer is refused, and where the request stands
function shutOut(r: Request) {
  const why = nobody(r);
  if (!why) return null;
  const all = people(r.id), revoked = listed(all.filter(p => p.revoked).map(p => p.guest));
  const removed = `the board removed ${listed(all.filter(p => !p.revoked).map(p => p.guest))} from request #${r.id}`;
  return why === 'revoked' ? { refused: `the board revoked ${revoked}'s access`, state: 'revoked by the board' }
    : { refused: revoked ? `${removed} and revoked ${revoked}'s access` : `${removed}, and nobody else is on it until it invites someone`,
      state: revoked ? 'everyone on it removed or revoked by the board' : 'nobody on it: the board removed everyone' };
}
// Names as a sentence lists them: "Sam", "Sam and Kim", "Sam, Kim and Lot"
export const listed = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
// Who ticked or answered an item: its person, or the request's guest where no person was stored (a tick from a database
// that kept none)
const byOf = (r: Request, i: Item) => i.person ?? r.guest;
// The colours that tell people apart: the first person's is the page's accent, and each one after turns the hue on by the
// golden angle, so any number of people each have their own and a colour stays with its person. All share one lightness
// and chroma, which reads on a light page and a dark one, with a white tick on it.
const GOLDEN = 137.508, LIGHTNESS = 0.56, CHROMA = 0.13, FIRST_HUE = 20;
// (exported: an invited person's ink in the board's book, sketchpeople.ts colourOf.)
export const colourOf = (n: number) => n ? oklch(LIGHTNESS, CHROMA, (FIRST_HUE + (n - 1) * GOLDEN) % 360) : accent();
// An OKLCH colour as #rrggbb (Björn Ottosson's matrices), each channel clipped to sRGB
function oklch(l: number, c: number, hue: number) {
  const a = c * Math.cos(hue * Math.PI / 180);
  const b = c * Math.sin(hue * Math.PI / 180);
  const lms = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map(v => v ** 3);
  const linear = [4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2], -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]];
  const gamma = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  const byte = (v: number) => Math.round(255 * gamma(Math.min(1, Math.max(0, v)))).toString(16).padStart(2, '0');
  return `#${linear.map(byte).join('')}`;
}
// Whom the page and the card name in their legend, each with their colour (by the order they were added): everyone still
// on the request, and anyone withdrawn whose marks are on it. Fewer than two: none, and no colours (the page and card for
// one person).
function legendOf(r: Request, all: Person[], list: Item[]) {
  const asked = db.prepare("select distinct coalesce(person, ?) name from guest_messages where item = ? and who = 'guest'").all(r.guest, r.id) as { name: string }[];
  const marked = [...list.filter(i => i.state).map(i => byOf(r, i)), ...asked.map(m => m.name)];
  const named = all.map((p, n) => ({ name: p.guest, colour: colourOf(n), shown: active(p) || marked.some(m => sameName(m, p.guest)) }))
    .filter(p => p.shown).map(({ name, colour }) => ({ name, colour }));
  return named.length > 1 ? named : [];
}

// ---------------------------------------------------------------- the agents (hq guest)
type Me = { id: number; agent: string };
const CUSTOMER = "this job holds a customer's own details (it read or was handed them), and nothing of it goes to a guest. " +
  "Write from a job that doesn't, with only what the guest may read";

// The request's file (hq guest's help has its shape): its checks, worded for the agent to fix, or the clean request.
const line = (v: unknown, max: number) => typeof v === 'string' && v.trim() && v.length <= max && !/[\r\n]/.test(v) ? v.trim() : null;
// before: the files the request has already, which count toward a card's limits (cardfiles.ts)
function parse(spec: any, before = { count: 0, size: 0 }) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.sections) || !spec.sections.length || spec.sections.length > MAX_SECTIONS)
    return `a request is JSON with 1 to ${MAX_SECTIONS} sections, what a guest works through in a sitting (run hq for its shape): more goes in a later request`;
  if (spec.lang !== undefined && !Object.hasOwn(COPY, spec.lang)) return `lang is one of ${Object.keys(COPY).join(', ')}`;
  if (spec.before !== undefined && !line(spec.before, 60)) return 'before is one short line (a date, as the guest reads it)';
  if (spec.intro !== undefined && (typeof spec.intro !== 'string' || spec.intro.length > MAX_INTRO)) return `intro is up to ${MAX_INTRO} characters, a few lines the guest reads before the items`;
  const out: (Omit<Item, 'request' | 'state' | 'answer' | 'person'> & { files: cardFiles.CardFile[] })[] = [];
  const had = { ...before };
  for (const s of spec.sections) {
    if (!Array.isArray(s?.items) || !s.items.length) return 'every section has items';
    if (s.title !== undefined && !line(s.title, 60)) return 'a section title is one line of up to 60 characters';
    for (const i of s.items) {
      if (!KINDS.includes(i?.kind)) return `an item's kind is ${KINDS.join(', ')}`;
      // a question is the shared engine's (questions.js: a text, a yes or no, a number or a choice); the others a title and a detail
      const q = i.kind === 'question' ? asking.question({ title: i.title, detail: i.detail, type: i.type, unit: i.unit, options: i.options, many: i.many }) : null;
      if (typeof q === 'string') return q;
      // the guest page's chips post one answer each
      if (q?.many) return "many (a pick-many) is a desk-phone card's question (hq ask --questions), not a guest's";
      if (!q && !line(i.title, MAX_TITLE)) return `an item's title is one line of up to ${MAX_TITLE} characters`;
      if (!q && i.detail !== undefined && !line(i.detail, MAX_LINE)) return `an item's detail is one line of up to ${MAX_LINE} characters`;
      if (!q && (i.options !== undefined || i.type !== undefined || i.unit !== undefined)) return 'options go with a question, and so do type and unit';
      if (i.optional !== undefined && (i.optional !== true || (i.kind !== 'document' && i.kind !== 'task'))) return 'optional: true goes with a document or a task the guest may not need';
      if (i.kind === 'document' && !documents()) return "a document item needs the company's mail domain (brand.yaml mail.domain): there's no documents@ to mail it to";
      // files for the guest to download under the item (hq guest reads each path and sends its bytes)
      const files = cardFiles.read(i.files, `the files of "${String(i.title).trim().slice(0, 60)}"`, had);
      if (typeof files === 'string') return files;
      had.count += files.length;
      had.size += files.reduce((n, f) => n + f.bytes.length, 0);
      out.push({ n: out.length + 1, section: line(s.title, 60) ?? '', kind: i.kind, title: i.title.trim(), detail: i.detail?.trim() ?? null,
        options: q?.options ? JSON.stringify(q.options) : null, optional: i.optional ? 1 : 0, type: q?.type ?? null, unit: q?.unit ?? null, files });
    }
  }
  if (out.length > MAX_ITEMS) return `a request has at most ${MAX_ITEMS} items, what a guest works through in a sitting: ask the rest in a later request`;
  return { lang: spec.lang as Lang | undefined, before: spec.before?.trim() ?? null, intro: spec.intro?.trim() ?? '', items: out,
    files: had.count - before.count };
}

// hq guest <name> "title" <file>: a request, and the board's card for it (asking for the address the first time).
export function write(me: Me, name: unknown, title: unknown, spec: unknown) {
  const n = String(name ?? '').trim(), t = String(title ?? '').trim(), p = parse(spec);
  if (holdsCustomerData(me.id)) return [403, CUSTOMER];
  if (!NAME.test(n)) return [400, 'a guest is named by their first name or full name, capitalised (up to 60 letters)'];
  if (!line(t, MAX_TITLE)) return [400, `a title is one line of up to ${MAX_TITLE} characters`];
  if (typeof p === 'string') return [400, p];
  const g = guest(n);
  if (g?.revoked) return [403, `the board revoked ${g.name}'s access: no more requests for them`];
  if ((db.prepare('select count(*) n from guest_requests where job = ? and created > ?').get(me.id, hourAgo()) as { n: number }).n >= REQUESTS_PER_HOUR)
    return [429, `this job has written ${REQUESTS_PER_HOUR} guest requests in the last hour, the most it may`];
  if (!g) db.prepare('insert into guests (name, created) values (?, ?)').run(n, new Date().toISOString());
  const who = g?.name ?? n;
  if (p.lang) db.prepare('update guests set lang = ? where name = ?').run(p.lang, who);
  const { lastInsertRowid } = db.prepare(`insert into guest_requests (created, guest, agent, job, title, body, before)
    values (?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), who, me.agent, me.id, t, p.intro, p.before);
  const id = Number(lastInsertRowid);
  enrol(id, who);   // its first person, the link signed with the request's id
  for (const i of p.items) db.prepare('insert into guest_items (request, n, section, kind, title, detail, options, optional, type, unit) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, i.n, i.section, i.kind, i.title, i.detail, i.options, i.optional, i.type, i.unit);
  // The card is the board's alert; its checklist, progress and Share come from here (card()).
  const req = createRequest({ kind: 'guest', title: `For ${who}: ${t}`, body: p.intro, urgency: 'now', agent: me.agent, job: me.id }) as { id: number };
  db.prepare('update guest_requests set request = ? where id = ?').run(req.id, id);
  for (const i of p.items) cardFiles.keep(req.id, i.files, i.n);
  return { id, guest: who, request: req.id, items: p.items.length, files: p.files, email: !!g?.email };
}

// hq guest add <request> <file>: more items on the caller's own open request, after the ones it has (their numbers stay,
// so the guest's steps and the agent's replies keep pointing at the right item). The same file and checks as a request;
// its language, date and note stay as written. The page shows them at its next load, and nobody is told.
export function add(me: Me, id: number, spec: any) {
  const r = request(id);
  if (!r || r.agent !== me.agent) return 404;
  if (holdsCustomerData(me.id)) return [403, CUSTOMER];
  const out = shutOut(r);
  if (out) return [403, out.refused];
  if (r.status !== 'open') return [409, `request #${id} is closed: write a new one`];
  if (spec && typeof spec === 'object' && ['lang', 'before', 'intro'].some(k => spec[k] !== undefined))
    return [400, "an addition is sections only: the request's lang, before and intro stay as they were written"];
  const p = parse(spec, r.request ? cardFiles.totals(r.request) : undefined), had = items(id), last = Math.max(had.at(-1)?.n ?? 0, r.numbered ?? 0);   // (numbered)
  if (typeof p === 'string') return [400, p];
  if (had.length + p.items.length > MAX_ITEMS)
    return [400, `a request has at most ${MAX_ITEMS} items, what a guest works through in a sitting (this one has ${had.length}): ask the rest in a later request`];
  for (const i of p.items) db.prepare('insert into guest_items (request, n, section, kind, title, detail, options, optional, type, unit) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, last + i.n, i.section, i.kind, i.title, i.detail, i.options, i.optional, i.type, i.unit);
  for (const i of p.items) if (r.request) cardFiles.keep(r.request, i.files, last + i.n);
  publish({ type: 'log', agent: me.agent, text: `Added ${p.items.length} item${p.items.length === 1 ? '' : 's'} to ${r.guest}'s guest request #${id}.` });
  return { id, guest: whom(r), first: last + 1, last: last + p.items.length, files: p.files };
}

// hq guest drop <request> <item>: one item off an open request, by its agent or the CEO. It's gone from the page, the card
// and the progress, with the agent's replies on it; the others keep their numbers, and nobody is told (as with add). An
// item the guest ticked, answered or asked about stays: their words aren't ours to delete.
export function drop(me: Me, id: number, n: number) {
  const r = request(id);
  if (!r || (r.agent !== me.agent && me.agent !== ceo())) return 404;
  const i = items(id).find(x => x.n === n);
  if (!i) return [404, `request #${id} has no item ${n}`];
  if (r.status !== 'open') return [409, `request #${id} is closed`];
  if (i.state || i.answer || thread(id, n).some(m => m.who === 'guest'))
    return [409, `${byOf(r, i)} ${i.state ? (i.kind === 'question' ? 'answered' : 'ticked') : 'asked about'} item ${n}: it stays, with their words`];
  db.exec('begin');
  try {
    db.prepare('delete from guest_messages where item = ? and point = ?').run(id, n);
    db.prepare('delete from guest_items where request = ? and n = ?').run(id, n);
    if (r.request) cardFiles.forget(r.request, n);
    db.prepare('update guest_requests set numbered = max(coalesce(numbered, 0), ?) where id = ?').run(n, id);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  publish({ type: 'log', agent: me.agent, text: `Took item ${n} off ${r.guest}'s guest request #${id}.` });
  return { id, guest: whom(r), n, ...progress(items(id)) };
}

// Where a request stands, in a few words for its agent: for each person still on it, with several.
function stands(r: Request) {
  const out = shutOut(r);
  if (out) return out.state;
  if (r.status !== 'open') return `closed ${r.closed?.slice(0, 10) ?? ''}`.trim();
  const stillOn = people(r.id).filter(active);
  return stillOn.map(p => (stillOn.length > 1 ? `${p.guest}: ` : '') + personState(p)).join('; ');
}
function personState(p: Person) {
  if (!p.email) return "waiting for the board (it hasn't given their email address yet)";
  if (!p.released) return 'waiting for the board to share the link';
  if (p.verified) return `with ${p.guest} (last verified ${p.verified.slice(0, 10)})`;
  return `with ${p.guest} once the board shares the link (not opened yet)`;
}
// Whom a request is for, as the agent reads it: "Sam", or "Sam and Kim" (everyone still on it)
const whom = (r: Request) => listed(people(r.id).filter(active).map(p => p.guest)) || r.guest;

// hq guest: the caller's open requests.
export const open = (me: Me) => (db.prepare("select * from guest_requests where agent = ? and status = 'open' order by id").all(me.agent) as Request[])
  .map(r => ({ id: r.id, guest: whom(r), title: r.title, created: r.created, state: stands(r), ...progress(items(r.id)) }));

// hq guest read <request>: the checklist with what the guest did and said, for the agent who wrote it. The guest's words
// are marked as theirs; with several people, each step says whose it was (by).
export function read(me: Me, id: number) {
  const r = request(id);
  if (!r || r.agent !== me.agent) return 404;
  const list = items(id), several = people(id).length > 1;
  return { id: r.id, guest: whom(r), title: r.title, status: r.status, state: stands(r), ...progress(list), items: list.map(i => readItem(r, i, several)) };
}
function readItem(r: Request, i: Item, several: boolean) {
  const by = several && i.state ? { by: byOf(r, i) } : {};
  const files = filesOf(r, i).map(f => f.name);
  return { n: i.n, kind: i.kind, title: i.title, state: i.state, answer: saidOf(i), ...by, ...(files.length ? { files } : {}),
    thread: thread(r.id, i.n).map(m => readMessage(r, m)) };
}
// An item's files (cardfiles.ts, kept with the request's card)
const filesOf = (r: Request, i: Item) => r.request ? cardFiles.of(r.request).filter(f => f.item === i.n) : [];
const readMessage = (r: Request, m: Message) => m.who === 'guest' ? { from: m.person ?? r.guest, guest: true, text: m.text, ts: m.ts }
  : { from: m.who, text: m.text, ts: m.ts, ...(m.pictures ? { pictures: picturesOf(m) } : {}) };   // (pictures)

// hq guest reply <request> <item> <file> [--picture <path>]…: the agent's answer on one item, with pictures from the repo
// under it if it likes. Only the request's agent, from a job that holds no customer's own details.
export function reply(me: Me, id: number, n: number, text: unknown, pictures?: unknown) {
  const r = request(id), t = String(text ?? '').trim();
  if (!r || r.agent !== me.agent) return 404;
  if (!items(id).some(i => i.n === n)) return [404, `request #${id} has no item ${n}`];
  if (holdsCustomerData(me.id)) return [403, CUSTOMER];
  const out = shutOut(r);
  if (out) return [403, out.refused];
  if (r.status !== 'open') return [409, `request #${id} is closed`];
  if (!t || t.length > MAX_TEXT) return [400, `an answer is 1 to ${MAX_TEXT} characters`];
  const checked = checkedPictures(pictures);   // (pictures)
  if ('refused' in checked) return checked.refused;
  const { lastInsertRowid } = db.prepare('insert into guest_messages (item, point, who, text, ts, pictures) values (?, ?, ?, ?, ?, ?)')
    .run(id, n, me.agent, t, new Date().toISOString(), checked.pictures.length ? JSON.stringify(checked.pictures) : null);
  publish({ type: 'log', agent: me.agent, text: `Answered ${whom(r)} on the guest page (request #${id}, item ${n}).` });
  return { ok: true, message: Number(lastInsertRowid) };
}

// ---- a reply's pictures: png, jpg or webp files in the repo (the server's
// checkout of main), named by their path from its root, found only inside it (files.ts: no `..`, no symlink out). The
// guest's page serves them to the guest's own session, and HQ to the board, by their reply and place in it, never by path.
const PICTURE = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(png|jpe?g|webp)$/i, MAX_PICTURES = 4, PICTURE_BYTES = 5_000_000;
const PICTURE_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const pictureFile = (path: string) => PICTURE.test(path) ? inside(REPO_DIR, path) : null;
const picturesOf = (m: Pick<Message, 'pictures'>): string[] => m.pictures ? JSON.parse(m.pictures) : [];
const pictureExtension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
// A picture's file name as its title: slip_front.jpg, "Slip front"
function pictureTitle(path: string) {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.\w+$/, '').replace(/[-_]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}
// The pictures a reply names, checked, or why they're refused
function checkedPictures(v: unknown): { pictures: string[] } | { refused: [400, string] } {
  if (v === undefined || v === null) return { pictures: [] };
  if (!Array.isArray(v) || v.length > MAX_PICTURES) return { refused: [400, `a reply carries up to ${MAX_PICTURES} pictures`] };
  if (new Set(v).size !== v.length) return { refused: [400, 'the same picture twice'] };
  const pictures: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string' || !PICTURE.test(p)) return { refused: [400, `a picture is a png, jpg or webp named by its path from the repo's root (docs/pictures/front.jpg), not ${JSON.stringify(p)}`] };
    const found = pictureFile(p);
    if (!found) return { refused: [400, `${p} isn't on main (the server's checkout), or leads out of the repo: merge it first`] };
    if (found.size > PICTURE_BYTES) return { refused: [400, `${p} is over ${PICTURE_BYTES / 1e6} MB: make it smaller`] };
    pictures.push(p);
  }
  return { pictures };
}
// GET /api/guest/pictures?id=<reply>&k=<n>: one for the board's card (behind HQ's sign-in)
export function getPicture(req: IncomingMessage, res: ServerResponse) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  if (sendPicture(res, Number(q.get('id')), Number(q.get('k')), null)) return;
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}
// One picture of a reply (replyPicture): false when there's none, or its file is gone, over the size a reply may carry, or
// now leads out of the repo
function sendPicture(res: ServerResponse, id: number, k: number, requestId: number | null) {
  const path = replyPicture(id, k, requestId);
  if (!path) return false;
  const found = pictureFile(path);
  if (!found || found.size > PICTURE_BYTES) return false;
  const bytes = readFileSync(found.real);
  if (bytes.length > PICTURE_BYTES) return false;
  res.writeHead(200, { 'content-type': PICTURE_TYPE[pictureExtension(path)], 'content-length': bytes.length, 'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
  res.end(bytes);
  return true;
}
// The path of the k-th picture of agent reply `id`: only if the reply is on request `requestId` (the guest's page), or on
// any request when it's null (the board's)
function replyPicture(id: number, k: number, requestId: number | null) {
  const m = db.prepare("select item, pictures from guest_messages where id = ? and who != 'guest'").get(id) as { item: number; pictures: string | null } | undefined;
  if (!m) return null;
  if (requestId !== null && m.item !== requestId) return null;
  return picturesOf(m)[k] ?? null;
}

// hq guest close <request>, or the board from its card: done. The page shows it read-only, and its card leaves the desk phone.
function shut(r: Request) {
  db.prepare("update guest_requests set status = 'closed', closed = coalesce(closed, ?) where id = ?").run(new Date().toISOString(), r.id);
  if (r.request) closeRequest(r.request, r.agent);
}
export function close(me: Me, id: number) {
  const r = request(id);
  if (!r || r.agent !== me.agent) return 404;
  shut(r);
  return { ok: true };
}

// ---------------------------------------------------------------- the board (HQ's desk phone)
// A guest card as the desk phone and its archive show it: the checklist with the guest's progress, answers and questions,
// and its people, each with their own Share (the request's title and their link) while they can open it. The first time,
// the card asks for the address. With several people on it, the legend says whose colour marks what.
export function card(c: any) {
  if (c.kind !== 'guest') return c;
  const r = cardRequest(c.id);
  if (!r) return c;
  const { share: _share, files: _files, ...rest } = c;   // (its files are its items': under each)
  const all = people(r.id);
  const list = items(r.id);
  const legend = legendOf(r, all, list);
  const lead = personOf(r)!;
  const colleagues = colleaguesOf(r);
  return { ...rest, guest: { ...cardGuest(r, lead, list), ...(legend.length ? { legend } : {}), ...(colleagues ? { colleagues } : {}),
    people: all.map(p => cardPerson(r, p, legend)), items: list.map(i => cardItem(r, i, langOf(lead), legend)) } };
}
// The card's language pick: a page's languages by their own names
const pageLanguages = () => (Object.keys(COPY) as Lang[]).map(code => ({ code, own: LANGUAGES[code].own }));
// Share releases the request (release()); the masked address tells this guest from another of the same name. What Send
// link shares: the link alone, so a share sheet offers Copy link and an app like Teams takes it
const shareOf = (r: Request, p: Person) => p.email && active(p) && r.status === 'open' ? linkOf(p) : null;
const cardGuest = (r: Request, lead: Person, list: Item[]) => ({ request: r.id, name: lead.guest, address: lead.email && masked(lead.email),
  needsEmail: !lead.email && active(lead), released: !!lead.released, revoked: !!lead.revoked, verified: lead.verified, lang: langOf(lead), status: r.status,
  closed: r.closed, before: r.before, mail: mailout.ready(MODE), ...progress(list), languages: pageLanguages() });
function cardPerson(r: Request, p: Person, legend: Legend) {
  const share = shareOf(r, p);
  return { name: p.guest, address: p.email && masked(p.email), released: !!p.released, verified: p.verified, lang: langOf(p), withdrawn: !!p.withdrawn,
    revoked: !!p.revoked, ...colourIn(legend, p.guest), ...(share ? { share } : {}), ...(p.invited_by ? { invitedBy: p.invited_by } : {}) };
}
// A person's colour in the legend, as a field; none without a legend
const colourIn = (legend: Legend, name: string) => legend.length ? { colour: legend.find(l => sameName(l.name, name))?.colour } : {};
function cardItem(r: Request, i: Item, lang: Lang, legend: Legend) {
  const by = i.state && legend.length ? { by: byOf(r, i), ...colourIn(legend, byOf(r, i)) } : {};
  // its files, each a download from the card while kept
  const files = filesOf(r, i).map(f => ({ name: f.name, size: f.size, ...(f.kept ? { src: `/api/requests/file?id=${r.request}&n=${f.n}` } : {}) }));
  return { n: i.n, section: i.section || COPY[lang].sections[i.kind], kind: i.kind, title: i.title, detail: i.detail, state: i.state, answer: saidOf(i),
    ...by, ...(files.length ? { files } : {}), thread: thread(r.id, i.n).map(m => cardMessage(r, m, legend)) };
}
const cardPictures = (m: Message) => picturesOf(m).map((p, k) => ({ src: `/api/guest/pictures?id=${m.id}&k=${k}`, title: pictureTitle(p) }));
function cardMessage(r: Request, m: Message, legend: Legend) {
  if (m.who !== 'guest') return { who: agentName(m.who), guest: false, text: m.text, ts: m.ts, ...(m.pictures ? { pictures: cardPictures(m) } : {}) };   // (pictures)
  const who = m.person ?? r.guest;
  return { who, guest: true, text: m.text, ts: m.ts, ...colourIn(legend, who) };
}
const cardRequest = (id: number) => db.prepare('select * from guest_requests where request = ?').get(id) as Request | undefined;

// The guest's address, from the card.
export function setEmail(id: number, email: unknown) {
  const r = cardRequest(id), a = mailout.address(email);
  if (!r) return 404;
  if (!a) return 400;
  const g = guest(r.guest)!;
  if (g.revoked) return 409;
  readdress(g, a);
  for (const welcome of welcomes) welcome(g.name);
  return { ok: true };
}
// A new address ends the sessions the old one verified, and the codes sent to it: a code still unused would open the
// page for whoever holds the old address (audit NI3).
function readdress(g: Guest, address: string) {
  db.exec('begin');
  try {
    if (g.email !== address) {
      db.prepare('delete from guest_sessions where guest = ?').run(g.name);
      db.prepare('delete from guest_codes where guest = ?').run(g.name);
    }
    db.prepare('update guests set email = ? where name = ?').run(address, g.name);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
}

// What else holds a guest at their address (shares.ts: a share they're still on): each module says whether something of
// its own does.
const holders: ((guest: string) => boolean)[] = [];
export const addHolder = (holds: (guest: string) => boolean) => { holders.push(holds); };
// What another module gives every guest the board (or a guest it lets) invites, once they're invited at their address,
// or given one on their card (sketchpeople.ts: a book of their own).
const welcomes: ((guest: string) => void)[] = [];
export const addWelcome = (welcome: (guest: string) => void) => { welcomes.push(welcome); };
// A guest nothing opens for any more: every request they were on withdrawn from or kept past its time, and nothing of
// another module's held. The board may give their name a new address (it removed them, and invites them again at the
// right one): the old address opens nothing of theirs, so nobody is locked out and no one else's page moves.
function nothingOpensFor(g: Guest) {
  const requests = db.prepare('select r.* from guest_people p join guest_requests r on r.id = p.request where p.guest = ? and p.withdrawn is null')
    .all(g.name) as Request[];
  return requests.every(expired) && !holders.some(holds => holds(g.name));
}

// A guest the board names itself, at the address it gives (Add a person on a checklist card, and shares.ts: whoever it
// shares a preview with). A name already known at that address is that guest, so
// one sign-in opens all their pages and doors; at another address it's refused, never moved: that
// would lock the known guest out and send their codes to someone else (a new address is the checklist card's), unless
// nothing opens for them any more (nothingOpensFor). Returns the guest's name as stored.
export function invite(name: unknown, email: unknown) {
  const n = String(name ?? '').trim(), address = mailout.address(email);
  if (!NAME.test(n)) return [400, 'a guest is named by their first name or full name, capitalised (up to 60 letters)'];
  if (!address) return [400, 'that email address doesn’t look right'];
  const known = guest(n);
  if (known?.revoked) return [409, `the board revoked ${known.name}'s guest access`];
  const moved = !!known?.email && mailout.address(known.email)?.toLowerCase() !== address.toLowerCase();
  if (known?.email && moved && !nothingOpensFor(known))
    return [409, `${known.name} is already a guest, at ${masked(known.email)}: name this person apart (their full name, say)`];
  if (!known) db.prepare('insert into guests (name, created) values (?, ?)').run(n, new Date().toISOString());
  const g = guest(n)!;
  if (!g.email || moved) readdress(g, address);
  for (const welcome of welcomes) welcome(g.name);
  return { name: g.name, address: masked(moved ? address : (g.email ?? address)) };
}

// The card's Add a person: someone else who works through the same checklist, on a link of their own that opens once the
// board shares it. A new guest takes the page's language of the request's first person.
export function addPerson(id: number, name: unknown, email: unknown) {
  const r = cardRequest(id);
  if (!r) return 404;
  if (r.status !== 'open') return [409, 'the request is closed'];
  const all = people(r.id), had = all.find(p => sameName(p.guest, String(name ?? '').trim()));
  if (had && active(had)) return [409, `${had.guest} is on this request already`];
  const g = invite(name, email);
  if (Array.isArray(g)) return g;
  db.prepare('update guests set lang = coalesce(lang, ?) where name = ?').run(all[0]?.lang ?? null, g.name);
  enrol(r.id, g.name);
  publish({ type: 'log', agent: r.agent, text: `The board added ${g.name} to guest request #${r.id}.` });
  return { ok: true };
}
// ---- colleagues
// When the board switches it on for a card, its guests may invite colleagues at their own email domain themselves (the
// domain of the first person's address, as it was when the board switched it on), up to MAX_INVITES a request in all:
// each gets a link of their own by email at once, in the inviting guest's language, and shows on the card as invited by
// them, for the board to remove like anyone. Never for a public mail service's domain, where "the same domain" is anyone.
const MAX_INVITES = 3;
const domainOf = (email: string | null | undefined) => email ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : null;
// The domain the card's switch would allow now: its first person's, while that's not a public mail service's
const colleagueDomain = (r: Request) => { const d = domainOf(people(r.id)[0]?.email); return d && !mailout.sharedDomain(d) ? d : null; };
const invitedOn = (r: Request) => people(r.id).filter(p => p.invited_by).length;
// The card's switch, while it can be on: the domain it allows, whether it's on and the invites used
function colleaguesOf(r: Request) {
  const domain = r.colleagues ?? (r.status === 'open' ? colleagueDomain(r) : null);
  return domain ? { domain, on: !!r.colleagues, used: invitedOn(r), most: MAX_INVITES } : null;
}
// The board's switch on the card (POST /api/guest/colleagues): on allows the first person's domain, off takes it away
export function setColleagues(id: number, on: unknown) {
  const r = cardRequest(id);
  if (!r) return 404;
  if (typeof on !== 'boolean') return 400;
  if (on && r.status !== 'open') return [409, 'the request is closed'];
  const first = people(r.id)[0], domain = on ? colleagueDomain(r) : null;
  if (on && !domain) return [409, first?.email ? `${domainOf(first.email)} is a public mail service's: anyone has an address there` : `${r.guest} has no email address yet`];
  db.prepare('update guest_requests set colleagues = ? where id = ?').run(domain, r.id);
  publish({ type: 'log', agent: r.agent, text: `The board ${on ? 'let' : 'stopped'} guests on guest request #${r.id} ${on ? 'invite' : 'inviting'} colleagues at their own domain.` });
  return { ok: true };
}
// Whether this guest may invite a colleague now, and how many more
function invitesLeft(r: Request, g: Guest) {
  if (r.status !== 'open' || !r.colleagues || domainOf(g.email) !== r.colleagues) return null;
  return Math.max(0, MAX_INVITES - invitedOn(r));
}

// The guest's address as a page shows it (a@example.nl → a••••@example.nl).
export const addressOf = (name: string) => { const email = guest(name)?.email; return email ? masked(email) : null; };
// ...and in full, for a note they signed (shares.ts)
export const emailOf = (name: string) => guest(name)?.email ?? null;
// The board's short title for a guest ("UX specialist"), from HQ's share box: whoever reads their notes reads them in light
// of it (feedback.ts). The board's own, for us: no page of theirs shows it. null clears it. → the guest's name as stored,
// or null for no such guest
export const titleOf = (name: string) => guest(name)?.title ?? null;
export function setTitle(name: string, title: string | null) {
  const g = guest(name);
  if (!g) return null;
  db.prepare('update guests set title = ? where name = ?').run(title, g.name);
  return g.name;
}
// The address the guest is admitted at now, sealed (null once revoked or without one): another module's session keeps
// the seal it was opened under, so a new address or a revoke ends it as it ends the guest's own sessions.
export const seal = (name: string) => { const g = guest(name); return g?.email && !g.revoked ? sign(`seal:${g.name.toLowerCase()}:${g.email}`) : null; };

// The board's Share on the card, for one person (the card's only one, without a name): from now on their link opens.
export function release(id: number, person?: unknown) {
  const r = cardRequest(id);
  if (!r) return 404;
  const p = personOf(r, person);
  if (!p?.email || !active(p) || r.status !== 'open') return 409;
  db.prepare('update guest_people set released = coalesce(released, ?) where request = ? and guest = ?').run(new Date().toISOString(), r.id, p.guest);
  return { ok: true };
}

// The language a person's pages and code email are in.
export function setLang(id: number, lang: unknown, person?: unknown) {
  const r = cardRequest(id), p = r && personOf(r, person);
  if (!p) return 404;
  if (typeof lang !== 'string' || !Object.hasOwn(COPY, lang)) return 400;
  db.prepare('update guests set lang = ? where name = ?').run(lang, p.guest);
  return { ok: true };
}

// From the card: 'link' (a new link for one person, opening once shared; the one shared before stops working), 'person'
// (the card's Remove: their link to this request opens nothing, their other requests stay theirs; the last one too, so the
// board can invite someone else in their place), 'guest' (the guest can't open anything any more, and no agent can
// write to them) or 'request' (closed, as hq guest close does).
export function revoke(id: number, what: unknown, person?: unknown) {
  const r = cardRequest(id), p = r && personOf(r, person);
  if (!r || !p) return 404;
  // a new link opens once the board shares it, as a new request does
  if (what === 'link') {
    const { nonce, link } = fresh(r.id);
    db.prepare('update guest_people set nonce = ?, link = ?, released = null where request = ? and guest = ?').run(nonce, link, r.id, p.guest);
  } else if (what === 'person') {
    if (!active(p)) return 409;
    db.prepare('update guest_people set withdrawn = ? where request = ? and guest = ?').run(new Date().toISOString(), r.id, p.guest);
  } else if (what === 'guest') {
    db.prepare('update guests set revoked = ? where name = ?').run(new Date().toISOString(), p.guest);
    db.prepare('delete from guest_sessions where guest = ?').run(p.guest);
  } else if (what === 'request') {
    shut(r);
  } else {
    return 400;
  }
  const done = { link: `made a new link for ${p.guest} on guest request #${r.id}`, person: `removed ${p.guest} from guest request #${r.id}`,
    guest: `revoked ${p.guest}'s guest access`, request: `closed guest request #${r.id}` }[what];
  publish({ type: 'log', agent: r.agent, text: `The board ${done}.` });
  return { ok: true };
}

// ---------------------------------------------------------------- the guest's page: its words
// Every word the page and the code email say, per language (the guest's: guests.lang), one for each of the platform's
// (language.ts). Plain, short and warm, with no semicolons or dashes between clauses (the board's copy rules).
export const COPY = {
  nl: {
    locale: 'nl-NL', you: 'Jij',
    sections: { document: 'Documenten', question: 'Vragen', task: 'Taken', info: 'Goed om te weten' } as Record<Kind, string>,
    from: (agent: string) => `Van ${agent}`, before: (d: string) => `Graag vóór ${d}`,
    progress: (d: number, t: number) => `${d} van ${t} klaar`, mailTo: 'Mail documenten naar',
    mailed: 'Gemaild', done: 'Gedaan', na: 'Niet van toepassing', undo: 'Ongedaan maken', save: 'Bewaar', answer: 'Je antwoord',
    ask: 'Vraag stellen', question: 'Je vraag', send: 'Versturen', talk: (n: number) => `Gesprek (${n})`,
    closed: (d: string) => `Afgerond op ${d}`, closedNote: 'Deze aanvraag is klaar. Komt er nog iets nieuws, dan krijg je een nieuwe link.',
    footer: (co: string) => `Je schrijft met de AI-agents van ${co}, die het bedrijf runnen.`,
    more: (co: string) => `Meer van ${co} voor jou`, people: 'Wie hieraan werken', me: 'jij',
    verifyTitle: 'Even checken of jij het bent', verify: (co: string) => `Deze pagina van ${co} is voor één persoon. We sturen een code van 6 cijfers naar`,
    sendCode: 'Stuur de code', codeTitle: 'Vul je code in', codeSent: 'We hebben een code gestuurd naar', codeWorks: 'Hij werkt 10 minuten.',
    code: 'Code', openPage: 'Open de pagina', newCode: 'Stuur een nieuwe code', test: 'Testmodus: er is geen e-mail verstuurd. Hij zou dit zeggen:',
    noMail: 'We kunnen nog geen codes per e-mail sturen. Vraag het aan wie je deze link stuurde.',
    enough: 'Dat zijn genoeg codes voor nu. Probeer het over een uur nog eens.', mailFailed: 'De e-mail met je code ging niet weg. Probeer het later nog eens.',
    badAddress: 'De e-mail met je code kan niet weg: dit e-mailadres werkt niet. Vraag wie je deze link stuurde om het na te kijken.',
    tooMany: 'Te veel pogingen. Probeer het over een uur nog eens.', expired: 'Die code is verlopen of opgebruikt. Vraag een nieuwe aan.',
    wrong: (n: number) => `Die code klopt niet. Nog ${n} ${n === 1 ? 'poging' : 'pogingen'}.`, usedUp: 'Die code klopt niet en is nu opgebruikt. Vraag een nieuwe aan.',
    long: `Een bericht is 1 tot ${MAX_TEXT} tekens.`, busy: 'Dat zijn veel berichten in een uur. Wacht even voor je meer stuurt.',
    subject: (co: string) => `Je code voor ${co}`,
    email: (co: string, code: string) => `Je code om je pagina van ${co} te openen: ${code}\n\nHij werkt 10 minuten. Heb je hier niet om gevraagd? Dan kun je deze e-mail negeren.`,
    unavailable: 'Deze pagina kan nu niet open: aan onze kant moet eerst iets gerepareerd worden. Probeer het later nog eens.',
    copy: 'Kopieer', copied: 'Gekopieerd', number: 'Vul een getal in, zoals 3 of 3,5.',
    download: (name: string) => `${name} downloaden`,
    gone: { title: 'Deze link opent niets', text: 'Misschien is hij verkeerd overgenomen, of werkt hij niet meer. Vraag wie hem stuurde om een nieuwe.' },
    roomShut: 'Dit opent vanaf je eigen link: open de link die je kreeg en kies het daar.',
    // a colleague invited from the page (invite: the page's part, inviteEmail: what they get)
    invite: {
      title: 'Een collega erbij halen', name: 'Naam', address: 'E-mailadres', button: 'Uitnodigen', mailbox: 'naam',
      text: (domain: string) => `Wil je dit samen met een collega doen, of aan iemand overdragen? Nodig iemand uit met een e-mailadres op @${domain}. Die krijgt een eigen link per e-mail.`,
      left: (n: number) => n === 1 ? 'Je kunt nog 1 persoon uitnodigen.' : `Je kunt nog ${n} mensen uitnodigen.`,
      none: 'Je hebt alle uitnodigingen voor deze pagina gebruikt. Moet er nog iemand bij? Vraag het aan wie je deze link stuurde.',
      sent: (name: string) => `${name} heeft een uitnodiging gekregen.`,
      badName: 'Vul een voornaam of volledige naam in, met een hoofdletter.',
      domain: (domain: string) => `Je kunt alleen iemand uitnodigen met een e-mailadres op @${domain}.`,
      already: (name: string) => `${name} werkt hier al aan mee.`,
      refused: 'Deze persoon kun je hier niet uitnodigen. Vraag het aan wie je deze link stuurde.',
      bounced: 'De uitnodiging kan niet weg: dit e-mailadres werkt niet. Kijk het nog even na.',
      failed: 'De uitnodiging ging niet weg. Probeer het later nog eens.',
      unsure: (name: string) => `We weten niet zeker of de uitnodiging is verstuurd. ${name} staat nu wel op deze pagina. Komt er niets aan? Vraag wie jou deze link stuurde om ${name} de link te sturen.`,
      subject: (who: string, title: string) => `${who} vraagt je mee te helpen: ${title}`,
      email: (who: string, co: string, title: string, link: string) => `${who} heeft je uitgenodigd om mee te werken aan „${title}”, een pagina van ${co}.\n\nOpen hem hier: ${link}\n\nOm te checken dat jij het bent, sturen we je daar eerst een code van 6 cijfers. Verwachtte je dit niet? Dan kun je deze e-mail negeren.`,
    },
  },
  en: {
    locale: 'en-GB', you: 'You',
    sections: { document: 'Documents', question: 'Questions', task: 'Tasks', info: 'Good to know' } as Record<Kind, string>,
    from: (agent: string) => `From ${agent}`, before: (d: string) => `Please by ${d}`,
    progress: (d: number, t: number) => `${d} of ${t} done`, mailTo: 'Email documents to',
    mailed: 'Mailed', done: 'Done', na: 'Doesn’t apply', undo: 'Undo', save: 'Save', answer: 'Your answer',
    ask: 'Ask a question', question: 'Your question', send: 'Send', talk: (n: number) => `Conversation (${n})`,
    closed: (d: string) => `Completed on ${d}`, closedNote: 'This request is complete. If anything new comes up, you’ll get a new link.',
    footer: (co: string) => `You’re writing with ${co}’s AI agents, who run the company.`,
    more: (co: string) => `More for you from ${co}`, people: 'Who’s working on this', me: 'you',
    verifyTitle: 'Let’s check it’s you', verify: (co: string) => `This page from ${co} is for one person. We’ll send a 6-digit code to`,
    sendCode: 'Send the code', codeTitle: 'Enter your code', codeSent: 'We sent a code to', codeWorks: 'It works for 10 minutes.',
    code: 'Code', openPage: 'Open the page', newCode: 'Send a new code', test: 'Test mode: no email was sent. It would have said:',
    noMail: 'We can’t send codes by email yet. Please ask the person who sent you this link.',
    enough: 'That’s enough codes for now. Please try again in an hour.', mailFailed: 'The email with your code didn’t go out. Please try again later.',
    badAddress: 'The email with your code can’t go out: this email address doesn’t work. Please ask the person who sent you this link to check it.',
    tooMany: 'Too many tries. Please try again in an hour.', expired: 'That code has expired or is used up. Ask for a new one.',
    wrong: (n: number) => `That code isn’t right. ${n} ${n === 1 ? 'try' : 'tries'} left.`, usedUp: 'That code isn’t right, and it’s used up now. Ask for a new one.',
    long: `A message is 1 to ${MAX_TEXT} characters.`, busy: 'That’s a lot of messages in an hour. Please wait a little before sending more.',
    subject: (co: string) => `Your code for ${co}`,
    email: (co: string, code: string) => `Your code to open your page from ${co}: ${code}\n\nIt works for 10 minutes. If you didn’t ask for it, you can ignore this email.`,
    unavailable: 'This page can’t open right now: something on our side needs fixing first. Please try again later.',
    copy: 'Copy', copied: 'Copied', number: 'Please enter a number, like 3 or 3.5.',
    download: (name: string) => `Download ${name}`,
    gone: { title: 'This link doesn’t open anything', text: 'It may be mistyped, or it no longer works. Ask the person who sent it for a new one.' },
    roomShut: 'This opens from your own link: open the link you were sent and choose it there.',
    invite: {
      title: 'Bring in a colleague', name: 'Name', address: 'Email address', button: 'Invite', mailbox: 'name',
      text: (domain: string) => `Want to do this with a colleague, or hand it on? Invite someone with an @${domain} address. They’ll get a link of their own by email.`,
      left: (n: number) => n === 1 ? 'You can invite 1 more person.' : `You can invite ${n} more people.`,
      none: 'You’ve used all the invites for this page. If someone else needs to join, please ask the person who sent you this link.',
      sent: (name: string) => `${name} has been sent an invite.`,
      badName: 'Please enter a first name or full name, starting with a capital.',
      domain: (domain: string) => `You can only invite someone with an @${domain} address.`,
      already: (name: string) => `${name} is already working on this.`,
      refused: 'You can’t invite this person here. Please ask the person who sent you this link.',
      bounced: 'The invite can’t go out: this email address doesn’t work. Please check it.',
      failed: 'The invite didn’t go out. Please try again later.',
      unsure: (name: string) => `We can’t tell whether the invite went out. ${name} is on this page now. If nothing arrives, please ask the person who sent you this link to send ${name} theirs.`,
      subject: (who: string, title: string) => `${who} asked you to help: ${title}`,
      email: (who: string, co: string, title: string, link: string) => `${who} invited you to work on “${title}”, a page from ${co}.\n\nOpen it here: ${link}\n\nTo check it’s you, we’ll first send you a 6-digit code there. Not expecting this? You can ignore this email.`,
    },
  },
  de: {
    locale: 'de-DE', you: 'Du',
    sections: { document: 'Dokumente', question: 'Fragen', task: 'Aufgaben', info: 'Gut zu wissen' } as Record<Kind, string>,
    from: (agent: string) => `Von ${agent}`, before: (d: string) => `Bitte bis ${d}`,
    progress: (d: number, t: number) => `${d} von ${t} erledigt`, mailTo: 'Dokumente mailen an',
    mailed: 'Gemailt', done: 'Erledigt', na: 'Trifft nicht zu', undo: 'Rückgängig', save: 'Speichern', answer: 'Deine Antwort',
    ask: 'Eine Frage stellen', question: 'Deine Frage', send: 'Senden', talk: (n: number) => `Gespräch (${n})`,
    closed: (d: string) => `Abgeschlossen am ${d}`, closedNote: 'Diese Anfrage ist abgeschlossen. Kommt noch etwas Neues, bekommst du einen neuen Link.',
    footer: (co: string) => `Du schreibst mit den KI-Agents von ${co}, die das Unternehmen führen.`,
    more: (co: string) => `Mehr von ${co} für dich`, people: 'Wer daran arbeitet', me: 'du',
    verifyTitle: 'Kurz prüfen, ob du es bist', verify: (co: string) => `Diese Seite von ${co} ist für eine Person. Wir schicken einen 6-stelligen Code an`,
    sendCode: 'Code schicken', codeTitle: 'Gib deinen Code ein', codeSent: 'Wir haben einen Code geschickt an', codeWorks: 'Er gilt 10 Minuten.',
    code: 'Code', openPage: 'Seite öffnen', newCode: 'Neuen Code schicken', test: 'Testmodus: Es wurde keine E-Mail verschickt. Sie hätte gelautet:',
    noMail: 'Wir können noch keine Codes per E-Mail schicken. Frag bitte die Person, die dir diesen Link geschickt hat.',
    enough: 'Das sind genug Codes für jetzt. Versuch es in einer Stunde noch einmal.', mailFailed: 'Die E-Mail mit deinem Code ist nicht rausgegangen. Versuch es später noch einmal.',
    badAddress: 'Die E-Mail mit deinem Code kann nicht raus: Diese E-Mail-Adresse funktioniert nicht. Bitte die Person, die dir diesen Link geschickt hat, sie zu prüfen.',
    tooMany: 'Zu viele Versuche. Versuch es in einer Stunde noch einmal.', expired: 'Dieser Code ist abgelaufen oder aufgebraucht. Fordere einen neuen an.',
    wrong: (n: number) => `Dieser Code stimmt nicht. Noch ${n} ${n === 1 ? 'Versuch' : 'Versuche'}.`, usedUp: 'Dieser Code stimmt nicht und ist jetzt aufgebraucht. Fordere einen neuen an.',
    long: `Eine Nachricht hat 1 bis ${MAX_TEXT} Zeichen.`, busy: 'Das sind viele Nachrichten in einer Stunde. Warte kurz, bevor du mehr schickst.',
    subject: (co: string) => `Dein Code für ${co}`,
    email: (co: string, code: string) => `Dein Code, um deine Seite von ${co} zu öffnen: ${code}\n\nEr gilt 10 Minuten. Hast du ihn nicht angefordert? Dann kannst du diese E-Mail ignorieren.`,
    unavailable: 'Diese Seite lässt sich gerade nicht öffnen: Bei uns muss erst etwas repariert werden. Versuch es später noch einmal.',
    copy: 'Kopieren', copied: 'Kopiert', number: 'Gib eine Zahl ein, etwa 3 oder 3,5.',
    download: (name: string) => `${name} herunterladen`,
    gone: { title: 'Dieser Link öffnet nichts', text: 'Vielleicht wurde er falsch übernommen, oder er funktioniert nicht mehr. Bitte die Person, die ihn geschickt hat, um einen neuen.' },
    roomShut: 'Das öffnet sich über deinen eigenen Link: Öffne den Link, den du bekommen hast, und wähle es dort.',
    invite: {
      title: 'Jemanden aus deinem Team dazuholen', name: 'Name', address: 'E-Mail-Adresse', button: 'Einladen', mailbox: 'name',
      text: (domain: string) => `Möchtest du das gemeinsam mit jemandem aus deinem Team machen oder es abgeben? Lade jemanden mit einer E-Mail-Adresse auf @${domain} ein. Diese Person bekommt per E-Mail einen eigenen Link.`,
      left: (n: number) => n === 1 ? 'Du kannst noch 1 Person einladen.' : `Du kannst noch ${n} Personen einladen.`,
      none: 'Du hast alle Einladungen für diese Seite verwendet. Soll noch jemand dazukommen? Frag die Person, die dir diesen Link geschickt hat.',
      sent: (name: string) => `${name} hat eine Einladung bekommen.`,
      badName: 'Gib einen Vornamen oder vollen Namen ein, mit einem Großbuchstaben am Anfang.',
      domain: (domain: string) => `Du kannst nur jemanden mit einer E-Mail-Adresse auf @${domain} einladen.`,
      already: (name: string) => `${name} arbeitet hier schon mit.`,
      refused: 'Diese Person kannst du hier nicht einladen. Frag die Person, die dir diesen Link geschickt hat.',
      bounced: 'Die Einladung kann nicht raus: Diese E-Mail-Adresse funktioniert nicht. Prüf sie bitte noch einmal.',
      failed: 'Die Einladung ist nicht rausgegangen. Versuch es später noch einmal.',
      unsure: (name: string) => `Wir wissen nicht sicher, ob die Einladung verschickt wurde. ${name} steht jetzt aber auf dieser Seite. Kommt nichts an? Bitte die Person, die dir diesen Link geschickt hat, ${name} den Link zu schicken.`,
      subject: (who: string, title: string) => `${who} bittet dich um Hilfe: ${title}`,
      email: (who: string, co: string, title: string, link: string) => `${who} hat dich eingeladen, an „${title}“ mitzuarbeiten, einer Seite von ${co}.\n\nHier öffnest du sie: ${link}\n\nDamit wir wissen, dass du es bist, schicken wir dir dort zuerst einen 6-stelligen Code. Hast du das nicht erwartet? Dann kannst du diese E-Mail ignorieren.`,
    },
  },
} satisfies Record<BoardLanguage, unknown>;

// ---------------------------------------------------------------- the guest's page: how it looks
// GET /guest/<token>, and the page's forms: POST …/send (a code), …/verify, …/item (a tick or an answer), …/ask (a question
// on an item). Every form works as a plain post; guest.js, when it runs, posts them in place and eases the change in. Every
// POST has passed server.ts's Origin check. A token that's wrong, of a closed-off guest, of a guest without an address, of
// a request the board hasn't shared yet or of a request closed long ago gets the
// same page.
const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null;
// the page's accent, as look() and brand.yaml's guest colours make it (the first person's colour)
const accent = () => { const b = brandLook(); return hex(b.guest?.colours?.accent) ?? hex(b.colours?.blue) ?? '#3a63c8'; };

// The company's look on the guest page: brand.yaml's guest: section (template/company/brand.yaml has its keys, all
// optional). Its files live in theme/guest/ and are served at /guest/theme/<file>, only those the section names, and only
// from inside that folder (files.ts: no symlink leads out of it, audit NI1). Without it the page is neutral: HQ's logo,
// the system font, the colours below.
const THEME = `${REPO_DIR}/theme/guest`, FILE = /^[\w-]+\.(svg|png|woff2)$/;
const TYPE: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' };
const themeFile = (name: string) => inside(THEME, name, REPO_DIR);
const COLOURS = { background: '--bg', card: '--card', ink: '--ink', muted: '--muted', line: '--line', accent: '--accent', onAccent: '--on' };
type Look = ReturnType<typeof look>;
// (the join link's page wears it too: joinpage.ts)
export function look() {
  const b = brandLook(), g = b.guest ?? {}, file = (v: unknown) => typeof v === 'string' && FILE.test(v) && themeFile(v) ? v : null;
  const fonts = (Array.isArray(g.font?.files) ? g.font.files : []).filter((f: any) => file(f?.file) && f.file.endsWith('.woff2'))
    .map((f: any) => ({ file: f.file, weight: /^[1-9]00$/.test(String(f.weight)) ? f.weight : 400, style: f.style === 'italic' ? 'italic' : 'normal' }));
  const family = fonts.length && typeof g.font?.family === 'string' && /^[\w ]{1,60}$/.test(g.font.family) ? g.font.family : null;
  const dark = g.dark !== false, light = file(g.logo), night = dark ? file(g.logoDark) : null, favicon = file(g.favicon);
  return { dark, logo: light, logoDark: night, favicon, files: new Set([light, night, favicon, ...fonts.map((f: any) => f.file)].filter(Boolean)),
    accent: hex(b.colours?.blue) ?? '#3a63c8', logoHeight: Number.isInteger(g.logoHeight) && g.logoHeight >= 12 && g.logoHeight <= 120 ? g.logoHeight : 28,
    pixelated: g.pixelated === true, family: family ? `'${family}',` : '',
    vars: `${Object.entries(COLOURS).filter(([k]) => hex(g.colours?.[k])).map(([k, v]) => `${v}:${g.colours[k]};`).join('')}${Number.isInteger(g.buttonRadius) && g.buttonRadius >= 0 && g.buttonRadius <= 40 ? `--btn-r:${g.buttonRadius}px` : ''}`,
    fonts: fonts.map((f: any) => `@font-face{font-family:'${family}';src:url(/guest/theme/${f.file}) format('woff2');font-weight:${f.weight};font-style:${f.style};font-display:swap}`).join('') };
}
type Legend = ReturnType<typeof legendOf>;
// The page's colours, which review mode's menus take too, on a product page's :host (feedback.ts): the neutral ones, brand.yaml's guest colours over them, and the dark ones where the look has them
export const palette = (at = ':root', l: Look = look()) => `${at}{--accent:${l.accent};--bg:#f4f5f8;--card:#fff;--ink:#1b2130;--muted:#5d6577;--line:#e3e6ec;--soft:color-mix(in srgb,var(--accent) 9%,var(--card));--on:#fff;--warn:#fff4dc;--shadow:0 1px 2px rgb(20 28 45/.06),0 6px 20px rgb(20 28 45/.07);--link:var(--accent);--btn-r:99px}
${at}{${l.vars}}${l.dark ? `
@media (prefers-color-scheme:dark){${at}{--bg:#111318;--card:#1b1e25;--ink:#e9ecf2;--muted:#a1a9b8;--line:#2c313b;--warn:#3a321f;--shadow:0 1px 2px rgb(0 0 0/.3),0 8px 24px rgb(0 0 0/.35);--link:color-mix(in srgb,var(--accent) 60%,#fff)}}
` : ''}`;
const style = (l: Look, pct: number, legend: Legend = []) => `${palette(':root', l)}:root{interpolate-size:allow-keywords}
${l.fonts}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:1rem/1.55 ${l.family}system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header,main{max-width:640px;margin:auto;padding:0 16px}header{padding-top:24px;padding-bottom:4px}header img{height:${l.logoHeight}px;width:auto${l.pixelated ? ';image-rendering:pixelated' : ''}}main{padding-bottom:48px}
@media (min-width:900px){html{font-size:17.5px}header,main{max-width:700px}}
.card{background:var(--card);border-radius:18px;box-shadow:var(--shadow);padding:22px;margin:14px 0}h1{font-size:1.45rem;line-height:1.25;letter-spacing:-.01em;margin:0 0 6px}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:30px 4px 8px}.meta,.note{color:var(--muted);font-size:.88rem}.note{margin:24px 4px}
.before{display:inline-block;margin-top:10px;padding:3px 10px;border-radius:99px;background:var(--soft);font-size:.88rem;font-weight:600}.intro{white-space:pre-wrap;margin:14px 0 0}
.steps{margin:14px 0 0;padding:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;position:relative;padding-left:38px;margin-top:12px}
.steps li::before{content:counter(step);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:var(--soft);color:var(--link);font-weight:700;font-size:.85rem;display:grid;place-items:center}
.steps .voucherbox{margin-top:10px}@media (max-width:420px){.steps .voucherbox{margin-left:-38px}}.small{margin:16px 0 0}
.aside{margin:20px 0 0;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}.aside b{color:var(--ink);font-weight:600}.aside ul{margin:4px 0 0;padding-left:18px}.aside li{margin-top:2px}
.voucherbox{margin:16px 0 0;padding:12px 14px;border-radius:12px;background:var(--soft);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px}.voucher{margin:0}.voucher b{display:block;font-size:1.05rem;letter-spacing:.02em;white-space:nowrap;user-select:all}
.progress{margin-top:18px}.progress b{font-size:.95rem}.bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;width:${pct}%;border-radius:inherit;background:var(--accent);transition:width .6s cubic-bezier(.2,.8,.2,1)}
ul.items{list-style:none;margin:0;padding:0}.item{background:var(--card);border-radius:16px;box-shadow:var(--shadow);padding:16px 18px;margin:10px 0}
.row{display:flex;gap:14px;align-items:flex-start}.check{flex:none;width:26px;height:26px;margin-top:1px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;transition:background .25s,border-color .25s}
.check svg{width:14px;height:14px;fill:none;stroke:var(--on);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:24;stroke-dashoffset:24}
.done .check{background:var(--accent);border-color:var(--accent)}.done .check svg{stroke-dashoffset:0}.na .check{border-style:dashed}
.info .check{border:0;background:var(--soft);color:var(--link);font:700 .85rem/1 Georgia,serif}.just.done .check{animation:pop .35s ease-out}.just.done .check svg{animation:draw .35s .1s ease-out both}.just .what{animation:settle .4s ease-out}
@keyframes pop{0%{transform:scale(.6)}60%{transform:scale(1.15)}100%{transform:scale(1)}}@keyframes draw{from{stroke-dashoffset:24}}@keyframes settle{from{opacity:.4}}
.what{flex:1;min-width:0}.what b{display:block;font-weight:600;overflow-wrap:anywhere}.done .what b,.na .what b{color:var(--muted)}.detail{color:var(--muted);font-size:.9rem;margin-top:2px}
.state{display:inline-block;margin-top:6px;font-size:.88rem;font-weight:600;color:var(--link)}.acts .state{margin:0 4px 0 0}.said{margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}
form{margin:0}.acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
button,a.button{font:inherit;font-weight:600;font-size:.92rem;border:0;border-radius:var(--btn-r);padding:9px 16px;min-height:40px;cursor:pointer;background:var(--accent);color:var(--on);transition:transform .15s,filter .15s,background .15s}
a.button{display:inline-flex;align-items:center;text-decoration:none}button:hover,a.button:hover{filter:brightness(1.07)}button:active,a.button:active{transform:scale(.97)}button.soft,a.button.soft{background:var(--soft);color:var(--ink)}/* (a.button.soft) */button.link{background:none;color:var(--muted);padding:9px 4px;font-weight:500}
button.chip{background:var(--card);color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line)}button.chip.on{background:var(--accent);color:var(--on);box-shadow:none}
input,textarea{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1.5px solid var(--line);border-radius:12px;padding:9px 12px;transition:border-color .15s}
input:focus,textarea:focus{border-color:var(--accent);outline:0}button:focus-visible,summary:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
.answer{display:flex;gap:8px;margin-top:12px}.answer input{flex:1}.num{flex:1;display:flex;align-items:center;gap:8px}.num input{max-width:10em}.num .unit{color:var(--muted);font-weight:600}label.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
details{margin-top:6px}summary{display:inline-block;cursor:pointer;color:var(--link);font-size:.9rem;font-weight:600;list-style:none;padding:4px 0}summary::-webkit-details-marker{display:none}
details::details-content{height:0;overflow:clip;transition:height .3s ease,content-visibility .3s allow-discrete}details[open]::details-content{height:auto}
.msg{background:var(--bg);border-radius:12px;padding:8px 12px;margin:8px 0}.msg.theirs{background:var(--soft)}.msg .text{white-space:pre-wrap;overflow-wrap:anywhere}
.pics{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}.pic{display:block;max-width:100%;border-radius:10px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--line);cursor:zoom-in}
.pic img{display:block;max-width:100%;max-height:160px;width:auto;height:auto}.zoom{position:fixed;inset:0;z-index:9;display:grid;place-items:center;padding:16px;background:rgb(10 12 18/.9);cursor:zoom-out;animation:settle .2s ease-out}
.zoom img{max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);object-fit:contain;border-radius:6px}
.files{list-style:none;display:grid;gap:6px;margin:10px 0 0;padding:0}.files li{display:flex;align-items:center;gap:10px;min-width:0}.files .size{flex:none;color:var(--muted);font-size:.85rem}
a.file{display:inline-flex;align-items:center;gap:8px;min-width:0;min-height:40px;padding:6px 14px 6px 10px;border-radius:12px;background:var(--soft);color:var(--ink);font-weight:600;font-size:.92rem;text-decoration:none;transition:transform .15s,filter .15s}
a.file:hover{filter:brightness(.97)}a.file:active{transform:scale(.97)}a.file svg{flex:none;width:18px;height:18px;fill:none;stroke:var(--link);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}a.file span,.files .gone{overflow-wrap:anywhere}.files .gone{color:var(--muted)}
#invite>p:first-child{margin-top:0}.inviting{display:grid;gap:8px;margin:12px 0 8px}.inviting button{justify-self:start}
@media (min-width:560px){.inviting{grid-template-columns:1fr 1.5fr auto}}.sent{font-weight:600;color:var(--link)}
details textarea{margin-top:8px}details button{margin-top:8px}.alert{background:var(--warn);border-radius:12px;padding:10px 14px;margin:12px 0}.closed{background:var(--soft)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.88rem;margin:6px 0 0}ul.more{padding-left:20px}a{color:var(--link)}input.code{font-size:1.4rem;letter-spacing:.3em;max-width:11ch}
@media (prefers-reduced-motion:reduce){*,*::before,*::after,::details-content{animation:none!important;transition:none!important}}${legend.length ? `
${legend.map((p, k) => `.w${k}{--who:${p.colour}}`).join('')}.people{display:flex;flex-wrap:wrap;gap:4px 16px;list-style:none;margin:16px 0 0;padding:0;font-size:.88rem}
.people li,.by{display:inline-flex;align-items:center;gap:6px}.people i,.by i{flex:none;width:10px;height:10px;border-radius:50%;background:var(--who)}.people .me{color:var(--muted)}
.by{font-size:.88rem;font-weight:600;color:var(--muted);margin-left:8px}.by.line{display:flex;margin:6px 0 0}.acts .by,.meta .by{margin:0 6px 0 2px}.meta .by{font-size:inherit}
.item.done .check{background:var(--who,var(--accent));border-color:var(--who,var(--accent))}button.chip.on{background:var(--who,var(--accent))}` : ''}`;   // (the legend's)
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// The pages' money and days: each language's locale, on the company's clock
export const pageFormats = () =>
  companyFormats('EUR', Object.fromEntries(Object.entries(COPY).map(([lang, copy]) => [lang, copy.locale])));
const day = (ts: string, lang: Lang) => {
  const f = pageFormats();
  return f.day(f.dayAt(Date.parse(ts)), lang, { year: true });
};
const when = (ts: string, lang: Lang) => pageFormats().moment(Date.parse(ts), lang, { short: true });
export const SCRIPT = readFileSync(new URL('./guest.js', import.meta.url), 'utf8');

// The company's logo atop a guest's page, light and dark, its size the page's style's (logoCss) (a room's page too:
export function logoHtml() {
  const b = brand(),
    n = names().name,
    l = look();
  const src = l.logo ? `/guest/theme/${l.logo}` : `/${esc(logo(b))}`,
    darkSrc = l.logo ? l.logoDark && `/guest/theme/${l.logoDark}` : l.dark && `/${esc(darkLogo(b))}`;
  return `<picture>${darkSrc ? `<source srcset="${darkSrc}" media="(prefers-color-scheme: dark)">` : ''}<img src="${src}" alt="${esc(b.logo?.alt ?? n)}"></picture>`;
}
export const logoCss = (at: string, l: Look = look()) =>
  `${at} img{height:${l.logoHeight}px;width:auto${l.pixelated ? ';image-rendering:pixelated' : ''}}`;
function html(res: ServerResponse, status: number, lang: Lang, body: string, pct = 0, headers: Record<string, string> = {}, legend: Legend = []) {
  const n = names().name, l = look(), css = style(l, pct, legend);
  // same-origin, not no-referrer: the link (its token) never goes to another site, and a browser still sends the page's
  // own Origin with its forms (no-referrer makes it "null", which server.ts refuses)
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, ...headers });
  res.end(`<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(n)}</title>${l.favicon ? `<link rel="icon" href="/guest/theme/${l.favicon}">` : ''}<style>${css}</style><script src="/guest/guest.js" defer></script>
<header>${logoHtml()}</header>
<main>${body}</main>`); // (logoHtml)
}
// (who the link is for isn't known here, so it says it in every language, the first the page's)
const gone = (res: ServerResponse) => {
  const [first] = Object.keys(COPY) as Lang[];
  const said = Object.entries(COPY).map(([lang, t]) => {
    const at = lang === first ? '' : ` lang="${lang}"`;
    return `<h1${at}>${esc(t.gone.title)}</h1><p${at}>${esc(t.gone.text)}</p>`;
  });
  html(res, 404, first, `<div class="card">${said.join('\n')}</div>`);
};

// Per client and hour: the few requests a person makes, never a guessing run.
const hits = new Map<string, number[]>();
function allowed(kind: keyof typeof PER_IP, client: string) {
  const now = Date.now(), key = `${kind}:${client}`, recent = (hits.get(key) ?? []).filter(t => t > now - 3600e3);
  if (hits.size > 10_000) hits.clear();   // a flood of clients forgets them all rather than grow without end
  if (recent.length >= PER_IP[kind]) { hits.set(key, recent); return false; }
  hits.set(key, [...recent, now]);
  return true;
}

const cookies = (req: IncomingMessage) => Object.fromEntries(String(req.headers.cookie ?? '').split(/;\s*/).filter(Boolean)
  .map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
const verified = (req: IncomingMessage, name: string) => {
  const t = cookies(req).g;
  return !!t && !!db.prepare('select 1 from guest_sessions where hash = ? and guest = ? and expires > ?').get(sha256(t), name, Date.now());
};
// SameSite=Lax, not Strict: the guest opens the link from their mail or chat app, a cross-site navigation that would leave
// a Strict cookie behind and ask for a code every time. Lax goes only with that GET; every POST is checked for our Origin.
const secure = ORIGIN.startsWith('https') ? '; Secure' : '';
function startSession(name: string) {
  const t = randomBytes(32).toString('base64url');
  db.prepare('delete from guest_sessions where expires < ?').run(Date.now());
  db.prepare('insert into guest_sessions (hash, guest, expires) values (?, ?, ?)').run(sha256(t), name, Date.now() + SESSION_DAYS * 864e5);
  db.prepare('update guests set verified = ? where name = ?').run(new Date().toISOString(), name);
  return { 'set-cookie': `g=${t}; Path=/guest/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}` };
}

async function form(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) if ((raw += chunk).length > 100_000) return null;
  return new URLSearchParams(raw);
}

const codeHash = (name: string, code: string) => sign(`code:${name.toLowerCase()}:${code}`);
function verifyPage(res: ServerResponse, url: string, g: Guest, o: { code?: boolean; error?: string; test?: { subject: string; text: string } } = {}, status = 200) {
  const lang = langOf(g), t = COPY[lang], who = `<b>${esc(masked(g.email!))}</b>`;
  html(res, status, lang, `<div class="card"><h1>${o.code ? t.codeTitle : t.verifyTitle}</h1>
${o.error ? `<p class="alert" role="alert">${esc(o.error)}</p>` : ''}
${o.code ? `<p>${t.codeSent} ${who}. ${t.codeWorks}</p>
${o.test ? `<div class="alert"><b>${t.test}</b><pre>${esc(o.test.subject)}\n\n${esc(o.test.text)}</pre></div>` : ''}
<form method="post" action="${url}/verify"><label for="code">${t.code}</label><div class="answer"><input class="code" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus><button>${t.openPage}</button></div></form>
<form method="post" action="${url}/send"><button class="link">${t.newCode}</button></form>`
  : `<p>${esc(t.verify(names().name))} ${who}.</p><form method="post" action="${url}/send"><button>${t.sendCode}</button></form>`}</div>`);
}

// With several people: a person's colour (the legend's class) and their name in it, You for the reader
const whoClass = (legend: Legend, name: string) => ` w${legend.findIndex(p => sameName(p.name, name))}`;
const byHtml = (name: string, me: string, t: Copy, cls = '') => `<span class="by${cls}"><i></i>${esc(sameName(name, me) ? t.you : name)}</span>`;
// One message on an item: the agent's under their name, the guest's as You (with several people, under whose it is), and
// an agent's pictures under its words: a tap opens one big (guest.js). Without the script, it opens the picture itself.
function messageHtml(r: Request, m: Message, url: string, lang: Lang, legend: Legend, me: string) {
  const t = COPY[lang];
  let cls = '';
  let label = esc(`${agentName(m.who)}, ${names().name}`);
  if (m.who === 'guest') {
    const person = m.person ?? r.guest;
    cls = legend.length ? ` theirs${whoClass(legend, person)}` : ' theirs';
    label = legend.length ? byHtml(person, me, t) : esc(t.you);
  }
  const pictures = m.who === 'guest' ? '' : picturesHtml(url, m);   // (pictures)
  return `<div class="msg${cls}"><div class="meta">${label} · ${when(m.ts, lang)}</div><div class="text">${esc(m.text)}</div>${pictures}</div>`;
}
// An agent's reply's pictures, each a link to itself
function picturesHtml(url: string, m: Message) {
  const pictures = picturesOf(m).map((path, k) => {
    const src = `${url}/picture/${m.id}/${k}`;
    const alt = esc(pictureTitle(path));
    return `<a class="pic" href="${src}"><img src="${src}" alt="${alt}" loading="lazy"></a>`;
  });
  return pictures.length ? `<div class="pics">${pictures.join('')}</div>` : '';
}
const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
// An item's files, each a download by its name with its size; once its bytes are gone, the name alone.
const DOWNLOAD = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9.5M6 9l4 4 4-4M4 16.5h12"/></svg>';
function filesHtml(r: Request, i: Item, url: string, lang: Lang) {
  const files = filesOf(r, i);
  if (!files.length) return '';
  const t = COPY[lang], size = (n: number) => sizeOf(n, t.locale);
  return `<ul class="files">${files.map(f => `<li>${f.kept
    ? `<a class="file" href="${url}/file/${f.n}" download="${esc(f.name)}" aria-label="${esc(t.download(f.name))}, ${size(f.size)}">${DOWNLOAD}<span>${esc(f.name)}</span></a>`
    : `<span class="gone">${esc(f.name)}</span>`}<span class="size"${f.kept ? ' aria-hidden="true"' : ''}>${size(f.size)}</span></li>`).join('')}</ul>`;
}
// A file's size as a person reads it: 820 B, 14 KB, 1,2 MB
const sizeOf = (n: number, locale: string) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB`
  : `${(n / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
function itemHtml(r: Request, i: Item, url: string, lang: Lang, open: boolean, legend: Legend, me: string) {
  const t = COPY[lang], msgs = thread(r.id, i.n);
  // With several people: whose an item's tick or answer is, in their colour and by name (You for the reader).
  const marked = legend.length && i.state ? byOf(r, i) : null;
  const mine = marked ? byHtml(marked, me, t) : '';
  const line = marked && (i.kind === 'question' || !open) ? byHtml(marked, me, t, ' line') : '';
  const hidden = `<input type="hidden" name="n" value="${i.n}">`, act = (action: string, label: string, cls = '') => `<button name="action" value="${action}"${cls ? ` class="${cls}"` : ''}>${label}</button>`;
  const ticked = i.kind === 'document' ? t.mailed : t.done;
  const state = i.state === 'na' ? t.na : i.state && i.kind !== 'question' ? ticked : '';
  const acts = !open || i.kind === 'info' ? ''
    // a question's field is the shared engine's (questions.js): chips that post their answer, or a box with Save
    : i.kind === 'question' ? (asking.chips(asked(i))
      ? `<form method="post" action="${url}/item" class="acts" data-live>${hidden}${asking.inputHtml(asked(i), { value: i.answer ?? '', lang, post: true })}</form>`
      : `<form method="post" action="${url}/item" class="answer" data-live>${hidden}<label class="sr" for="a${i.n}">${t.answer}</label>${asking.inputHtml(asked(i), { id: `a${i.n}`, value: i.answer ?? '', lang, placeholder: t.answer, required: true })}<button class="soft">${t.save}</button></form>`)
    : `<form method="post" action="${url}/item" class="acts" data-live>${hidden}${i.state ? `<span class="state">${state}</span>${mine}${act('undo', t.undo, 'link')}` : act('done', ticked) + (i.optional ? act('na', t.na, 'soft') : '')}</form>`;
  const ask = msgs.length || open ? `<details><summary>${!open ? t.talk(msgs.length) : msgs.length ? `${t.ask} (${msgs.length})` : t.ask}</summary>
${msgs.map(m => messageHtml(r, m, url, lang, legend, me)).join('')}
${open ? `<form method="post" action="${url}/ask" data-live>${hidden}<label class="sr" for="q${i.n}">${t.question}</label><textarea id="q${i.n}" name="text" rows="3" maxlength="${MAX_TEXT}" placeholder="${t.question}" required></textarea><button class="soft">${t.send}</button></form>` : ''}</details>` : '';
  const files = filesHtml(r, i, url, lang);
  return `<li class="item ${i.kind}${i.state === 'na' ? ' na' : i.state ? ' done' : ''}${marked ? whoClass(legend, marked) : ''}" id="i${i.n}"><div class="row"><span class="check">${i.kind === 'info' ? 'i' : TICK}</span><div class="what">
<b>${esc(i.title)}</b>${i.detail ? `<div class="detail">${esc(i.detail)}</div>` : ''}${files}${state && !open ? `<span class="state">${state}</span>` : ''}
${i.kind === 'question' && i.answer && !open ? `<div class="said">${esc(saidOf(i, lang))}</div>` : ''}${acts}${line}${ask}</div></div></li>`;
}

// Only for the guest's own verified session: every other visitor of the link, an error's included, gets the code page
// (audit NI2: a body too long for the form showed the request before the code was asked).
// invited: a colleague just invited, or why not (inviteHtml)
function requestPage(req: IncomingMessage, res: ServerResponse, url: string, r: Request, g: Guest, error?: string, status = 200, invited?: Invited) {
  if (!verified(req, g.name)) return verifyPage(res, url, g, error ? { error } : {}, status);
  const lang = langOf(g), t = COPY[lang], co = names().name, list = items(r.id), p = progress(list), open = r.status === 'open';
  const legend = legendOf(r, people(r.id), list);
  const sections: { title: string; items: Item[] }[] = [];
  for (const i of list) {
    const title = i.section || t.sections[i.kind], last = sections.at(-1);
    if (last?.title === title) last.items.push(i); else sections.push({ title, items: [i] });
  }
  // (the guest's own links to them)
  const others = (db.prepare(`select r.id, r.title, p.nonce from guest_requests r join guest_people p on p.request = r.id where p.guest = ? and r.id != ?
    and p.released is not null and p.withdrawn is null and (r.status = 'open' or r.closed > ?) order by r.id desc`)
    .all(g.name, r.id, new Date(Date.now() - KEEP_DAYS * 864e5).toISOString()) as { id: number; title: string; nonce: string }[]);
  const mail = documents(), pct = p.total ? Math.round(100 * p.done / p.total) : 100;
  html(res, status, lang, `<div class="card${open ? '' : ' closed'}"><h1>${esc(r.title)}</h1><div class="meta">${esc(t.from(agentName(r.agent)))}</div>
${open && r.before ? `<span class="before">${esc(t.before(r.before))}</span>` : ''}${!open ? `<p><b>${esc(t.closed(day(r.closed!, lang)))}</b><br>${t.closedNote}</p>` : ''}
${r.body ? `<div class="intro">${esc(r.body)}</div>` : ''}
${p.total ? `<div class="progress" id="progress" data-pct="${pct}"><b>${esc(t.progress(p.done, p.total))}</b><div class="bar" id="bar"><i></i></div></div>` : ''}
${legend.length ? `<ul class="people" aria-label="${t.people}">${legend.map((x, k) => `<li class="w${k}"><i></i>${esc(x.name)}${sameName(x.name, g.name) ? ` <span class="me">(${t.me})</span>` : ''}</li>`).join('')}</ul>` : ''}</div>
${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ''}
${sections.map(s => `<h2>${esc(s.title)}</h2>${open && mail && s.items.some(i => i.kind === 'document') ? `<p class="meta">${t.mailTo} <a href="mailto:${esc(mail)}">${esc(mail)}</a>.</p>` : ''}
<ul class="items">${s.items.map(i => itemHtml(r, i, url, lang, open, legend, g.name)).join('')}</ul>`).join('')}
${inviteHtml(r, g, url, lang, invited)}<p class="note">${esc(t.footer(co))}</p>
${others.length ? `<h2>${esc(t.more(co))}</h2><ul class="more">${others.map(o => `<li><a href="/guest/${tokenOf(o.id, o.nonce)}">${esc(o.title)}</a></li>`).join('')}</ul>` : ''}`, pct, {}, legend);
}

// A colleague to invite, while the board allows it and this guest is at its domain: a name and an address, how many more
// may come, and after one is sent, that it went (in test mode, the email it would have been), or why it didn't, with what
// was typed kept
type Invited = { sent?: string; test?: { subject: string; text: string }; error?: string; name?: string; email?: string };
function inviteHtml(r: Request, g: Guest, url: string, lang: Lang, o: Invited = {}) {
  const left = invitesLeft(r, g), t = COPY[lang], w = t.invite;
  if (left === null) return '';
  const done = o.error ? `<p class="alert" role="alert">${esc(o.error)}</p>`
    : o.sent ? `<p class="sent" role="status">${esc(w.sent(o.sent))}</p>${o.test ? `<div class="alert"><b>${t.test}</b><pre>${esc(o.test.subject)}\n\n${esc(o.test.text)}</pre></div>` : ''}` : '';
  const kept = (v?: string) => v ? ` value="${esc(v)}"` : '';
  const form = left ? `<form method="post" action="${url}/invite#invite" class="inviting"><label class="sr" for="iname">${w.name}</label><input id="iname" name="name" placeholder="${w.name}" autocomplete="off" maxlength="60" required${kept(o.error && o.name)}>
<label class="sr" for="imail">${w.address}</label><input id="imail" name="email" type="email" placeholder="${esc(`${w.mailbox}@${r.colleagues}`)}" autocomplete="off" spellcheck="false" required${kept(o.error && o.email)}><button>${w.button}</button></form>
<p class="meta">${w.left(left)}</p>` : `<p class="meta">${w.none}</p>`;
  return `<h2>${w.title}</h2><div class="card" id="invite">${done}<p>${esc(w.text(r.colleagues!))}</p>${form}</div>`;
}

// A person's link, while it opens: their request and their guest, or null once it's withdrawn, unshared, renewed, revoked
// or kept past its time
function opening(token: string) {
  const p = db.prepare('select * from guest_people where link = ?').get(sha256(token)) as Pick<Person, 'request' | 'guest' | 'released' | 'withdrawn'> | undefined;
  const r = p && request(p.request), g = p && guest(p.guest);
  return p && r && g?.email && p.released && !p.withdrawn && !g.revoked && !expired(r) ? { r, g } : null;
}

// ---------------------------------------------------------------- doors
// Something another module shares with a guest, behind the same sign-in as a request (shares.ts: a preview for their
// notes). Its link has a request's shape, /guest/<token>, signed with the guest desk's key from what names the door
// (doorLink); the module keeps the token's sha256 and finds its door by it. Once the guest has proved the address, the
// door's page says what it is, and its one button leads on (go: where to, or null once the door has closed). A door may
// give its guest a code of their own too (code: a tester's voucher). The page shows the code above the button, with a
// Copy button that guest.js turns on. A door's words may also be numbered steps under a greeting, with the code in the
// first step, and a small line after them (steps, small). A step's **…** is bold: the only markup a door's words take,
// made after escaping. Under the steps, a quieter aside may say more in a few lines under its own heading (aside). A door
// closed for good may say why in one line (shut), in place of the page that says the link opens nothing.
export type Door = { guest: string; open: boolean; words: (lang: Lang) => { title: string; text: string; button: string;
  code?: { label: string; value: string }; steps?: string[]; aside?: { title: string; lines: string[] }; small?: string };
  go: () => string | null; shut?: (lang: Lang) => string;
  // a call to talk it through, as a second button beside the first: its words and where it goes
  talk?: (lang: Lang) => { button: string; go: string } | null };
// A door that can't open now because its module's setup is broken (its message says how): the guest's page says so plainly,
// and the cause goes to the log.
export class DoorError extends Error {}
const doors: ((link: string) => Door | undefined)[] = [];
export const addDoor = (find: (link: string) => Door | undefined) => { doors.push(find); };
const doorOf = (link: string) => doors.map(find => find(link)).find(Boolean);
export const doorLink = (name: string) => { const token = sign(`door:${name}`); return { url: `${ORIGIN}/guest/${token}`, link: sha256(token) }; };

// The guest a request's own session on /guest/ is for (the g cookie), while they still have an address and aren't
// revoked
export function signedIn(req: IncomingMessage) {
  const token = cookies(req).g;
  const session = token
    ? db.prepare('select guest from guest_sessions where hash = ? and expires > ?').get(sha256(token), Date.now()) as { guest: string } | undefined
    : undefined;
  const g = session && guest(session.guest);
  return g?.email && !g.revoked ? g : null;
}

// A room of a guest's own beyond their links (sketches.ts: their Sketchbook): /guest/<path>[/…], for their own session
// only (signedIn), while it opens for them; their door's page has a button to it (label). serve gets the rest of the
// path after /guest/<path>. (server.ts refuses a POST to /guest/ from any other origin.).
export type Room = {
  path: string;
  opens: (guest: string) => boolean;
  label: (lang: Lang) => string;
  serve: (req: IncomingMessage, res: ServerResponse, guest: string, rest: string) => unknown;
};
const rooms: Room[] = [];
export const addRoom = (r: Room) => {
  rooms.push(r);
};
const roomOf = (path: string) => rooms.find(r => path === `/guest/${r.path}` || path.startsWith(`/guest/${r.path}/`));
const roomsFor = (g: Guest) => rooms.filter(r => r.opens(g.name));
// Someone without a session, or one it doesn't open for: the page the room's own address shows says how to come in,
// anything else of it opens nothing
function inRoom(req: IncomingMessage, res: ServerResponse, room: Room, rest: string) {
  const g = signedIn(req);
  if (g && room.opens(g.name)) return room.serve(req, res, g.name, rest);
  if (req.method !== 'GET' || rest.startsWith('/api/')) {
    res.writeHead(g ? 403 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: g ? 'this isn’t open for you' : 'sign in from your own link first' }));
  }
  const lang = g ? langOf(g) : 'en';
  html(
    res,
    g ? 403 : 401,
    lang,
    `<div class="card"><h1>${esc(room.label(lang))}</h1><p>${esc(COPY[lang].roomShut)}</p></div>`,
  );
}

// Onward (/guest/onward?to=<url>): a page a guest's door opens, reached without the door's link (a demo on another preview
// host that the deck a share opens links to). The preview's sign-in sends a visitor without the board's session here
// (server.ts), and the guest's own session finds the door module that hands them on (addOnward: where to, or null).
// Anyone else goes to HQ's sign-in.
const onwards: ((guest: string, url: string) => string | null)[] = [];
export const addOnward = (find: (guest: string, url: string) => string | null) => { onwards.push(find); };
function handOnward(req: IncomingMessage, res: ServerResponse) {
  const destination = new URL(req.url ?? '/', 'http://x').searchParams.get('to') ?? '';
  const g = signedIn(req);
  const handedOn = g ? onwards.map(find => find(g.name, destination)).find(Boolean) : null;
  res.writeHead(302, { location: handedOn ?? '/login', 'cache-control': 'no-store' });
  res.end();
}

function doorPage(req: IncomingMessage, res: ServerResponse, url: string, d: Door, g: Guest, error?: string, status = 200) {
  if (!verified(req, g.name)) return verifyPage(res, url, g, error ? { error } : {}, status);
  const lang = langOf(g);
  let w: ReturnType<Door['words']>;
  try { w = d.words(lang); } catch (err) {
    if (!(err instanceof DoorError)) throw err;
    console.error(`Guest desk: a door can't open: ${err.message}`);
    return html(res, 503, lang, `<div class="card"><p>${esc(COPY[lang].unavailable)}</p></div>`);
  }
  const copy = w.code?.value ? `<button type="button" class="chip copy" data-copy="${esc(w.code.value)}" data-copied="${esc(COPY[lang].copied)}" hidden>${esc(COPY[lang].copy)}</button>` : '';
  const code = w.code ? `<div class="voucherbox"><p class="voucher">${esc(w.code.label)}${w.code.value ? `<b>${esc(w.code.value)}</b>` : ''}</p>${copy}</div>` : '';
  const bold = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const steps = w.steps?.length ? `<ol class="steps">${w.steps.map((s, i) => `<li>${bold(s)}${i ? '' : code}</li>`).join('')}</ol>` : code;
  const talk = d.talk?.(lang);
  // (and a button to each room the guest has, roomsFor)
  const aside = w.aside ? `<div class="aside"><b>${esc(w.aside.title)}</b><ul>${w.aside.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '';
  html(res, status, lang, `<div class="card"><h1>${esc(w.title)}</h1>${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ''}
<div class="intro">${esc(w.text)}</div>${steps}${aside}${w.small ? `<p class="meta small">${esc(w.small)}</p>` : ''}
<p class="acts"><a class="button" href="${url}/go">${esc(w.button)}</a>${talk ? `<a class="button" href="${url}/talk">${esc(talk.button)}</a>` : ''}${roomsFor(g).map(r => `<a class="button soft" href="/guest/${r.path}/">${esc(r.label(lang))}</a>`).join('')}</p></div>
<p class="note">${esc(COPY[lang].footer(names().name))}</p>`);
}

// A door's page, its go and its sign-in, while the door is open and its guest admitted
async function onDoor(req: IncomingMessage, res: ServerResponse, token: string, step: string | undefined, d: Door) {
  const g = guest(d.guest);
  // (a door's go is a plain link: a form whose answer leads to another site would break the page's form-action rule)
  const posts = step === 'send' || step === 'verify';
  if (g?.email && !g.revoked && !d.open && d.shut && (!step || step === 'go') && req.method === 'GET')
    return html(res, 404, langOf(g), `<div class="card"><h1>${esc(d.shut(langOf(g)))}</h1></div>`);
  if (!g?.email || g.revoked || !d.open || step === 'item' || step === 'ask' || step === 'invite' || (req.method === 'POST') !== posts) return gone(res);
  const url = `/guest/${token}`;
  if (!step) return doorPage(req, res, url, d, g);
  if (step === 'go' || step === 'talk') {
    if (!verified(req, g.name)) return verifyPage(res, url, g, {}, 401);
    const to = step === 'go' ? d.go() : d.talk?.(langOf(g))?.go;
    if (!to) return gone(res);
    res.writeHead(302, { location: to, 'cache-control': 'no-store' });
    return res.end();
  }
  const body = await form(req);
  // the door as it is now, past the await, as a request's link: closed, its guest revoked or given a new address ends the step
  const now = doorOf(sha256(token)), ng = now && guest(now.guest);
  if (!now?.open || !ng?.email || ng.revoked || ng.email !== g.email) return gone(res);
  if (!body) return doorPage(req, res, url, now, ng, COPY[langOf(ng)].long, 413);
  return signIn(req, res, step as 'send' | 'verify', url, ng, body);
}

export async function page(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/guest/onward' && req.method === 'GET') return handOnward(req, res);
  const room = roomOf(path);
  if (room) return inRoom(req, res, room, path.slice(`/guest/${room.path}`.length));
  if (path === '/guest/guest.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }); return res.end(SCRIPT); }
  // the look's files (an SVG opened on its own runs no script: the sandbox)
  const own = /^\/guest\/theme\/([^/]+)$/.exec(path)?.[1], found = own && look().files.has(own) ? themeFile(own) : null;
  if (found) {
    res.writeHead(200, { 'content-type': TYPE[own!.split('.').pop()!], 'cache-control': 'no-cache', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    return res.end(readFileSync(found.real));
  }
  // a request's link, or a door's
  const m = /^\/guest\/([A-Za-z0-9_-]{43})(?:\/(send|verify|item|ask|go|talk|invite)|\/picture\/(\d{1,15})\/(\d)|\/file\/(\d{1,9}))?$/.exec(path);
  const at = m && opening(m[1]);
  // a picture of a reply on this request, for its guest's own session
  if (at && m[3] && req.method === 'GET' && verified(req, at.g.name) && sendPicture(res, Number(m[3]), Number(m[4]), at.r.id)) return;
  // an item's file, as a download, for its guest's own session; without it, the code page (and nothing of the file)
  if (at && m[5] && req.method === 'GET') {
    if (!verified(req, at.g.name)) return verifyPage(res, `/guest/${m[1]}`, at.g, {}, 401);
    if (at.r.request && cardFiles.sendItemFile(res, at.r.request, Number(m[5]))) return;
  }
  const d = m && !at && !m[3] && !m[5] ? doorOf(sha256(m[1])) : undefined;
  if (m && d) return onDoor(req, res, m[1], m[2], d);
  if (!at || m[3] || m[5] || m[2] === 'go' || (req.method !== 'POST' && m[2]) || (req.method === 'POST' && !m[2])) return gone(res);
  const url = `/guest/${m[1]}`, step = m[2];
  if (!step) return requestPage(req, res, url, at.r, at.g);
  const body = await form(req);
  // The link as it is now, past the await, with none after it before the step is stored: a person withdrawn, their guest
  // revoked or given a new address while the body arrived ends the step (a withdrawal keeps their sessions, for their other
  // requests; audit NI3).
  const now = opening(m[1]);
  if (!now || now.g.email !== at.g.email) return gone(res);
  const { r, g } = now, t = COPY[langOf(g)];
  if (!body) return requestPage(req, res, url, r, g, t.long, 413);
  if (step === 'send' || step === 'verify') return signIn(req, res, step, url, g, body);
  if (!verified(req, g.name)) return verifyPage(res, url, g, {}, 401);
  if (step === 'invite') return onInvite(req, res, url, m[1], g, body);
  return onItem(req, res, step as 'item' | 'ask', url, r, g, body);
}

// The sign-in, the same for every link of the guest's: a code to the address the board gave (…/send), then the code back
// (…/verify), which starts the guest's session and returns to the link.
async function signIn(req: IncomingMessage, res: ServerResponse, step: 'send' | 'verify', url: string, g: Guest, body: URLSearchParams) {
  const t = COPY[langOf(g)];
  if (step === 'send') {
    if (!mailout.ready(MODE)) return verifyPage(res, url, g, { error: t.noMail }, 503);
    const made = (db.prepare('select count(*) n from guest_codes where guest = ? and created > ?').get(g.name, Date.now() - 3600e3) as { n: number }).n;
    if (made >= CODES_PER_HOUR || !allowed('send', await clientOf(req))) return verifyPage(res, url, g, { error: t.enough }, 429);
    // The guest as they are now, past the last await, with none before the code is stored: an address changed while
    // the body arrived ends this send rather than mail the old one a code (audit NI3).
    const now = guest(g.name);
    if (!now?.email || now.revoked || now.email !== g.email) return gone(res);
    const code = String(randomInt(0, 1e6)).padStart(6, '0'), co = names().name;
    const id = Number(db.prepare('insert into guest_codes (guest, hash, expires, created) values (?, ?, ?, ?)').run(g.name, codeHash(g.name, code), Date.now() + CODE_MS, Date.now()).lastInsertRowid);
    const endOlderCodes = () => db.prepare('update guest_codes set tries = ? where guest = ? and id < ?').run(TRIES, g.name, id);   // one code at a time: the newest
    try {
      const sent = await mailout.send(MODE, { to: now.email, subject: t.subject(co), text: t.email(co, code), replyTo: mailout.hello(),
        about: "a guest's sign-in code" });
      endOlderCodes();
      return verifyPage(res, url, g, { code: true, test: sent.test });
    } catch (e) {
      // A code that surely didn't go is no code: it doesn't count toward the hour's three, and the one before it still
      // opens the page. A 504 may have gone, so its code stays and counts. (mailout keeps the service's answer.)
      if (e instanceof mailout.MailError && e.status === 504) {
        endOlderCodes();
      } else {
        db.prepare('delete from guest_codes where id = ?').run(id);
      }
      // (the address itself refused, by our check or the service's: only the board can give the right one)
      if (e instanceof mailout.MailError && e.scope === 'recipient') return verifyPage(res, url, g, { error: t.badAddress }, 422);
      return verifyPage(res, url, g, { error: t.mailFailed }, 502);
    }
  }
  if (!allowed('verify', await clientOf(req))) return verifyPage(res, url, g, { code: true, error: t.tooMany }, 429);
  const c = db.prepare('select * from guest_codes where guest = ? and tries < ? and expires > ? order by id desc limit 1').get(g.name, TRIES, Date.now()) as { id: number; hash: string; tries: number } | undefined;
  if (!c) return verifyPage(res, url, g, { error: t.expired }, 400);
  const given = String(body.get('code') ?? '').trim();
  if (/^\d{6}$/.test(given) && timingSafeEqual(Buffer.from(codeHash(g.name, given)), Buffer.from(c.hash))) {
    db.prepare('update guest_codes set tries = ? where guest = ?').run(TRIES, g.name);
    res.writeHead(303, { location: url, 'cache-control': 'no-store', ...startSession(g.name) });
    return res.end();
  }
  db.prepare('update guest_codes set tries = tries + 1 where id = ?').run(c.id);
  const left = TRIES - c.tries - 1;
  return verifyPage(res, url, g, { code: left > 0, error: left > 0 ? t.wrong(left) : t.usedUp }, 400);
}

// item, ask: the verified guest's own steps on an open request, one item at a time, marked as theirs (person)
function onItem(req: IncomingMessage, res: ServerResponse, step: 'item' | 'ask', url: string, r: Request, g: Guest, body: URLSearchParams) {
  const t = COPY[langOf(g)], i = items(r.id).find(x => x.n === Number(body.get('n')));
  if (r.status !== 'open') return requestPage(req, res, url, r, g, undefined, 409);
  if (!i) return requestPage(req, res, url, r, g, undefined, 400);
  const steps = (db.prepare("select count(*) n from guest_messages where item = ? and who = 'guest' and ts > ?").get(r.id, hourAgo()) as { n: number }).n
    + (db.prepare('select count(*) n from guest_items where request = ? and updated > ?').get(r.id, hourAgo()) as { n: number }).n;
  if (steps >= STEPS_PER_HOUR) return requestPage(req, res, url, r, g, t.busy, 429);
  const after = () => { res.writeHead(303, { location: `${url}#i${i.n}`, 'cache-control': 'no-store' }); res.end(); };

  if (step === 'ask') {
    const text = String(body.get('text') ?? '').replace(/\r\n/g, '\n').trim();
    if (!text || text.length > MAX_TEXT) return requestPage(req, res, url, r, g, t.long, 400);
    db.prepare("insert into guest_messages (item, point, who, person, text, ts) values (?, ?, 'guest', ?, ?, ?)").run(r.id, i.n, g.name, text, new Date().toISOString());
    hand(r, i, g.name, { event: 'question', question: text });
    return after();
  }
  const action = String(body.get('action') ?? ''), answer = i.kind === 'question' ? asking.answer(asked(i), body.get('answer')) : null;
  let next: string | null;
  if (i.kind === 'question' && body.has('answer')) {
    if (!answer) return requestPage(req, res, url, r, g, i.type === 'number' ? t.number : t.long, 400);
    next = 'answered';
  } else if (action === 'undo' && i.state && i.kind !== 'question') next = null;
  else if ((i.kind === 'document' || i.kind === 'task') && (action === 'done' || (action === 'na' && i.optional))) next = action;
  else return requestPage(req, res, url, r, g, undefined, 400);
  // a tick on an item already ticked (another person's stale page) leaves it as it is, theirs, and tells the agent nothing
  if (next && next !== 'answered' && i.state) return after();
  db.prepare('update guest_items set state = ?, answer = ?, person = ?, updated = ? where request = ? and n = ?')
    .run(next, next === 'answered' ? answer : null, next ? g.name : null, new Date().toISOString(), r.id, i.n);
  hand(r, i, g.name, { event: next === 'answered' ? 'answered' : next === 'na' ? 'not applicable' : next === 'done' ? (i.kind === 'document' ? 'mailed' : 'done') : 'undone',
    ...(next === 'answered' ? { answer: asking.said(asked(i), answer) } : {}) });
  return after();
}

// invite: a colleague at the domain the board allows, invited by the verified guest themselves: on the request at once,
// their link opening from the start, and sent to them by email in the inviting guest's language. Nothing of their
// address goes in the log.
async function onInvite(req: IncomingMessage, res: ServerResponse, url: string, token: string, g: Guest, body: URLSearchParams) {
  const w = COPY[langOf(g)].invite, client = await clientOf(req);
  // the link, the guest and the switch as they are now, past the last await before the invite is stored
  const now = opening(token);
  if (!now || now.g.email !== g.email) return gone(res);
  const { r } = now, name = String(body.get('name') ?? '').trim(), typed = String(body.get('email') ?? '').trim();
  // the reason goes in the invite while the page shows one, else atop the page
  const refuse = (error: string, status: number) => requestPage(req, res, url, r, g, invitesLeft(r, g) === null ? error : undefined, status, { error, name, email: typed });
  const left = invitesLeft(r, g);
  if (!left) return refuse(left === 0 ? w.none : w.refused, 403);
  if (!allowed('invite', client)) return refuse(COPY[langOf(g)].busy, 429);
  const address = mailout.address(typed);
  if (!NAME.test(name)) return refuse(w.badName, 400);
  if (!address || domainOf(address) !== r.colleagues) return refuse(w.domain(r.colleagues!), 400);
  if (!mailout.ready(MODE)) return refuse(COPY[langOf(g)].noMail, 503);
  // someone on it already, by name or address; one the board removed is the board's to bring back
  const had = people(r.id).find(p => sameName(p.guest, name) || p.email?.toLowerCase() === address.toLowerCase());
  if (had) return refuse(active(had) ? w.already(had.guest) : w.refused, 409);
  // a guest's invite adds a new guest or one already at exactly this address; setting or moving an address is the board's,
  // and the refusal is the same either way, so the page never tells which names are known guests
  const named = guest(name);
  if (named && named.email?.toLowerCase() !== address.toLowerCase()) return refuse(w.refused, 409);
  const known = invite(name, address);
  if (Array.isArray(known)) return refuse(w.refused, 409);
  db.prepare('update guests set lang = coalesce(lang, ?) where name = ?').run(langOf(g), known.name);
  enrol(r.id, known.name);
  db.prepare('update guest_people set released = ?, invited_by = ? where request = ? and guest = ?').run(new Date().toISOString(), g.name, r.id, known.name);
  const p = people(r.id).find(x => sameName(x.guest, known.name))!, co = names().name;
  try {
    const sent = await mailout.send(MODE, { to: address, subject: w.subject(g.name, r.title), text: w.email(g.name, co, r.title, linkOf(p)), replyTo: mailout.hello(),
      about: "a guest's invite to a colleague" });
    publish({ type: 'log', agent: r.agent, text: `${g.name} invited ${known.name} to guest request #${r.id} from its page.` });
    return requestPage(req, res, url, r, g, undefined, 200, { sent: known.name, test: sent.test });
  } catch (e) {
    // one that may have gone stays on the request, as a code does, and the page says so (its link can go again from the
    // card's Send link); one that surely didn't leaves nobody on it
    if (e instanceof mailout.MailError && e.status === 504) { const unsure = w.unsure(known.name); return requestPage(req, res, url, r, g, invitesLeft(r, g) === null ? unsure : undefined, 504, { error: unsure }); }
    db.prepare('delete from guest_people where request = ? and guest = ? and invited_by = ?').run(r.id, known.name, g.name);
    return refuse(e instanceof mailout.MailError && e.scope === 'recipient' ? w.bounced : w.failed, 502);
  }
}

// A guest's step goes to the request's agent: their running job, or a job of its own (messages.ts, which frames it as
// outside data). What it says is structured, the guest's words in their own field; from: whichever of the request's
// people took it. The card shows it too (card()); that's the board's quiet update, a line in the feed, no alert.
function hand(r: Request, i: Item, from: string, what: { event: string; answer?: string; question?: string }) {
  const p = progress(items(r.id)), mail = i.kind === 'document' ? documents() : null;
  const data = { from, request: r.id, request_title: r.title, item: i.n, item_title: i.title, kind: i.kind, ...what,
    progress: `${p.done} of ${p.total} done`, ...(mail && what.event === 'mailed' ? { mailed_to: mail } : {}), answer_with: `hq guest reply ${r.id} ${i.n} <file>` };
  const m = messages.fromGuest(r.agent, r.id, r.job, `${from} on: ${r.title}`.slice(0, 140), JSON.stringify(data));
  publish({ type: 'log', agent: r.agent, text: `${from} on the guest page (request #${r.id}, item ${i.n}: ${what.event}): ${m.state === 'queued' ? `queued for job #${m.job}` : `job #${m.job}`}.` });
}
