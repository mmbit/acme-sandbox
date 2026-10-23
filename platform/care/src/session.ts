// A device's session: its cookie (CARE_COOKIE, `__Host-care` unless the company names it), the sessions table (keyed by the cookie's hash) and the grants it holds.
// Grants are written only here, and by gate.ts through these functions (the model can't raise what a session may see).
// Each time a grant rises the session gets a new id (no session fixation).
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { db, now, hash } from './db.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SESSION_MS = 30 * DAY_MS;        // the cookie and the session slide for 30 days
const HOLD_MS = 60_000;                // a grant held for one page: the widget asks for the new id at once
const EMAIL_IDLE_MS = DAY_MS;          // the email grant lapses after 24 h without use...
const EMAIL_MAX_MS = 7 * DAY_MS;       // ...and after 7 days whatever happens: shared family tablets are the real risk
const FRESH_MS = DAY_MS;               // a company's tools that move money or goods need a check from the last 24 h (sessions.fresh)

// An order a check granted: its app and the app's own id (ids are only unique within one app) (a session is a shop's),
// and the number its customer was told for it (View's `number`), when it has one
export type Grant = { app: string; id: string; number?: string };
export type Session = {
  id: string;                  // the cookie's hash: the raw cookie is never stored
  shop: string;                // X-Care-Shop: every stall on one origin (config.ts SHOPS); 'x' and 'x@preview' are two shops
  conversation: number | null;
  orders: Grant[];             // level 1: orders matched by number and email, all under orderEmail, each with its app
  orderEmail: string | null;   // the email those orders matched with: the only address a code may go to
  email: string | null;        // level 2: the email checked by a code or a signed link
  emailAt: number | null;      // when it was checked (the 7-day limit, and fresh())
  emailSeen: number | null;    // last use while at level 2 (the 24-hour idle limit)
  rotate?: boolean;            // a grant rose outside an HTTP response: the next POST gives the session a new id
  tab?: string;                // ...and only a POST from this page may (held()): pageOf() its x-care-tab
};

// ---- the cookie
// The __Host- prefix: the browser takes it only with Secure, Path=/ and no Domain, so only the app's own host (or its
// shelf's origin, www), over https, can set it. A plain name could be planted from
// any other host under the company's domain (another app, a preview, HQ: one XSS anywhere) with Domain=<that domain>
// and a longer path, sent first. Path=/ sends it to the app's own
// routes too: Caddy strips it from every request that goes to a product (infra/products.py, CARE_COOKIES).
// Secure even on a LOCAL run: browsers treat http://localhost as secure, and one less switch is one less way to ship it off.
// the company's name for it (infra/products.py: the last of company/infra.env's CARE_COOKIES): always __Host- (above), or no start
const NAME = process.env.CARE_COOKIE || '__Host-care';
if (!/^__Host-[A-Za-z0-9_-]+$/.test(NAME)) throw new Error(`CARE_COOKIE ${JSON.stringify(NAME)} must be a plain name starting with __Host- (only the app's own host can set one)`);
const FLAGS = 'Secure; HttpOnly; SameSite=Lax; Path=/';
const cookieOf = (raw: string) => `${NAME}=${raw}; ${FLAGS}; Max-Age=${SESSION_MS / 1000}`;
const RAW = /^[A-Za-z0-9_-]{43}$/;     // 32 random bytes, base64url

// Every value of our cookie the request carries: script on the app's own host could still set a second one, so we look
// at each and take the first that is a live session of this shop (rotation makes a planted one useless).
function raws(req: IncomingMessage) {
  const out: string[] = [];
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== NAME) continue;
    const v = part.slice(i + 1).trim();
    if (RAW.test(v)) out.push(v);
  }
  return out;
}

// ---- storage
// orders: a bare id is an order of the session's own shop, a shop of one
const row2session = (r: any): Session => ({
  id: r.id, shop: r.shop, conversation: r.conversation ?? null,
  orders: (JSON.parse(r.orders) as (string | Grant)[]).map(o => typeof o === 'string' ? { app: r.shop, id: o } : o),
  orderEmail: r.order_email ?? null, email: r.email ?? null, emailAt: r.email_at ?? null, emailSeen: r.email_seen ?? null,
  ...(r.rotate ? { rotate: true } : {}), ...(r.rotate_tab ? { tab: r.rotate_tab } : {}),
});

function save(s: Session) {
  db.prepare(`update sessions set conversation = ?, orders = ?, order_email = ?, email = ?, email_at = ?, email_seen = ?,
    rotate = ? where id = ?`).run(s.conversation, JSON.stringify(s.orders), s.orderEmail, s.email, s.emailAt,
    s.emailSeen, s.rotate ? 1 : 0, s.id);
  return s;
}

// ---- the API

