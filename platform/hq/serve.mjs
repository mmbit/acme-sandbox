#!/usr/bin/env node
// HQ in dev mode (no /api, so it runs on its mock data), its files as the coordinator serves them: the company's own
// under theme/hq/ (its logo, icons, mock data) over the foundation's in platform/hq/, and its HQ apps from kits/. The checks serve HQ with it; for a
// look of your own: node platform/hq/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
  const server = createServer(async (req, res) => {
    // An address that doesn't parse (`//`, a broken escape like `/a%`) gets a 400, so it doesn't stop the server.
    const asked = addressOf(req.url);
    if (asked === null) return res.writeHead(400).end();
    const path = !asked || asked.endsWith('/') ? `${asked}index.html` : asked;
    // (and a company's own HQ apps at /kits/<name>/…, from kits/<name>/hq/)
    const kit = /^kits\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(path);
    // (and the files outside platform/hq its pages load by their address, extras.mjs, with every part of review mode's,
    // as the board gets them on HQ's host.)
    const extra = extraFile(EXTRAS, `/${path}`) ?? (/^__review\/[a-z]+\.js$/.test(path) ? `shared/review/${path.slice('__review/'.length)}` : undefined);
    // (and the looks HQ ships, read from their folders, and the company's tip films.)
    const listed = path === 'renderers/looks.json' ? looks() : path === 'films/films.json' ? filmFiles(join(ROOT, 'theme/hq')) : null;
    const body = path.includes('..') ? null : files[path] ?? (listed ? JSON.stringify(listed) : await (kit ? read(`kits/${kit[1]}/hq/${kit[2]}`) : extra ? read(extra)
      : read(`theme/hq/${path}`).catch(() => read(`platform/hq/${path}`))).catch(() => null));
    res.writeHead(body ? 200 : 404, { 'content-type': typeOf(path) ?? 'application/octet-stream' }).end(body);
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r)); // (this machine's alone.)
  return server;
}

// a request's address → its path from the root, decoded, or null when it doesn't parse
function addressOf(url) {
  try {
    return decodeURIComponent(new URL(url, 'http://x').pathname).slice(1);
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`HQ in dev mode: http://127.0.0.1:${(await serve(undefined, Number(process.argv[2] ?? 8000))).address().port}/`);
