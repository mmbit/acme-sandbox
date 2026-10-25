// The identity gate: level 1 by order number and email (the app compares),
// level 2 by a 6-digit code to that order's email or a signed link from our own emails. Rate limits and a fixed minimum
// time keep it from telling anyone which orders or emails exist.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { db, now, keyed, token, linkKey } from './db.ts';
import * as apps from './apps.ts';
import type { View } from './apps.ts';
import { withOrders } from './config.ts';
import { base } from './company.ts';
import * as session from './session.ts';
import type { Session } from './session.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const FLOOR_MS = 600;            // every match answers after at least this, so the app's own timing doesn't show
const SLOW_MAX_MS = 10_000;      // the most a much-tried order number slows down to (never a lockout)
const CODE_MS = 10 * MINUTE_MS;
const CODE_TRIES = 5;
const LINK_MAX_DAYS = 7;         // the nonces table keeps a used nonce 8 days (db.ts sweep): a link must expire before that

// ---- what each level may see of an order
// ship_by:
// number: the number the customer was told; quantity: how many of it
const LEVEL1 = ['id', 'ref', 'number', 'placed_at', 'ship_by', 'title', 'quantity', 'status', 'shipped_at', 'delivered_at', 'carrier', 'tracking_url', 'country'] as const;
const LEVEL2 = [...LEVEL1, 'total_cents', 'address_masked'] as const;

// The order view a level may see: nothing at 0; no price and no address at 1 (a gift recipient may know the buyer's
// email); everything the app sent at 2. Only the contract's fields pass, whatever else an app adds.
export function viewFor(level: 0 | 1 | 2, view: View): Partial<View> | null {
  if (level === 0) return null;
  const keys: readonly string[] = level === 2 ? LEVEL2 : LEVEL1;
  return Object.fromEntries(keys.map(k => [k, (view as any)[k] ?? null]));
}

// ---- rate limits: one row per counted event in `hits` (db.ts), keyed by a hash
const count = (key: string, windowMs: number, t = now()) =>
  (db.prepare('select count(*) as n from hits where key = ? and at > ?').get(keyed(key), t - windowMs) as any).n as number;
const hit = (key: string, t = now()) =>
  Number((db.prepare('insert into hits (key, at) values (?, ?) returning rowid as r').get(keyed(key), t) as any).r);
const unhit = (rows: number[]) => { for (const r of rows) db.prepare('delete from hits where rowid = ?').run(r); };

// All of the limits pass, then all are counted: one refused limit doesn't use up the others. Synchronous on purpose:
// Node runs it in one go, so parallel requests can't all pass the check before any of them is counted.
function within(limits: [key: string, max: number, windowMs: number][]) {
  const t = now();
  if (limits.some(([k, max, w]) => count(k, w, t) >= max)) return false;
  for (const [k] of limits) hit(k, t);
  return true;
}

// until ms have passed since start: a timer keeps the event loop's whole-millisecond clock, so it can end a little
// early, and the rest is waited again
async function waitPast(start: number, ms: number) {
  const left = () => ms - (performance.now() - start);
  while (left() > 0) await new Promise(r => setTimeout(r, left()));
}
const normEmail = (s: string) => String(s ?? '').trim().toLowerCase();

// ---- level 1: order number and email

// 'held': no check was made, a grant is held for another page (session.ts heldElsewhere()). A match's views carry their
// app
export type Shown = Partial<View> & { app: string };
export type Match = { ok: true; views: Shown[]; session: Session } | { ok: false; why: 'no-match' | 'limited' | 'held' };

