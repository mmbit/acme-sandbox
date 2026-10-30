// A try's version on staging (Ink 1.1, piece 6): each version with a branch (trybranch.ts) has a preview of its own at
// try-<slip>.preview.<zone>, behind the board's preview login like any product's (preview.ts: the board's key is good on
// the whole preview domain), never public. HQ serves it itself, from the commit its branch was made on with the
// version's patch laid over (the branch's own files, without fetching it): HQ's screens in dev mode on their mock data,
// as platform/hq/serve.mjs serves them to a try run, and the venture cycles' pages (decks) as they are. A version of a
// product with a server of its own (products/<slug>/ with its product.yaml) gets no preview: one container per version
// isn't worth it yet, so it shows its picture alone (DECISIONS, 2026-10-30). Caddy's one site for the try hosts
// (infra/products.py) gets each host's certificate when it's first asked for, if tryHost() says the version is there.
// The preview goes with the branch (trybranch.ts dropBranch): a cleared version's host serves nothing.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { ORIGIN, PREVIEW, REPO_DIR, ZONE } from '../config.ts';
import { db } from '../db.ts';
import { isProduct } from '../owedproducts.ts';
import { DIR } from '../pagescraps.ts';
import { boardOn } from '../preview.ts';
import { typeOf } from '../types.ts';
import { answer, mockFiles } from '../../../hq/serve.mjs';
import type { Slip } from './bookslips.ts';
import { applied } from './trybranch.ts';

const run = promisify(execFile);
const HOST = /^try-([1-9][0-9]{0,9})$/;
// A version's preview host, or none without a domain (a run on one's own machine)
export const hostOf = (slip: number) => (ZONE ? `try-${slip}${PREVIEW}` : null);
// The version a host is the preview of, if it is one
export function versionAt(host: string) {
  const h = host.toLowerCase().split(':')[0];
  const id = ZONE && h.endsWith(PREVIEW) ? HOST.exec(h.slice(0, -PREVIEW.length))?.[1] : undefined;
  return id ? Number(id) : null;
}
// A version still there with its branch: what its host serves
const live = (id: number) =>
  db
    .prepare(
      "select * from book_slips where id = ? and style = 'version' and branch is not null and base is not null and cleared is null",
    )
    .get(id) as Slip | undefined;

// The page a version's preview opens on, from the paths its patch changes: a deck's folder for a cycles page, HQ for
// the rest; null for a product with a server of its own
export function pageOf(paths: string[]) {
  const deck = paths.map(p => /^products\/_cycles\/([^/]+\/[^/]+)\//.exec(p)?.[1]).find(Boolean);
  if (deck) return `/products/_cycles/${deck}/`;
  return paths.some(p => isProduct(/^products\/([^/]+)\//.exec(p)?.[1])) ? null : '/';
}
// Its address, or null (no domain, or nothing to serve it from)
export function linkOf(slip: number, paths: string[]) {
  const host = hostOf(slip),
    page = pageOf(paths);
  return host && page ? `https://${host}${page}` : null;
}

// GET /api/preview/try-host?domain=<host>: Caddy's ask before it gets a try host its certificate (on_demand_tls), so
// only a version that's there gets one
export const tryHost = (domain: string) => {
  const id = versionAt(domain);
  return id !== null && live(id) ? 200 : 404;
};

// The files the version changed over its base (null: removed), kept while the coordinator runs
const overlays = new Map<number, Map<string, string | null>>();
function overlayOf(s: Slip) {
  const had = overlays.get(s.id);
  if (had) return had;
  // (its patch applied to this commit when it was clipped: bookanswer.ts)
  const files = applied(readFileSync(`${DIR}/${s.patch}`, 'utf8'), s.base!);
  if (typeof files === 'string') throw new Error(`Version ${s.id}: ${files}`);
  const made = new Map(files.map(f => [f.path, f.text] as const));
  overlays.set(s.id, made);
  return made;
}
export const forget = (slip: number) => overlays.delete(slip);
// A path's bytes in the version: its patch's, else its base commit's (rejects when there's none)
const reader = (base: string, overlay: Map<string, string | null>) => async (path: string) => {
  if (overlay.has(path)) {
    const text = overlay.get(path);
    if (text == null) throw new Error('removed');
    return Buffer.from(text);
  }
  const { stdout } = await run('git', ['-c', `safe.directory=${REPO_DIR}`, '-C', REPO_DIR, 'show', `${base}:${path}`], {
    encoding: 'buffer',
    maxBuffer: 256 << 20,
    timeout: 20_000,
  });
  return stdout;
};
let mock: Promise<Record<string, string>> | null = null;

// A request on a try host: the board's only, and only the version's own files (no API of HQ's: dev mode's mock data)
export async function serveTry(req: IncomingMessage, res: ServerResponse, id: number) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!boardOn(req, host)) return void res.writeHead(403, { 'content-type': 'text/plain' }).end('not allowed');
  // No service worker on a try host: a version's own one could catch the preview login's code on its way in
  if (req.headers['service-worker'] === 'script')
    return void res.writeHead(403, { 'content-type': 'text/plain' }).end('no service workers on a version');
  const s = live(id);
  if (!s) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('This version was cleared.');
  // HQ's viewer frames it; nothing else may
  res.setHeader('content-security-policy', `frame-ancestors 'self' ${ORIGIN}`);
  res.setHeader('cache-control', 'no-cache');
  const read = reader(s.base!, overlayOf(s));
  const path = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
  if (!path.startsWith('products/_cycles/'))
    return answer(read, await (mock ??= mockFiles(REPO_DIR)), REPO_DIR)(req, res);
  // (a deck's files as the cycles' host serves them)
  const file = decoded(path.endsWith('/') ? `${path}index.html` : path);
  const body = !file || file.includes('..') ? null : await read(file).catch(() => null);
  res.writeHead(body ? 200 : 404, { 'content-type': (file && typeOf(file)) ?? 'application/octet-stream' }).end(body);
}
const decoded = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
};
