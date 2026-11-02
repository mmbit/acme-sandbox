// An earlier version of a cycles page, for HQ's viewer to show beside staging.
// A cycles page is files in git, so git already keeps its every earlier version: nothing is copied, and nothing needs
// cleaning up. A page's version is its whole cycle folder's (products/_cycles/<cycle>/), so a deck and the films and
// pictures it takes from beside it are from one point in time, the folder's commits on the server's checkout newest
// first: the newest is staging, the BACK before it its earlier versions. One is served at earlier-<n>.preview.<zone>
// with the path it has on the cycles' host, n changes back (Caddy's catch-all for the try hosts takes them,
// infra/products.py). A product with a server of its own has none: an earlier build of it is a container of its own
// (DECISIONS, 2026-11-02: the viewer's earlier versions).
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { ORIGIN, PREVIEW, REPO_DIR, ZONE } from './config.ts';
import { withReviewMode } from './feedback.ts';
import { rangeOf } from './files.ts';
import { CYCLES } from './owed.ts';
import { typeOf } from './types.ts';
import { decoded, git, gitShow, opened } from './versionhost.ts';

// Each earlier-<n> host takes a certificate of its own the first time it's opened, for every page at once, which Caddy
// then renews. They come from Let's Encrypt's 50 new certificates a week for the zone, which every try version's host
// takes one of too: nine are under a fifth of one week's, once, and leave the rest to the tries.
const BACK = 9;
const HOSTS = Array.from({ length: BACK }, (_, i) => `earlier-${i + 1}`);
// Rendered video and audio stays out of git: its .render.json names it, and the worker's store keeps it by its sha256
// (infra/renders.py)
const RENDERS = process.env.WORK_MIRROR_DIR ? `${dirname(process.env.WORK_MIRROR_DIR)}/renders` : null;

// How many changes back a host is, or null for any other host
export function backAt(host: string) {
  const h = host.toLowerCase().split(':')[0];
  const n = ZONE && h.endsWith(PREVIEW) ? HOSTS.indexOf(h.slice(0, -PREVIEW.length)) + 1 : 0;
  return n || null;
}
// The cycle folder a path on the cycles' host is in, its page at the folder's root or in a folder of its own, or null
// for a path outside any
const cycleOf = (path: string) => /^\/(\w[\w.-]*)\//.exec(path)?.[1] ?? null;

// A cycle's commits, newest first (staging's and up to BACK before it), and how many it has in all, kept until the
// checkout moves
const kept = new Map<string, { head: string; commits: { sha: string; at: string }[]; all: number }>();
async function historyOf(cycle: string) {
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const had = kept.get(cycle);
  if (had?.head === head) return had;
  const folder = `products/_cycles/${cycle}/`;
  const [log, count] = await Promise.all([
    git(['log', `-n${BACK + 1}`, '--format=%H %cI', head, '--', folder]),
    git(['rev-list', '--count', head, '--', folder]),
  ]);
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map(line => ({ sha: line.split(' ')[0], at: new Date(line.split(' ')[1]).toISOString() }));
  const history = { head, commits, all: Number(count) };
  kept.set(cycle, history);
  return history;
}

// GET /api/artifacts/earlier-versions?url=<a page on the cycles' host>: its earlier versions, newest first, each
// { back, at, open } (the same page n changes back, and when that change was made), and how many older changes it has
// past them (unlisted); none for any other page. (server.ts refuses a url that doesn't parse.)
export async function listEarlierVersions(url: string) {
  const at = new URL(url);
  const cycle = cycleOf(at.pathname);
  if (!ZONE || at.host !== `${CYCLES}${PREVIEW}` || !cycle) return { versions: [], unlisted: 0 };
  const { commits, all } = await historyOf(cycle);
  const versions = commits.slice(1).map((c, i) => {
    const open = new URL(at.href);
    open.host = `${HOSTS[i]}${PREVIEW}`;
    return { back: i + 1, at: c.at, open: open.href };
  });
  return { versions, unlisted: all - commits.length };
}

// A request on an earlier version's host: the board's only, its cycle's files as they were n changes back. Its review
// mode is the scroll link alone (no notes on a version that's gone), and /__hq-origin names HQ as on the cycles' host.
export async function serveEarlier(req: IncomingMessage, res: ServerResponse, back: number) {
  if (!opened(req, res, 'an earlier version')) return;
  const path = decoded(new URL(req.url ?? '/', 'http://x').pathname);
  if (path === '/__review/review.js')
    return reply(req, res, await readFile(`${REPO_DIR}/shared/watchalong/scrolllink.js`), 'text/javascript');
  if (path === '/__hq-origin') return reply(req, res, Buffer.from(ORIGIN), 'text/plain; charset=utf-8');
  const cycle = path && !path.includes('..') ? cycleOf(path) : null;
  const commit = cycle ? (await historyOf(cycle)).commits[back] : undefined;
  if (!commit) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('No such version.');
  const file = `products/_cycles${path!.endsWith('/') ? `${path}index.html` : path}`;
  const body = await read(commit.sha, file);
  if (!body) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  const type = typeOf(file) ?? 'application/octet-stream';
  reply(req, res, type.startsWith('text/html') ? Buffer.from(withReviewMode(body.toString('utf8'))) : body, type);
}
// A file as it was at a commit: git's, or a render's from the store by the sha256 its .render.json had then; null where
// the commit hasn't the path or the store hasn't the render any more (any other failure throws)
const missing = (e: { stderr?: Buffer; code?: string }) =>
  e.code === 'ENOENT' || /does not exist in|exists on disk, but not in/.test(String(e.stderr ?? ''));
const orMissing = (e: { stderr?: Buffer; code?: string }) => (missing(e) ? null : Promise.reject(e));
async function read(sha: string, file: string) {
  const shown = (path: string) => gitShow(sha, path).catch(orMissing);
  const body = await shown(file);
  if (body || !RENDERS) return body;
  const side = await shown(`${file}.render.json`);
  const hash = side && (JSON.parse(side.toString()) as { sha256?: string }).sha256;
  return hash && /^[0-9a-f]{64}$/.test(hash) ? readFile(`${RENDERS}/${hash}`).catch(orMissing) : null;
}
// The body whole, or the range asked for
function reply(req: IncomingMessage, res: ServerResponse, body: Buffer, type: string) {
  const range = rangeOf(req.headers.range, body.length);
  if (!range) return void res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end();
  const { start, end, partial } = range;
  res.writeHead(partial ? 206 : 200, {
    'content-type': type,
    'accept-ranges': 'bytes',
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
}
