// The client for each app's order endpoint (/api/care/*, the contract in platform/care/README.md), called through the
// app's public address (its host, or its shelf at www.<zone>/<slug>/) with its CARE_TOKEN. A broken or unconfigured app
// is "no match": logged as a status line (unless it is only briefly away, see AWAY_MS), never thrown into the conversation.
import { APPS, TOKENS } from './config.ts';

const TIMEOUT_MS = 5000;
// An app away for a moment: no answer in TIMEOUT_MS, no connection, or its gateway's 502, 503 or 504. A deploy restarts
// it, and Caddy holds a call for up to 30 s meanwhile (infra/Caddyfile), longer than a chat waits here. The caller takes
// it as no answer (a chat's orders missing that one app, a remedy asked again at the next follow), and HQ's watch reports
// an app that's down. So it's logged only once the app has been away call after call, each within AWAY_MS of the last,
// for longer than a deploy takes; any other answer starts it afresh (hq.ts does the same for HQ).
const AWAY_MS = 10 * 60_000;
const GATEWAY = [502, 503, 504];
const away = new Map<string, { since: number; last: number }>(); // app → its run of calls away
// a call away, counted; its line is logged only once the app has been away for AWAY_MS
function logAway(app: string, what: string) {
  const t = Date.now(), was = away.get(app);
  const since = was && t - was.last <= AWAY_MS ? was.since : t;
  away.set(app, { since, last: t });
  if (t - since >= AWAY_MS) console.error(`apps: ${what}, away for ${Math.round((t - since) / 60_000)} min`);
}

// The minimal order view (dates ISO 8601). Never the personalisation, never the full address.
export type View = {
  id: string; ref: string | null; placed_at: string | null; title: string | null; status: string;
  shipped_at: string | null; delivered_at: string | null; carrier: string | null; tracking_url: string | null;
  country: string | null; total_cents?: number | null; address_masked?: string | null;
  ship_by?: string | null; // the day it should leave the printer (YYYY-MM-DD), when the app knows it
  number?: string | null; // the number the customer was told for the order (a shop's basket's), when the app has one
  quantity?: number | null; // how many of it were ordered, all in total_cents
  product?: string | null; // the phone's view: what it is, in the title's place
};
// The answer's JSON, or null on any failure (no app, no token, timeout, non-200, not JSON). Logs ids and statuses only.
// (a company's own tools call their own paths through it)
export async function call(app: string, path: string, body: object): Promise<any> {
  const sent = post(app, path, body);
  if (!sent) return null;
  try {
    const res = await sent;
    heard(app, path, res);
    if (res.status !== 200) { await res.body?.cancel(); return null; }
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch (err: any) {
    heard(app, path, err);
    return null;
  }
}

// A call that must not act twice (the phone's answer email): its JSON, or
// 'undone' when it surely had no effect (no app configured, no connection, its gateway's 502 or 503 while it restarts,
// its own 503 or a 4xx), or 'unknown' when it may have (a timeout, a dropped connection, a 504, any other answer).
// Logged as call() logs.
export async function callOnce(
  app: string,
  path: string,
  body: object,
): Promise<Record<string, any> | 'undone' | 'unknown'> {
  const sent = post(app, path, body);
  if (!sent) return 'undone';
  try {
    const res = await sent;
    heard(app, path, res);
    if (res.status !== 200) {
      await res.body?.cancel();
      return res.status === 502 || res.status === 503 || (res.status >= 400 && res.status < 500) ? 'undone' : 'unknown';
    }
    const data = await res.json().catch(() => null);
    if (data && typeof data === 'object') return data;
    console.error(`apps: ${app} ${path} answered no JSON object`);
    return 'unknown';
  } catch (err: any) {
    heard(app, path, err);
    return NOT_OPENED.includes(err?.cause?.code) ? 'undone' : 'unknown';
  }
}
// the network's codes for a connection that never opened: nothing reached the app
const NOT_OPENED = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'];

// The request call() and callOnce() send, or null when the app has no endpoint configured (logged). Relative: an app on
// a shelf (www.<zone>/<slug>/) has its endpoint under its path
function post(app: string, path: string, body: object): Promise<Response> | null {
  const base = APPS[app], key = TOKENS[app];
  if (!base || !key) { console.error(`apps: ${app} has no order endpoint configured`); return null; }
  return fetch(new URL(`./api/care/${path}`, base.endsWith('/') ? base : `${base}/`), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
  });
}

// What an app's call() or callOnce() got, its answer or the fetch's error, counted and logged: away for a moment (its
// gateway's 502, 503 or 504, a timeout, the network's code such as ECONNREFUSED in the error's cause), back (any other
// answer), or a fault (an answer other than 200, a refused redirect, bad JSON)
function heard(app: string, path: string, got: any) {
  if (got instanceof Response) {
    if (GATEWAY.includes(got.status)) return logAway(app, `${app} ${path} answered ${got.status}`);
    away.delete(app);
    if (got.status !== 200) console.error(`apps: ${app} ${path} answered ${got.status}`);
    return;
  }
  const what = `${app} ${path} failed (${got?.name ?? 'error'})`;
  if (got?.name === 'TimeoutError' || typeof got?.cause?.code === 'string') logAway(app, what);
  else console.error(`apps: ${what}`);
}

// An order view as the app sent it, or null if it isn't one (a bad app answer counts as no match).
const asView = (o: any): View | null => o && typeof o === 'object' && typeof o.id === 'string' && o.id ? o : null;

// Order number and email, as typed: the app normalises and compares. Care never learns the order's email this way. A
// number may name several of the app's orders (a shop's basket): it answers them all as `orders`, the first as `order`
export async function match(app: string, order: string, email: string): Promise<{ match: true; order: View; orders: View[] } | { match: false }> {
  const d = await call(app, 'match', { order, email });
  const views: View[] = d?.match === true ? (Array.isArray(d.orders) ? d.orders : [d.order]).map(asView).filter(Boolean) : [];
  return views.length ? { match: true, order: views[0], orders: views } : { match: false };
}

// Every order for an email checked by care (level 2), newest first; [] when the app can't answer.
export async function orders(app: string, email: string): Promise<View[]> {
  return (await answered(app, email)) ?? [];
}
// null when the app can't answer, which is not "no orders"
async function answered(app: string, email: string): Promise<View[] | null> {
  const d = await call(app, 'orders', { email });
  return Array.isArray(d?.orders) ? d.orders.map(asView).filter(Boolean).slice(0, 20) : null;
}

// Every order for an email checked by care, from each of these apps (a shop's), each with its app, newest first, and the
// apps that couldn't answer: their orders are missing, so a number found once in the others isn't known to be unique.
// An order without a date (paid, not yet confirmed by its app) is the newest: it goes first, in the order its app sent.
export async function ordersIn(list: string[], email: string): Promise<{ orders: { app: string; view: View }[]; unanswered: string[] }> {
  const each = await Promise.all(list.map(async app => ({ app, views: await answered(app, email) })));
  const orders = each.flatMap(({ app, views }) => (views ?? []).map(view => ({ app, view })))
    .sort((a, b) => {
      const x = a.view.placed_at, y = b.view.placed_at;
      return x && y ? String(y).localeCompare(String(x)) : Number(!!x) - Number(!!y);
    });
  return { orders, unanswered: each.filter(x => !x.views).map(x => x.app) };
}
