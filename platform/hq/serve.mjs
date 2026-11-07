#!/usr/bin/env node
// HQ in dev mode (no /api, so it runs on its mock data), its files as the coordinator serves them: the company's own
// under theme/hq/ (its logo, icons, mock data) over the foundation's in platform/hq/, and its HQ apps from kits/. The checks serve HQ with it; for a
// look of your own: node platform/hq/serve.mjs [port]
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { looks } from './looks.mjs';
import { filmFiles } from './films/listing.mjs';
import { typeOf } from '../coordinator/src/types.ts'; // (the types the coordinator serves HQ's files with.)
import { BOARD_EXTRAS, OPEN_EXTRAS, REVIEW_PARTS, extraFile } from './extras.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EXTRAS = { ...BOARD_EXTRAS, ...OPEN_EXTRAS, ...REVIEW_PARTS };

// read: a path from the repo's root → its bytes (the working tree's, or a commit's); files: bytes that stand in for a path
export async function serve(read = p => readFile(join(ROOT, p)), port = 0, files = {}) {
  const server = createServer(answer(read, files));
  await new Promise(r => server.listen(port, '127.0.0.1', r)); // (this machine's alone.)
  return server;
}
// ...its answer to a request, which the coordinator gives a try's version on its own host too (ink/trypreview.ts); root:
// the checkout its listings (looks, films) come from
export function answer(read, files = {}, root = ROOT) {
  return async (req, res) => {
    // An address that doesn't parse (`//`, a broken escape like `/a%`) gets a 400, so it doesn't stop the server.
    const asked = addressOf(req.url);
    if (asked === null) return res.writeHead(400).end();
    const path = pathOf(asked);
    // (and the looks HQ ships, read from their folders, and the company's tip films.)
    const listed = path === 'renderers/looks.json' ? looks(join(root, 'platform/hq')) : path === 'films/films.json' ? filmFiles(join(root, 'theme/hq')) : null;
    const body = path.includes('..') ? null : files[path] ?? (listed ? JSON.stringify(listed) : await firstRead(read, sourcesOf(path)));
    res.writeHead(body ? 200 : 404, { 'content-type': typeOf(path) ?? 'application/octet-stream' }).end(body);
  };
}

// A path from the root → the files its answer reads, in the order it tries them: a company's own HQ apps at
// /kits/<name>/…, from kits/<name>/hq/; the files outside platform/hq its pages load by their address (extras.mjs), with
// every part of review mode's, as the board gets them on HQ's host; else the company's own over the foundation's
function sourcesOf(path) {
  const kit = /^kits\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(path);
  if (kit) return [`kits/${kit[1]}/hq/${kit[2]}`];
  const extra = extraFile(EXTRAS, `/${path}`) ?? (/^__review\/[a-z]+\.js$/.test(path) ? `shared/review/${path.slice('__review/'.length)}` : undefined);
  return extra ? [extra] : [`theme/hq/${path}`, `platform/hq/${path}`];
}
// ...the first of them there is, or null
async function firstRead(read, paths) {
  for (const path of paths) {
    const body = await read(path).catch(() => null);
    if (body !== null) return body;
  }
  return null;
}
// ...and the repo files an address on the dev server answers from (none where nothing does), for the checks that note
// which files a page used (shared/browser/touched.mjs): a built answer's sources (mocks().sources), else the file read
export function servedFiles(url, built = {}, root = ROOT) {
  const asked = addressOf(url);
  if (asked === null || asked.includes('..')) return [];
  const path = pathOf(asked),
    read = sourcesOf(path).find(file => existsSync(join(root, file)));
  return built[path] ?? (read ? [read] : []);
}

// The brand dev mode serves (the company's mock/brand.json, else the foundation's), worn in the company's theme
// (theme/hq.yaml) when the repo has one: HQ as the company wears it, for the checks and tools that show it so
export async function mockBrand(root = ROOT) {
  return (await brandIn(root)).brand;
}
// ...with the files it's made of
async function brandIn(root) {
  const { parse } = await import('../coordinator/node_modules/yaml/dist/index.js'); // (only the tools that wear it need it)
  const sources = [];
  const read = p => readFile(join(root, p), 'utf8').then(text => (sources.push(p), text));
  const brand = JSON.parse(await read('theme/hq/mock/brand.json').catch(() => read('platform/hq/mock/brand.json')));
  const theme = await read('theme/hq.yaml').then(parse, () => null);
  if (theme) brand.theme = { ...brand.theme, ...theme };
  return { brand, sources };
}

// The files the checks serve over dev mode's: the brand as mockBrand() gives it, and the platform's mock data wherever
// the company's own list is empty, so every screen has something on it
export async function mockFiles(root = ROOT) {
  return (await mocks(root)).files;
}
// ...with the repo files each is built from, by its path
export async function mocks(root = ROOT) {
  const brand = await brandIn(root);
  const files = { 'mock/brand.json': JSON.stringify(brand.brand) },
    sources = { 'mock/brand.json': brand.sources };
  for (const name of (await readdir(join(root, 'theme/hq/mock')).catch(() => [])).filter(n => n.endsWith('.json'))) {
    const own = JSON.parse(await readFile(join(root, 'theme/hq/mock', name), 'utf8'));
    if (!Array.isArray(own) || own.length) continue;
    files[`mock/${name}`] = await readFile(join(root, 'platform/hq/mock', name)).catch(() => '[]');
    sources[`mock/${name}`] = [`theme/hq/mock/${name}`, `platform/hq/mock/${name}`];
  }
  return { files, sources };
}

const pathOf = asked => (!asked || asked.endsWith('/') ? `${asked}index.html` : asked);

// a request's address → its path from the root, decoded, or null when it doesn't parse
function addressOf(url) {
  try {
    return decodeURIComponent(new URL(url, 'http://x').pathname).slice(1);
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`HQ in dev mode: http://127.0.0.1:${(await serve(undefined, Number(process.argv[2] ?? 8000))).address().port}/`);
