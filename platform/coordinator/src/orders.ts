// HQ's read-only list of our live Print API orders (hq orders), for checking Print API's monthly invoice against what we
// really ordered. The live keys stay in HQ, so HQ reads Print API's own order list with them every hour and keeps only
// what that check needs: ids, times, statuses, products and quantities, the shipping method, the invoice's numbers and
// whether Print API bills it. Never the address, email, names, titles, metadata text, file or checkout links, or any
// text Print API writes (its answers echo the address: printapi-spec.md). Errors are kept as status codes only.
// Nothing at all is asked of Print API until both live keys are stored.
import { statSync } from 'node:fs';
import { REPO_DIR } from './config.ts';
import { db } from './db.ts';
import { secret } from './secrets.ts';
import * as printapi from './printapi.ts';   // its live token, and the company's own orders
import './payments.ts';   // (its table: "ours" for an order paid through HQ)

db.exec(`create table if not exists printapi_orders (id text primary key, placed text, status text not null,
  history text not null default '[]', items text not null default '[]', shipping text, speed text, invoice text,
  invoicing text, cancellation text, cancel_seen text, shop text, reprint_of text, first_seen text not null,
  last_checked text not null, last_read integer not null default 0)`);

// Why a job is refused the list: an order's id opens a customer's order, so only org.yaml's roles.orders read it (server.ts,
// and a kit's own reads of order ids).
export const REFUSED = "order ids open a customer's order on a product's site, so they go only to the agents whose work needs them (org.yaml's roles.orders): ask one of them, or the agent in org.yaml's roles.process to add you";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const PAGE = 50, MAX_PAGES = 200;          // 10,000 orders: far beyond us, and never an endless loop on a strange answer
const RECENT = 90 * DAY;                   // re-read daily (invoicingState) and listed by default: the invoice comes up to six weeks later
const SYNC_BACK = 6 * DAY;                 // sync/statuses reaches 7 days back at most

// ---- the sync's own state (settings rows): the last good sync's start, the last failure, the last try, and whether the
// last sync got through (orders.listed)
const setting = (key: string) => (db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;
const remember = (key: string, value: string | null) => value === null ? db.prepare('delete from settings where key = ?').run(key)
  : db.prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
export const keys = () => !!secret('PRINTAPI_LIVE_CLIENT_ID') && !!secret('PRINTAPI_LIVE_CLIENT_SECRET');

// ---- what may be kept: each value checked for its shape, anything else becomes null (never the text itself)
const WORD = /^[A-Za-z0-9_.-]{1,80}$/, ID = /^[A-Za-z0-9_.-]{1,64}$/, STATE = /^[A-Za-z]{1,24}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,7})?)?$/;     // Print API's: Dutch local time, no offset
const METHOD = /^[\p{L}\p{N} ().,/+&-]{1,60}$/u;                      // "NL Pakket S", "Brief (50 g)"
const REPRINT = /^[A-Za-z0-9_-]{1,64}$/, SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const fits = (re: RegExp) => (v: unknown) => typeof v === 'string' && re.test(v) ? v : null;
const word = fits(WORD), state = fits(STATE), time = fits(TIME);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const whole = (v: unknown) => Number.isInteger(v) ? v as number : null;
const item = (i: any) => ({ productId: word(i?.productId), quantity: whole(i?.quantity), pageCount: whole(i?.pageCount),
  ...(Array.isArray(i?.options) && i.options.length ? { options: i.options.map((o: any) => ({ id: word(o?.id), value: word(o?.value) })) } : {}) });
const PARTS = ['production', 'shipping', 'handling', 'discount', 'total'];
const money = (inv: any) => !inv || typeof inv !== 'object' ? null : Object.fromEntries(PARTS.filter(p => inv[p] && typeof inv[p] === 'object')
  .map(p => [p, { cost: num(inv[p].cost), taxes: (Array.isArray(inv[p].taxes) ? inv[p].taxes : [])
    .map((t: any) => ({ rate: num(t?.rate), amount: num(t?.amount), calculatedOver: num(t?.calculatedOver) })) }]));

