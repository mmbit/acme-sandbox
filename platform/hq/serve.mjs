#!/usr/bin/env node
// HQ in dev mode (no /api, so it runs on its mock data), its files as the coordinator serves them: the company's own
// under theme/hq/ (its logo, icons, mock data) over the foundation's in platform/hq/, and its HQ apps from kits/. The checks serve HQ with it; for a
// look of your own: node platform/hq/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// read: a path from the repo's root → its bytes (the working tree's, or a commit's); files: bytes that stand in for a path
export async function serve(read = p => readFile(join(ROOT, p)), port = 0, files = {}) {
  const server = createServer(async (req, res) => {
    const asked = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1), path = !asked || asked.endsWith('/') ? `${asked}index.html` : asked;
    // (and a company's own HQ apps at /kits/<name>/…, from kits/<name>/hq/)
    const kit = /^kits\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(path);
    // (and the keys' motion, the statistics and the signs Slate shares, shared/tactile/, shared/stats/ and shared/signs/
    // with the contrast sums it imports.)
    const sharedKit = /^shared\/(tactile|stats|signs|contrast)\/[a-z]+\.js$/.test(path);
    // (and review mode's framing rule, which HQ's note thumbnails import, the platform's sound kit, its button that asks
    // once more and its contrast sums, and the holidays' table and the shared formats the clock imports)
    const review = { '__review/frame.js': 'shared/review/frame.js', 'foley.js': 'shared/demo/foley.js', 'ask.js': 'shared/ask/ask.js', 'contrast.js': 'shared/contrast/contrast.js',
      'shared/holidays/holidays.js': 'shared/holidays/holidays.js', 'shared/format/format.js': 'shared/format/format.js' }[path];
    const body = path.includes('..') ? null : files[path] ?? await (kit ? read(`kits/${kit[1]}/hq/${kit[2]}`) : review ? read(review) : sharedKit ? read(path)
      : read(`theme/hq/${path}`).catch(() => read(`platform/hq/${path}`))).catch(() => null);
    res.writeHead(body ? 200 : 404, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  });
  await new Promise(r => server.listen(port, r));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`HQ in dev mode: http://localhost:${(await serve(undefined, Number(process.argv[2] ?? 8000))).address().port}/`);