// Asks every app of the session's shop whether this order has this email (the order number alone doesn't say which app
// it's from; each app answers for its own orders, as before). Wrong number, wrong email and a broken app all give the
// same answer after the same minimum time. Failed matches are limited per IP (10 an hour) and slow down per order number
// in the shop (5 an hour, then longer each time), so the real owner typing it right still gets in. An app may read an
// order number with other separators or case, so the slowdown counts the number as sent to the apps, by the letters and
// digits of its first 60 characters: spellings of one order share a count.
// `page`: the page a grant is held for, when it rises outside that page's own request (the model's tool; session.ts held())
export async function matchOrder(s: Session, ip: string, order: string, email: string, page?: string): Promise<Match> {
  if (session.heldElsewhere(session.current(s), page)) return { ok: false, why: 'held' };
  const start = performance.now();
  const o = String(order ?? '').trim().toUpperCase(), e = normEmail(email);
  const spelling = o.slice(0, 60).toLowerCase().replace(/[^a-z0-9]/g, '');
  const ipKey = `match-ip:${ip}`, orderKey = `match-order:${s.shop}:${spelling}`;
  const t = now();
  const fails = count(orderKey, HOUR_MS, t);
  const floor = fails < 5 ? FLOOR_MS : Math.min(FLOOR_MS * 2 ** (fails - 4), SLOW_MAX_MS);
  if (count(ipKey, HOUR_MS, t) >= 10) { await waitPast(start, floor); return { ok: false, why: 'limited' }; }
  // counted as failed before asking (so parallel tries can't all slip through), and uncounted once it grants
  const rows = [hit(ipKey, t), hit(orderKey, t)];
  const found = o && e.includes('@') ? (await Promise.all(withOrders(s.shop).map(async app => ({ app, m: await apps.match(app, o, e) }))))
    .flatMap(x => x.m.match ? x.m.orders.map(view => ({ app: x.app, view })) : []) : [];
  let out: Match = { ok: false, why: 'no-match' };
  if (found.length) {
    // (the number with each grant)
    const granted = session.grantOrder(s, found.map(f => ({ app: f.app, id: f.view.id, ...(f.view.number ? { number: f.view.number } : {}) })), e, page);
    if (granted) {
      unhit(rows); // only once granted: a hold that appeared while the apps answered leaves the try counted
      const lvl = session.level(granted) === 2 && granted.email === e ? 2 : 1;
      out = { ok: true, views: found.map(f => ({ ...viewFor(lvl, f.view)!, app: f.app })), session: granted };
    } else if (session.heldElsewhere(session.current(s), page)) out = { ok: false, why: 'held' }; // held while the apps answered
  }
  await waitPast(start, floor);
  return out;
}

// ---- an order the session may see: what the order tools (and a company's own) look at, by the order's id and, when two
// apps of the shop have that id, its app. Level 2 asks the shop's apps for the checked email's orders; level 1 asks the
// order's own app again, under the email it matched with. Not found: 'none', none the session may see; 'several', two
// apps have it and no app was named; 'unanswered', an app it may be in didn't answer, so a hit in the others may not be
// the one meant.
export type Found = { app: string; view: View; level: 1 | 2; email: string };
export type Lookup = ({ ok: true } & Found) | { ok: false; why: 'none' | 'several' | 'unanswered' };
export async function find(s: Session, id: string, app?: string): Promise<Lookup> {
  const want = String(id ?? '').toUpperCase(), lvl = session.level(s);
  const fits = (a: string) => !app || a === app || base(a) === base(app);
  if (lvl === 2) {
    const { orders, unanswered } = await apps.ordersIn(withOrders(s.shop).filter(fits), s.email!);
    const hits = orders.filter(o => o.view.id.toUpperCase() === want);
    if (hits.length > 1) return { ok: false, why: 'several' };
    if (unanswered.length) return { ok: false, why: 'unanswered' };
    return hits.length ? { ok: true, ...hits[0], level: 2, email: s.email! } : { ok: false, why: 'none' };
  }
  if (lvl !== 1) return { ok: false, why: 'none' };
  const held = s.orders.filter(o => o.id.toUpperCase() === want && fits(o.app));
  if (held.length !== 1) return { ok: false, why: held.length ? 'several' : 'none' };
  const m = await apps.match(held[0].app, held[0].id, s.orderEmail!);
  const view = m.match ? m.orders.find(v => v.id.toUpperCase() === want) : undefined;
  return view ? { ok: true, app: held[0].app, view, level: 1, email: s.orderEmail! } : { ok: false, why: 'none' };
}

// ---- level 2: the code

const codeHash = (email: string, code: string, created: number) =>
  createHmac('sha256', linkKey).update(`code:${email}:${created}:${code}`).digest();

// A new code for the email this session matched an order with, and only then (nobody can use us to fill
// someone's inbox). At most 3 per email an hour and 10 a day, and 10 an hour per IP. The caller emails it.
const codeLimits = (to: string, ip: string): [string, number, number][] => [[`code-email-hour:${to}`, 3, HOUR_MS], [`code-email-day:${to}`, 10, DAY_MS], [`code-ip:${ip}`, 10, HOUR_MS]];
// With no order matched since, at level 2 to the email already checked: a company's tool may need a check from the last 24 hours
// (session.fresh()), and the level-2 grant dropped the order grants it covered, so a new code for that same inbox is how
// the check is renewed. An order matched under another email (a shared tablet) still sends that email's code.
const codeTo = (c: Session | null) => !c ? null : c.orderEmail && c.orders.length ? c.orderEmail : session.level(c) === 2 && c.email ? c.email : null;
export function sendCode(s: Session, ip: string): { ok: true; to: string; code: string; id: number } | { ok: false; why: 'no-match' | 'limited' } {
  const c = session.current(s), to = codeTo(c);
  if (!c || !to) return { ok: false, why: 'no-match' };
  if (!within(codeLimits(to, ip))) return { ok: false, why: 'limited' };
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0'), t = now();
  const id = Number(db.prepare('insert into codes (session, email, hash, created) values (?, ?, ?, ?)')
    .run(c.id, to, codeHash(to, code, t).toString('hex'), t).lastInsertRowid);
  return { ok: true, to, code, id };
}
// A code whose email never went: gone, so the one before it (already in their inbox) is the latest again.
export const dropCode = (id: number) => { db.prepare('delete from codes where id = ? and used is null').run(id); };
// Whether sendCode would send one now, and where to; changes nothing. The model's send_code asks this while it drafts:
// the code is made and counted only when the answer is delivered, so a draft that's dropped leaves no trace.
export function canSendCode(s: Session, ip: string): { ok: true; to: string } | { ok: false; why: 'no-match' | 'limited' } {
  const to = codeTo(session.current(s));
  if (!to) return { ok: false, why: 'no-match' };
  const t = now();
  return codeLimits(to, ip).some(([k, max, w]) => count(k, w, t) >= max) ? { ok: false, why: 'limited' } : { ok: true, to };
}