// The session the request's cookie names, for this shop only; null if there's none, it's unknown, expired or another shop's.
export function open(req: IncomingMessage, shop: string): Session | null {
  const t = now();
  for (const raw of raws(req)) {
    const r = db.prepare('select * from sessions where id = ? and shop = ? and seen > ?').get(hash(raw), shop, t - SESSION_MS);
    if (!r) continue;
    const s = row2session(r);
    if (s.tab && t - (r as any).rotate_at > HOLD_MS) { forget(s); continue; } // the page it was held for never came back
    if (s.email && level(s, t) < 2) lapse(s);
    return s;
  }
  return null;
}

// The email grant has run out: clear it, and leave the email's thread, so a device below level 2 never shows it
// (the thread holds other devices' messages and earlier conversations, which are level-2 data).
function lapse(s: Session) {
  s.email = s.emailAt = s.emailSeen = null;
  if (s.conversation != null) {
    const c = db.prepare('select email from conversations where id = ?').get(s.conversation) as any;
    if (c?.email) s.conversation = null;
  }
  save(s);
}

export function create(shop: string): { session: Session; cookie: string } {
  const raw = randomBytes(32).toString('base64url'), t = now();
  const id = hash(raw);
  db.prepare('insert into sessions (id, shop, created, seen) values (?, ?, ?, ?)').run(id, shop, t, t);
  const session: Session = { id, shop, conversation: null, orders: [], orderEmail: null, email: null, emailAt: null, emailSeen: null };
  return { session, cookie: cookieOf(raw) };
}

// A page, as the server keeps it: the hash of its x-care-tab (a random id in the page's memory, never in a cookie);
// null for a request without one.
export const pageOf = (tab: string) => tab ? hash(`tab:${tab}`) : null;

// A grant the model's tool raised has no response of the device's own to carry the new id, and every holder of the old
// cookie (perhaps a planted one) could ask for it. So it's held for the page that typed the proof (helper.ts typedOn()):
// only a POST from that page takes it, within a minute; else the session ends (open()).
// One page at a time: a grant held for one page is never rebound to another (heldElsewhere()). The session carries every
// grant, so a second check in the same model run, typed on another page (a valid proof of its own order), would hand that
// page the first page's grant too. The second check is refused instead: the grant functions return null.
function held(s: Session, page?: string) {
  if (page === undefined) return s;
  s.tab = page;
  db.prepare('update sessions set rotate_tab = ?, rotate_at = ? where id = ?').run(s.tab, now(), s.id);
  return s;
}
// whether a request from this page may use the session now (false: a grant is held for another page)
export const mayUse = (s: Session, tab: string) => !s.tab || s.tab === pageOf(tab);
// whether a grant is held for a page other than `page` (a page the model's tool would hold a new grant for); a grant
// raised in a request (page undefined) never meets one: that request came from the held page and rotated first (mayUse)
export const heldElsewhere = (s: Session | null, page?: string) => page !== undefined && !!s?.tab && s.tab !== page;

// The same cookie again with a fresh Max-Age (the 30 days slide); null if the request doesn't carry this session's cookie.
export function refresh(req: IncomingMessage, s: Session): string | null {
  const raw = raws(req).find(r => hash(r) === s.id);
  return raw ? cookieOf(raw) : null;
}

// 2 only while the email grant lives (24 h idle, 7 days at most); 1 with a matched order; else 0.
export function level(s: Session, t = now()): 0 | 1 | 2 {
  if (s.email && s.emailAt != null && s.emailSeen != null && t - s.emailAt < EMAIL_MAX_MS && t - s.emailSeen < EMAIL_IDLE_MS) return 2;
  return s.orders.length ? 1 : 0;
}

// The email was checked in the last 24 hours: what a refund or a new one needs.
export const fresh = (s: Session, t = now()) => level(s, t) === 2 && t - s.emailAt! < FRESH_MS;

// Whether the session holds this order of this app at level 1
export const holds = (s: Session, app: string, id: string) => s.orders.some(o => o.app === app && o.id === id);

// Level 1: more orders, each matched by its own app with this email (one order number can match in two apps of a shop: each
// is a proof of its own). A match under another email starts the list again, so the order grants are always one email's
// (the one a code may then go to). Applied to the session as it is now (it may have rotated since `s` was read); null if
// it's gone.
// `page`, from the model's tools: the grant is held for that page (pageOf()) in the same step (held()); null, and nothing
// saved, while a grant is held for another page.
// Orders the session already holds (or that its email grant covers) change nothing: no new id, and nothing held. The
// model may check one again from a later page (a reload is a new x-care-tab) with values typed on the first one, which is
// gone: holding for it would end the session a minute later.
export function grantOrder(s: Session, orders: Grant[], email: string, page?: string): Session | null {
  const c = current(s);
  if (!c || heldElsewhere(c, page)) return null;
  const had = c.orderEmail === email ? c.orders : [];
  const more = orders.filter((o, i) => !had.some(h => h.app === o.app && h.id === o.id) && orders.findIndex(x => x.app === o.app && x.id === o.id) === i);
  if (c.orderEmail === email ? !more.length : !c.orderEmail && level(c) === 2 && c.email === email) return c;
  return held(save({ ...c, orders: [...had, ...more], orderEmail: email, rotate: true }), page);
}

