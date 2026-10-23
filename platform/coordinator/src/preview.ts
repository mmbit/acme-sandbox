// Preview access for products at <slug>.preview.<zone>. Product code is written by agents, so it must
// never see the board's HQ session. Instead the board gets a separate preview key, valid only on the
// preview domain:
//   1. Caddy asks /api/preview/check (forward_auth) whether the request carries a valid preview key.
//   2. If not, the board is sent to HQ (/preview/login), which needs the HQ session and mints a key,
//   3. then back to the product's /__preview, which stores the key as a cookie on .preview.<zone>.
// HQ's own viewer skips 1 and 2 (single sign-on): it asks for a link (POST /api/preview/link) and opens that.
// Links carry a one-time code, good for two minutes, never the key itself.
// An outside reviewer the board shared a preview with (shares.ts) passes 1 with a session of that share instead: the
// host-only `ps` cookie, on what the share opens only. Without one, 2 sends them to the guest desk, whose session hands them
// one (guests.ts onward: a demo the shared deck links to). Never on a route Caddy asks about with ?board=1 (the
// chat's: an outsider's chat would reach the board and the shop's real orders), except a tester invite's: its people
// shop the preview door as customers do, the support chat included.
// Each request it lets through carries who is looking, for the product (viewers.ts): X-Viewer, which Caddy copies to the
// request on its way (copy_headers) and takes off any request that comes with one.
// A page can hand a link to another device (a phone that scans its QR code): POST /__preview/handoff makes it a one-time
// link that gives that device the same access as the page's (the board's or that share's), on this host only and for an
// hour.
// A running agent job checks a product's preview with a pass (createPass, hq preview): see below.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { PUBLIC_HOST, ZONE } from './config.ts';   // (ZONE)
import { FRONT } from './approvals.ts';
import * as shares from './shares.ts';
import { shelfOf } from './shelves.ts';
import { viewerId } from './viewers.ts';
import * as owed from './owed.ts';
import { logStep } from './log.ts';
import { plansOf } from './pricing.ts';
import * as players from './players.ts';

export const PREVIEW = `.preview.${ZONE}`;
const DAYS = 30;
// A link for another device stays good while its page may show it, and the access it hands on lasts an hour
const HANDED_LINK_MS = 15 * 60_000,
  HANDED_ACCESS_MS = 60 * 60_000;
// host: the one preview host a key handed to another device opens (none: the whole preview domain).
db.exec('create table if not exists preview_keys (key text primary key, expires integer not null, host text)');
db.exec('create table if not exists preview_codes (code text primary key, key text not null, expires integer not null)');

export const cookie = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);
const redirect = (res: ServerResponse, to: string) => { res.writeHead(302, { location: to }); res.end(); };
const keyOn = (key: string, host: string) =>
  db.prepare('select expires, host from preview_keys where key = ? and expires > ? and (host is null or host = ?)')
    .get(key, Date.now(), host) as { expires: number; host: string | null } | undefined;
// The board's key a request on host carries, if any, of all its pv cookies: a whole-domain one first, else one handed to
// this device for this host alone
const boardKey = (req: IncomingMessage, host: string) =>
  (req.headers.cookie ?? '').split(/;\s*/).filter(c => c.startsWith('pv=')).map(c => keyOn(c.slice(3), host))
    .filter(k => !!k).sort((a, b) => Number(!!a.host) - Number(!!b.host))[0];
export const boardOn = (req: IncomingMessage, host: string) => !!boardKey(req, host);

// A pass (hq preview): an agent job's view of one product's preview host, to check a product as a visitor sees it.
// Like a view-only share: no review mode, never a route Caddy asks about with ?board=1 (the chat), no hand-off to
// another device, never HQ. Its host-only `pp` cookie reaches the job's browser through the environment alone (hq runs a
// command with it), and Caddy keeps it from the product as it does pv and ps. It ends with the run that asked (bound to
// that run's token: a later run of the same job gets a new one) or after PASS_MS, whichever comes first. HQ keeps every
// pass (who, for which host, when), and the job's log, which the board opens in HQ, says so as it's given.
// On a product with plans a pass may be a test player of the job's (player: its name, players.ts): the same
// pass, which the product knows as that player.
const PASS_MS = 60 * 60_000;
db.exec(`create table if not exists preview_passes (hash text primary key, job integer not null, agent text not null,
  host text not null, run text not null, created text not null, expires integer not null, player text)`);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const passOf = (req: IncomingMessage, host: string) =>
  db.prepare(`select p.job, p.run, p.player from preview_passes p join jobs j on j.id = p.job and j.token = p.run and
    j.status = 'running' where p.hash = ? and p.host = ? and p.expires > ?`).get(sha256(cookie(req, 'pp') ?? ''), host, Date.now()) as
    { job: number; run: string; player: string | null } | undefined;