// The shop and a reprint's original, from the order's metadata, which is read here and never kept. Products place with their
// slug as the first word ('pebblet', 'tidepool order <id>'); a reprint with JSON {"product": "<slug>", "reprintOf": "<id>"}
// (the convention in printapi-orders.md). Only a slug that is a product folder in the repo counts as a shop.
const isShop = (s: unknown) => typeof s === 'string' && SLUG.test(s) && (() => { try { return statSync(`${REPO_DIR}/products/${s}`).isDirectory(); } catch { return false; } })();
function fromMetadata(metadata: unknown) {
  if (typeof metadata !== 'string') return { shop: null, reprintOf: null };
  let j: any = null;
  try { j = JSON.parse(metadata); } catch { /* plain text: its first word */ }
  if (j && typeof j === 'object' && !Array.isArray(j))
    return { shop: isShop(j.product) ? j.product : null, reprintOf: typeof j.reprintOf === 'string' && REPRINT.test(j.reprintOf) ? j.reprintOf : null };
  const first = metadata.trim().split(/\s+/)[0];
  return { shop: isShop(first) ? first : null, reprintOf: null };
}

// ---- Print API (live): the shared live token (printapi.ts), our own GETs. A failure keeps its status code only:
// Print API's text can echo the address.
class Failed extends Error { status: number; constructor(status: number) { super(`Print API ${status}`); this.status = status; } }
async function get(path: string) {
  let token: string;
  try { token = await printapi.auth(); } catch (e: any) { throw new Failed(Number(e?.status) || 0); }
  const r = await fetch(printapi.api() + path, { signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
    .catch(() => { throw new Failed(0); });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Failed(r.status); }
  return r.json().catch(() => { throw new Failed(502); });
}
const path = (id: string) => `/orders/${encodeURIComponent(id)}`;

// ---- the table
type Row = { id: string; placed: string | null; status: string; history: string; items: string; shipping: string | null;
  speed: string | null; invoice: string | null; invoicing: string | null; cancellation: string | null; cancel_seen: string | null;
  shop: string | null; reprint_of: string | null; first_seen: string; last_checked: string; last_read: number };
const row = (id: string) => db.prepare('select * from printapi_orders where id = ?').get(id) as Row | undefined;
const iso = (ms: number) => new Date(ms).toISOString();

// One order, read whole and kept by the allowlist. Its invoice is kept as first read: that's the price at placement. Both
// reads come before anything's written: a cancellation that fails leaves the row as it was, so the order is still due.
async function read(id: string, now: number) {
  const o = await get(path(id)), c = await cancelled(id);
  const m = fromMetadata(o?.metadata), was = row(id);
  const kept = { placed: time(o?.dateTime), status: state(o?.status) ?? '?', items: JSON.stringify((Array.isArray(o?.items) ? o.items : []).map(item)),
    shipping: fits(METHOD)(o?.shipping?.method?.name), speed: state(o?.productionSpeed), invoicing: state(o?.invoicingState),
    shop: m.shop, reprint_of: m.reprintOf };
  const invoice = money(o?.invoice);
  if (!was) db.prepare(`insert into printapi_orders (id, placed, status, items, shipping, speed, invoice, invoicing, shop, reprint_of,
    first_seen, last_checked, last_read) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, kept.placed, kept.status, kept.items, kept.shipping, kept.speed, invoice ? JSON.stringify(invoice) : null, kept.invoicing,
      kept.shop, kept.reprint_of, iso(now), iso(now), now);
  else db.prepare(`update printapi_orders set placed = ?, status = ?, items = ?, shipping = ?, speed = ?, invoice = coalesce(invoice, ?),
    invoicing = ?, shop = ?, reprint_of = ?, last_checked = ?, last_read = ? where id = ?`)
    .run(kept.placed, kept.status, kept.items, kept.shipping, kept.speed, invoice ? JSON.stringify(invoice) : null, kept.invoicing,
      kept.shop, kept.reprint_of, iso(now), now, id);
  keepCancellation(id, c, now);
}
// An order Print API no longer shows (404) is left as last read, so it can't stop the sync of every other one.
const skip404 = (p: Promise<void>) => p.catch(e => { if (!(e instanceof Failed && e.status === 404)) throw e; });
const readOrSkip = (id: string, now: number) => skip404(read(id, now));
// None | Requested | Accepted | Failed, and when HQ first saw Accepted (the status history's time wins where it has one).
// Never the reason: it's text someone wrote.
const cancelled = async (id: string) => state((await get(`${path(id)}/cancellation`))?.status);
const cancellation = async (id: string, now: number) => keepCancellation(id, await cancelled(id), now);
function keepCancellation(id: string, c: string | null, now: number) {
  db.prepare(`update printapi_orders set cancellation = ?, cancel_seen = case when ? = 'Accepted' then coalesce(cancel_seen, ?) else cancel_seen end,
    last_checked = ? where id = ?`).run(c, c, iso(now), iso(now), id);
}
function addHistory(id: string, entries: { status: string; at: string }[]) {
  const r = row(id);
  if (!r) return;
  const h: { status: string; at: string }[] = JSON.parse(r.history);
  for (const e of entries) if (!h.some(x => x.status === e.status && x.at === e.at)) h.push(e);
  h.sort((a, b) => a.at.localeCompare(b.at));
  db.prepare('update printapi_orders set history = ? where id = ?').run(JSON.stringify(h), id);
}

// ---- the hourly sync
// 1. The listing (newest first), page by page until a page holds only orders we already had, or it runs out: new orders,
//    and ones whose status moved. Only after a sync that got through (orders.listed): one that stopped anywhere, a restart
//    included, may have left out orders further down, so the next listing goes to the end. 2. sync/statuses since the last good sync's start minus an hour (at most six days back):
//    every status change with its time, the history. 3. Each new or moved order read whole, with its cancellation.
//    4. Hourly, the cancellation of any order whose cancellation is Requested. 5. Daily, every order placed in the last
//    90 days read again, for invoicingState. What was read stays even if a later call fails; the next hour tries again, from
//    the whole listing.
async function sync(now = Date.now()) {
  if (!keys()) return;
  remember('orders.tried', String(now));
  const whole = setting('orders.listed') !== 'yes';
  remember('orders.listed', null);   // set again only once this sync gets through
  try {
    const had = new Set((db.prepare('select id from printapi_orders').all() as { id: string }[]).map(r => r.id));
    const statusOf = (id: string) => (db.prepare('select status from printapi_orders where id = ?').get(id) as { status: string } | undefined)?.status;
    const due = new Set<string>();
    let odd = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const l = await get(`/orders?offset=${page * PAGE}&limit=${PAGE}`);
      const results: any[] = Array.isArray(l?.results) ? l.results : [];
      for (const e of results) {
        const id = fits(ID)(e?.id);
        if (!id) odd++;
        else if (!had.has(id) || statusOf(id) !== state(e?.status)) due.add(id);
      }
      if (results.length < PAGE || (!whole && results.every(e => had.has(e?.id)))) break;
    }
    const last = Date.parse(setting('orders.synced') ?? '') || 0;
    const since = Math.max(last - HOUR, now - SYNC_BACK);
    const s = await get(`/sync/statuses?since=${encodeURIComponent(iso(since))}`);
    const changes = new Map<string, { status: string; at: string }[]>();
    for (const e of Array.isArray(s?.results) ? s.results : []) {
      const id = fits(ID)(e?.id), st = state(e?.status), at = time(e?.dateTime);
      if (!id || !st || !at) continue;
      changes.set(id, [...changes.get(id) ?? [], { status: st, at }]);
    }
    for (const [id, h] of changes) {
      const latest = [...h].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!;
      if (!had.has(id) || statusOf(id) !== latest.status || !JSON.parse(row(id)!.history).some((x: any) => x.status === latest.status && x.at === latest.at)) due.add(id);
    }
    for (const id of due) await readOrSkip(id, now);
    for (const [id, h] of changes) addHistory(id, h);
    const requested = db.prepare("select id from printapi_orders where cancellation = 'Requested'").all() as { id: string }[];
    for (const { id } of requested) if (!due.has(id)) await skip404(cancellation(id, now));
    const recent = db.prepare('select id, placed from printapi_orders where last_read < ?').all(now - DAY) as { id: string; placed: string | null }[];
    const from = iso(now - RECENT).slice(0, 10);
    for (const { id, placed } of recent) if (!placed || placed.slice(0, 10) >= from) await readOrSkip(id, now);
    // (an id we'd never place: not kept, since it goes into a URL and the table; said here so it isn't missed unseen)
    if (odd) console.error(`Print API orders: ${odd} order(s) in the listing with an id that isn't letters, digits, - _ or . were left out`);
    remember('orders.synced', iso(now)); remember('orders.error', null); remember('orders.listed', 'yes');
  } catch (e: any) {
    if (!(e instanceof Failed)) throw e;
    const was = JSON.parse(setting('orders.error') ?? 'null');
    remember('orders.error', JSON.stringify({ status: e.status, since: was?.since ?? iso(now) }));
    console.error(`Print API orders: the sync failed (${e.status || 'no answer'})`);
  }
}

let busy = false;
export async function tick(now = Date.now()) {
  if (busy || now - (Number(setting('orders.tried')) || 0) < HOUR) return;   // hourly, across restarts too
  busy = true;
  try { await sync(now); } catch (e) { console.error('Print API orders:', e instanceof Error ? e.message : e); }   // our own code's: no Print API text
  finally { busy = false; }
}
export const start = () => { setTimeout(() => tick(), 60_000); setInterval(() => tick(), 5 * MIN); };

// ---- what HQ knows about the order itself: a payment through HQ, a company's own tool's order (printapi.ts
// registerOrders), or nothing
const RANK = ['refunded', 'paid', 'complete', 'open', 'expired'];     // a refund or a payment says more than a session left open
const rank = (s: string) => { const i = RANK.indexOf(s); return i < 0 ? RANK.length : i; };
function ours(id: string) {
  const rows = db.prepare("select product, status, amount, currency from payments where mode = 'live' and reference = ?").all(id) as
    { product: string; status: string; amount: number; currency: string }[];
  const p = rows.sort((a, b) => rank(a.status) - rank(b.status))[0];
  if (p) return { shop: p.product, ours: { from: 'payment', status: p.status, amount: p.amount / 100, currency: p.currency } };
  const own = printapi.ownOrder(id);
  if (own) return own;
  return { shop: null, ours: { from: null, status: 'no record in HQ', amount: null, currency: null } };
}

// ---- the agents' route (GET /api/agent/orders): orders placed since a day (YYYY-MM-DD, Dutch time), 90 days by default, or all
export function list(since?: string) {
  const all = since === 'all';
  if (since && !all && !/^\d{4}-\d\d-\d\d$/.test(since)) return 'since: a date (YYYY-MM-DD, compared with when the order was placed) or all';
  const from = all ? '' : since || iso(Date.now() - RECENT).slice(0, 10);
  const err = JSON.parse(setting('orders.error') ?? 'null');
  const rows = db.prepare("select * from printapi_orders where ? = '' or placed is null or placed >= ? order by placed desc, id").all(from, from) as Row[];
  return {
    keys: keys(), synced: setting('orders.synced') ?? null, since: from || 'all',
    error: err ? `${err.status ? `Print API answered ${err.status}` : "Print API didn't answer"}, failing since ${err.since}` : null,
    orders: rows.map(r => {
      const history: { status: string; at: string }[] = JSON.parse(r.history), o = ours(r.id);
      const cancelled = history.find(h => h.status === 'Cancelled');
      return { id: r.id, placed: r.placed, shop: o.shop ?? r.shop, status: r.status, history, items: JSON.parse(r.items),
        shipping: r.shipping, productionSpeed: r.speed, invoice: r.invoice ? JSON.parse(r.invoice) : null, invoicingState: r.invoicing,
        cancellation: { status: r.cancellation, accepted: r.cancellation !== 'Accepted' ? null
          : cancelled ? { at: cancelled.at, from: "Print API's status history, Dutch time" } : { at: r.cancel_seen, from: 'when HQ first saw it, UTC' } },
        ours: o.ours, reprintOf: r.reprint_of, firstSeen: r.first_seen, lastChecked: r.last_checked };
    }),
  };
}