// Level 2: the email is checked. Order grants under the same email are covered by it and dropped, so when the email
// grant lapses the device is back at level 0 rather than keeping that email's orders. null if the session is gone, or a
// grant is held for another page than `page`.
export function grantEmail(s: Session, email: string, page?: string): Session | null {
  const c = current(s), t = now();
  if (!c || heldElsewhere(c, page)) return null;
  const same = c.orderEmail === email;
  return held(save({ ...c, email, emailAt: t, emailSeen: t, orders: same ? [] : c.orders, orderEmail: same ? null : c.orderEmail, rotate: true }), page);
}

// ---- rotation
// Where each rotated id went, for the server's own code only (the engine holds a Session across a model call while the
// next POST rotates it). The cookie lookup in open() never follows it: the old cookie is dead at once. In memory on
// purpose: a restart drops the engine's Session objects too. Kept an hour, far longer than a model call.
const moved = new Map<string, { to: string; at: number }>();

// The session `s` was read from, as it is now: followed through rotations, re-read from the table; null if it's gone.
export function current(s: Session): Session | null {
  let id = s.id;
  for (let m = moved.get(id); m; m = moved.get(id)) id = m.to;
  const r = db.prepare('select * from sessions where id = ? and shop = ?').get(id, s.shop);
  return r ? row2session(r) : null;
}

// Whether a session id is still in use (not rotated away, not forgotten).
export const alive = (id: string) => !!db.prepare('select 1 from sessions where id = ?').get(id);
// What a stream opened with this id may hear of the conversation, checked before each message:
// - 'all' while the session is in it under this id;
// - 'renew' only, while a grant that rose outside a request (a check the model ran) waits for the next POST to give the
//   session a new id: a stream opened with the old cookie, perhaps a planted one, mustn't hear what the grant shows (the
//   thread's earlier conversations, an order); the widget's hello after the renew brings it all back;
// - 'none' once the id rotated away or was forgotten, or the device left the conversation (a code for another email on
//   a shared tablet, engine join()), or its email grant ran out while the stream was open: a tab left on a shared tablet
//   makes no request, so open() never lapses it, and the thread is level-2 data (it leaves the thread here instead).
export function hearing(id: string, conversation: number): 'all' | 'renew' | 'none' {
  const r = db.prepare('select * from sessions where id = ? and conversation = ?').get(id, conversation) as any;
  if (!r) return 'none';
  const s = row2session(r);
  if (level(s) < 2 && db.prepare('select 1 from conversations where id = ? and email is not null').get(conversation)) { lapse(s); return 'none'; }
  return s.rotate ? 'renew' : 'all';
}

// A new id for the same session; the old one is dead at once. What's keyed by the session id moves with it: a code
// asked for before the rotation is checked in the POST that rotates, and a proposed action stays tappable.
// null if another request rotated it first (two requests in flight with the old cookie).
export function rotate(s: Session): { session: Session; cookie: string } | null {
  const raw = randomBytes(32).toString('base64url');
  const id = hash(raw);
  db.exec('begin immediate');
  try {
    const { changes } = db.prepare('update sessions set id = ?, rotate = 0, rotate_tab = null, rotate_at = null where id = ?').run(id, s.id);
    if (!changes) { db.exec('rollback'); return null; }
    for (const table of ['codes', 'actions', 'ledger']) db.prepare(`update ${table} set session = ? where session = ?`).run(id, s.id);
    db.exec('commit');
  } catch (err) { db.exec('rollback'); throw err; }
  const t = now();
  for (const [k, m] of moved) if (t - m.at > HOUR_MS) moved.delete(k);
  moved.set(s.id, { to: id, at: t });
  const { rotate: _, tab: __, ...rest } = s;
  return { session: { ...rest, id }, cookie: cookieOf(raw) };
}

// The device is in use: the session slides, and so does a live email grant (never a lapsed one).
export function touch(s: Session) {
  const c = current(s), t = now();
  if (!c) return;
  if (level(c, t) === 2) s.emailSeen = c.emailSeen = t;
  db.prepare('update sessions set seen = ?, email_seen = ? where id = ?').run(t, c.emailSeen, c.id);
}

export function attach(s: Session, conversation: number) {
  s.conversation = conversation;
  const c = current(s);
  if (c) db.prepare('update sessions set conversation = ? where id = ?').run(conversation, c.id);
}

// The device last seen in a conversation, for the engine when no request brought one (after a restart); null if none is.
export function of(conversation: number, shop: string): Session | null {
  const r = db.prepare('select * from sessions where conversation = ? and shop = ? order by seen desc limit 1').get(conversation, shop);
  return r ? row2session(r) : null;
}

// "Forget this device": the session, its codes and its untapped actions go; the conversation is the engine's to keep or drop.
export function forget(s: Session): string {
  s = current(s) ?? s;
  db.prepare('delete from codes where session = ?').run(s.id);
  db.prepare('delete from actions where session = ? and used is null').run(s.id);
  db.prepare('delete from sessions where id = ?').run(s.id);
  return `${NAME}=; ${FLAGS}; Max-Age=0`;
}