// POST /api/agent/preview-passes {slug, player?}: a pass to a product's preview for job's running run, given to agent (its
// lead or a team member), as the job's test player of that name if asked (with its voucher), or why not
export function createPass(job: number, agent: string, slug: unknown, player?: unknown) {
  if (typeof slug !== 'string' || slug === owed.CYCLES || slug.includes('/') || !owed.isProduct(slug))
    return [404, 'no such product'];
  if (player != null && (typeof player !== 'string' || !players.PLAYER.test(player)))
    return [400, 'a player is named in lowercase letters, digits and dashes, up to 32'];
  if (player != null && !plansOf(slug)) return [409, `${slug} has no plans: a test player is for a product with plans`];
  const run = (db.prepare("select token from jobs where id = ? and status = 'running'").get(job) as { token: string } | undefined)?.token;
  if (!run) return [409, `job #${job} isn't running`];
  const secret = randomBytes(32).toString('base64url'), host = `${slug}${PREVIEW}`, expires = new Date(Date.now() + PASS_MS);
  db.prepare('insert into preview_passes (hash, job, agent, host, run, created, expires, player) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(secret), job, agent, host, run, new Date().toISOString(), expires.getTime(), player ?? null);
  const voucher = typeof player === 'string' ? players.voucherFor(slug, job, run, player) : undefined;
  const access = voucher ? `test player ${player}, with a test voucher,` : 'view-only';
  logStep(job, agent, `Preview pass: ${access} on ${host} until ${expires.toISOString().slice(11, 16)} UTC or this run's end`);
  return { url: `https://${host}/`, cookie: `pp=${secret}`, expires: expires.toISOString(), ...(voucher ? { voucher } : {}) };
}

// Who is looking at a page of a preview host: the board (its key, which wins), an outside reviewer whose share opens
// this host and path (uri: its own, or a preview its pages link to), an agent job's pass to this host (pass: its job, run
// and player), or nobody. mayHandOn: whether this page may give another device a link. A handed device or a pass cannot.
export function viewer(req: IncomingMessage, host: string, uri: string) {
  const key = boardKey(req, host);
  if (key) return { board: true, share: null, mayHandOn: !key.host };
  const share = shares.fromSession(cookie(req, 'ps'), host);
  if (share && shares.opens(share, host, uri)) return { board: false, share, mayHandOn: !share.handed };
  const pass = passOf(req, host);
  return pass ? { board: false, share: null, mayHandOn: false, pass } : null;
}

// 1. forward_auth from Caddy: the original host and URI come in X-Forwarded-* headers.
export function check(req: IncomingMessage, res: ServerResponse) {
  const host = String(req.headers['x-forwarded-host'] ?? '');
  const uri = String(req.headers['x-forwarded-uri'] ?? '/');
  const boardOnly = new URL(req.url ?? '/', 'http://x').searchParams.has('board');
  const v = viewer(req, host, uri);
  if (v && (v.board || !boardOnly || v.share?.tester)) {
    // a pass is an agent's job, not a viewer: it looks as a visitor with nothing held does, unless it's the job's test player
    const product = productAt(host, uri);
    const who = v.board ? 'board'
      : v.share ? { share: v.share.id, guest: v.share.guest }
      : v.pass?.player ? { job: v.pass.job, run: v.pass.run, player: v.pass.player } : null;
    res.writeHead(200, who ? { 'x-viewer': viewerId(product, who) } : {});
    return res.end();
  }
  // a notes or view-only share, or a pass, on the board's route: no sign-in helps (the guest desk would hand them back here, round and round)
  if (v) { res.writeHead(403); return res.end(); }
  redirect(res, `https://${PUBLIC_HOST}/preview/login?to=${encodeURIComponent(`https://${host}${uri}`)}`);
}

// The product a preview request reaches: the host's, or on the front's preview door the shelf its path is on (shelves.ts)
function productAt(host: string, uri: string) {
  const slug = host.slice(0, -PREVIEW.length);
  return slug === FRONT ? (shelfOf(uri.split('?')[0]) ?? FRONT) : slug;
}

// On HQ, behind the board login: a one-time link that signs the board in on a preview address.
function signedLink(target: string) {
  let to: URL;
  try { to = new URL(target); } catch { return null; }
  if (to.protocol !== 'https:' || !to.hostname.endsWith(PREVIEW)) return null;
  return boardLink(to.host, to.pathname + to.search, { keyMs: DAYS * 864e5, linkMs: 120_000 });
}
// host: the key opens that host alone (a link handed to another device), or every preview (null)
function boardLink(at: string, to: string, o: { keyMs: number; linkMs: number; host?: string }) {
  const key = randomBytes(32).toString('base64url'), code = randomBytes(24).toString('base64url'), now = Date.now();
  db.prepare('delete from preview_codes where expires <= ?').run(now);
  db.prepare('delete from preview_keys where expires <= ?').run(now);
  db.prepare('insert into preview_keys (key, expires, host) values (?, ?, ?)').run(key, now + o.keyMs, o.host ?? null);
  db.prepare('insert into preview_codes (code, key, expires) values (?, ?, ?)').run(code, key, now + o.linkMs);
  return `https://${at}/__preview?c=${code}&to=${encodeURIComponent(to)}`;
}
// 2. The redirect from a preview address without a key.
export function login(req: IncomingMessage, res: ServerResponse) {
  const link = signedLink(new URL(req.url!, 'http://x').searchParams.get('to') ?? '');
  if (!link) { res.writeHead(400); return res.end('not a preview address'); }
  redirect(res, link);
}
// HQ's viewer: POST /api/preview/link {url}
export const link = (url: string) => { const l = signedLink(url); return l ? { url: l } : 400; };

// 3. On the preview host: keep the key as a cookie for the whole preview domain (one handed to another device: for this
// host alone, as long as it lasts), then continue. An outside reviewer's hand-off (s, from the share's door or a page of
// theirs) keeps their session on this host alone. A link used before goes on when this device already got in with it.
export function accept(req: IncomingMessage, res: ServerResponse) {
  const q = new URL(req.url!, 'http://x').searchParams, to = q.get('to') ?? '/';
  if (q.has('s')) return acceptShare(req, res, q.get('s')!, to);
  const host = String(req.headers.host ?? '').toLowerCase();
  const row = db.prepare('delete from preview_codes where code = ? and expires > ? returning key').get(q.get('c') ?? '', Date.now()) as { key: string } | undefined;
  const key = row && keyOn(row.key, host);
  if (!row || !key) return ended(req, res, host, to, 'Open it again from HQ.');
  // a key handed to another device gets its hour from when that device opens the link
  const expires = key.host ? Date.now() + HANDED_ACCESS_MS : key.expires;
  if (key.host) db.prepare('update preview_keys set expires = ? where key = ?').run(expires, row.key);
  const scope = key.host ? '' : `Domain=${PREVIEW.slice(1)}; `;
  res.writeHead(302, {
    'set-cookie': `pv=${row.key}; ${scope}Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor((expires - Date.now()) / 1000)}`,
    location: pathOn(to, host) ?? '/',
  });
  res.end();
}

function acceptShare(req: IncomingMessage, res: ServerResponse, code: string, to: string) {
  const host = String(req.headers.host ?? '').toLowerCase(), given = shares.accept(code, host);
  if (!given) return ended(req, res, host, to, 'Open it again from the page it came from.');
  res.writeHead(302, {
    'set-cookie': `ps=${given.session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${given.seconds}`,
    location: pathOn(to, host) ?? given.start,
  });
  res.end();
}

// A destination on this host, as the browser reads it (it drops tabs and newlines, so "/<tab>/other.example" leaves the
// host; "/.//other.example" normalizes to "//other.example"), or null.
function pathOn(to: string, host: string) {
  const onHost = /^\/(?![/\\])/;
  try {
    const at = new URL(to, `https://${host}`), path = at.pathname + at.search + at.hash;
    return onHost.test(to) && onHost.test(path) && at.origin === `https://${host}` ? path : null;
  } catch {
    return null;
  }
}

function ended(req: IncomingMessage, res: ServerResponse, host: string, to: string, again: string) {
  const back = pathOn(to, host);
  if (back && viewer(req, host, back)) return redirect(res, back);
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`This link has ended or was used already. ${again}`);
}

// A page's link for another device: POST /__preview/handoff {to} from the page's own origin on a preview host, where to is
// a path on this host that the page's viewer may open. → {url}, one-time for HANDED_LINK_MS (the caller keeps its own
// #fragment and adds it: a redirect keeps it), or 403. A device that got in by a hand-off hands on nothing, so its hour
// never renews itself.
export function handOn(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const host = String(req.headers.host ?? '').toLowerCase();
  const asked = typeof (body as { to?: unknown })?.to === 'string' ? (body as { to: string }).to : '';
  const fromOwnPage = host.endsWith(PREVIEW) && req.headers.origin === `https://${host}`;
  const to = fromOwnPage ? pathOn(asked, host) : null;
  const looking = to ? viewer(req, host, to) : null;
  let url: string | null = null;
  if (to && looking && looking.mayHandOn)
    url = looking.board
      ? boardLink(host, to, { keyMs: HANDED_ACCESS_MS, linkMs: HANDED_LINK_MS, host })
      : shares.handOn(looking.share!, host, to, { linkMs: HANDED_LINK_MS, accessMs: HANDED_ACCESS_MS });
  res.writeHead(url ? 200 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(url ? { url } : { error: 'not allowed' }));
}