// Only this session's latest code counts, for 10 minutes and 5 tries; then it's spent and the customer asks again.
// 'held': no check was made (the try isn't spent), a grant is held for another page (session.ts heldElsewhere()).
export function checkCode(s: Session, code: string, page?: string): { ok: true; session: Session } | { ok: false; why: 'none' | 'wrong' | 'spent' | 'held' } {
  const c = session.current(s);
  if (!c) return { ok: false, why: 'none' };
  if (session.heldElsewhere(c, page)) return { ok: false, why: 'held' };
  const row = db.prepare('select * from codes where session = ? order by id desc limit 1').get(c.id) as any;
  if (!row) return { ok: false, why: 'none' };
  // the try is counted before the compare, in one statement, so parallel guesses can't share a try
  const tried = db.prepare('update codes set tries = tries + 1 where id = ? and used is null and tries < ? and created > ? returning tries')
    .get(row.id, CODE_TRIES, now() - CODE_MS) as any;
  if (!tried) return { ok: false, why: 'spent' };
  const typed = String(code ?? '').replace(/\D/g, '');
  const ok = typed.length === 6 && timingSafeEqual(codeHash(row.email, typed, row.created), Buffer.from(row.hash, 'hex'));
  if (!ok) {
    if (tried.tries >= CODE_TRIES) db.prepare('update codes set used = ? where id = ?').run(now(), row.id);
    return { ok: false, why: tried.tries >= CODE_TRIES ? 'spent' : 'wrong' };
  }
  if (!db.prepare('update codes set used = ? where id = ? and used is null').run(now(), row.id).changes) return { ok: false, why: 'spent' };
  const granted = session.grantEmail(c, row.email, page);
  return granted ? { ok: true, session: granted } : { ok: false, why: 'none' };
}

// ---- level 2: the signed link in our own emails ("Questions? Chat with us")
// The token is <payload>.<mac>: the payload is base64url JSON { a: shop, e: email, x: expiry (ms), n: nonce }, the mac an
// HMAC-SHA256 over it under the care-only link key. It goes in the URL fragment and the widget POSTs it (mail
// scanners open GET links and would use it up).

const linkMac = (payload: string) => createHmac('sha256', linkKey).update(`link:${payload}`).digest();

export function makeLink(shop: string, email: string, days = LINK_MAX_DAYS): string {
  const x = now() + Math.min(days, LINK_MAX_DAYS) * DAY_MS;
  const payload = Buffer.from(JSON.stringify({ a: shop, e: normEmail(email), x, n: token(16) })).toString('base64url');
  return `${payload}.${linkMac(payload).toString('base64url')}`;
}

// Single use, in its own shop only (the @preview twin is another shop), before it expires, unaltered. A link names the
// shop its email came from (`a`: a shop of one is its app)
export function redeemLink(s: Session, shop: string, tok: string): { ok: true; session: Session } | { ok: false; why: 'invalid' | 'expired' | 'used' } {
  const [payload, mac, extra] = String(tok ?? '').split('.');
  if (!payload || !mac || extra !== undefined) return { ok: false, why: 'invalid' };
  const want = linkMac(payload), got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, why: 'invalid' };
  let p: any;
  try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, why: 'invalid' }; }
  if (p?.a !== shop || p?.a !== s.shop || typeof p.e !== 'string' || typeof p.n !== 'string' || typeof p.x !== 'number') return { ok: false, why: 'invalid' };
  const t = now();
  if (p.x <= t || p.x > t + LINK_MAX_DAYS * DAY_MS) return { ok: false, why: 'expired' };
  if (!db.prepare('insert into nonces (nonce, used) values (?, ?) on conflict do nothing').run(p.n, t).changes) return { ok: false, why: 'used' };
  const granted = session.grantEmail(s, p.e);
  return granted ? { ok: true, session: granted } : { ok: false, why: 'invalid' };
}
