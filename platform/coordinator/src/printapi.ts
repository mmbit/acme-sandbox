// Print API for HQ's own tools: its address and one token per mode, from the keys the board saved (PRINTAPI_LIVE_CLIENT_ID
// and _SECRET; PRINTAPI_TEST_* for the test environment), and its error. orders.ts (hq orders) reads with the live token;
// the shop's parcels (parcels.ts) and a company's own tools place orders with call(). Never the key or Print API's text in
// a log line: its answers can echo an address. And which live orders a company's own tool placed: orders.ts asks each
// tool that registered (ownOrder()) about an order no payment through HQ explains.
import { createHash } from 'node:crypto';
import { secret } from './secrets.ts';

// both modes, and call() (from a company's own tool), for the shop's parcels
export type Mode = 'test' | 'live';
const ENV = {
  test: { api: () => (process.env.PRINTAPI_TEST_API ?? 'https://test.printapi.nl/v2').replace(/\/$/, ''), id: 'PRINTAPI_TEST_CLIENT_ID', key: 'PRINTAPI_TEST_CLIENT_SECRET' },
  live: { api: () => (process.env.PRINTAPI_LIVE_API ?? 'https://live.printapi.nl/v2').replace(/\/$/, ''), id: 'PRINTAPI_LIVE_CLIENT_ID', key: 'PRINTAPI_LIVE_CLIENT_SECRET' },
};
export const api = (mode: Mode = 'live') => ENV[mode].api();
export const keys = (mode: Mode) => !!secret(ENV[mode].id) && !!secret(ENV[mode].key);
// the mode's keys as they are now, hashed: what a token, or an answer about them, is for
export const keysHash = (mode: Mode) => hashOf(secret(ENV[mode].id), secret(ENV[mode].key));

export class PrintApiError extends Error {
  status: number; auth: boolean;   // auth: from getting a token, not from the call itself
  constructor(status: number, message: string, auth = false) { super(message); this.status = status; this.auth = auth; }
}

// one token per mode for the same keys: new keys on the desk phone get a new one
const tokens = new Map<Mode, { token: string; keys: string; until: number }>();
export async function auth(mode: Mode = 'live') {
  const e = ENV[mode], id = secret(e.id), key = secret(e.key);
  const keys = hashOf(id, key), known = tokens.get(mode);
  if (known && known.keys === keys && Date.now() < known.until) return known.token;
  const r = await fetch(`${e.api()}/oauth`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: key }) })
    .catch(() => { throw new PrintApiError(0, 'no answer', true); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) throw new PrintApiError(r.status || 502, `the ${mode} keys were refused (${String(j?.error ?? r.status).slice(0, 40)})`, true);
  tokens.set(mode, { token: j.access_token, keys, until: Date.now() + (Number(j.expires_in) - 300) * 1000 });
  return j.access_token as string;
}
const hashOf = (id: string, key: string) => createHash('sha256').update(`${id}\n${key}`).digest('hex');

// One request: { status, body } (body: the JSON answer of a 2xx, else null), so Print API's text never travels on. A whole
// URL (an item's upload URL, from Print API's answer) is only ever one on Print API's own origin, and no request follows
// a redirect, so neither the token nor the customer's file goes anywhere else. Throws a PrintApiError only when there's
// no answer at all (or a refused token).
export async function call(mode: Mode, method: string, path: string, body?: unknown, type = 'application/json') {
  const url = path.startsWith('https://') ? path : api(mode) + path;
  if (path.startsWith('https://') && !sameOrigin(mode, path)) throw new PrintApiError(502, "Print API named an upload URL that isn't on its own origin: nothing sent");
  const what = `${method} ${path.startsWith('https://') ? 'upload' : path.split('/')[1]}`;
  const r = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${await auth(mode)}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': type } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) })
    .catch(() => { throw new PrintApiError(502, `Print API: no answer, or a redirect (${what})`); });
  const text = await r.text();
  if (!r.ok) return { status: r.status, body: null };
  try { return { status: r.status, body: text ? JSON.parse(text) : null }; } catch { return { status: r.status, body: null }; }
}
const sameOrigin = (mode: Mode, url: string) => { try { return new URL(url).origin === new URL(api(mode)).origin; } catch { return false; } };

// A print file: what Print API takes, by its first bytes (the content type alone is the caller's word). (from a
// company's own tool, for the parcels' files too)
const KINDS: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'application/pdf': b => b.subarray(0, 5).toString('latin1') === '%PDF-',
};
export const MAX_FILE = 60 * 1024 * 1024;
export const fileType = (type: string, b: Buffer) => KINDS[type]?.(b) ? type : null;

// A live order a company's own tool placed, in hq orders' words: the shop it's for, and the tool's own record of it
// (from: the tool's name; its status; what it cost, if it knows). A tool answers for its own ids only, null for any other.
export type OwnOrder = { shop: string | null; ours: { from: string; status: string; amount: number | null; currency: string | null } };
const tools: ((id: string) => OwnOrder | null | undefined)[] = [];
export const registerOrders = (answer: (id: string) => OwnOrder | null | undefined) => { tools.push(answer); };
export function ownOrder(id: string) {
  for (const t of tools) { const o = t(id); if (o) return o; }
  return null;
}
