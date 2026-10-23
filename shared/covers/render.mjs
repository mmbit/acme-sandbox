#!/usr/bin/env node
// Renders newsletter covers: each cover.js (next to a post's index.md) becomes the cover.png beside it.
//   node shared/covers/render.mjs knowledge/posts/<slug>/cover.js [more…]
//   node shared/covers/render.mjs --all          every knowledge/posts/*/cover.js
//   node shared/covers/render.mjs <cover.js> --recent[=6]   also a sheet: the new cover first, then the feed's last six
//     (the flag goes after the files: before them it takes the first file as its count)
//   node shared/covers/render.mjs --recent      the feed's last six alone, to look at before drawing
// Prints each file it wrote. Guideline: shared/covers/README.md.
// (--recent)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname, relative, join } from 'node:path';
import { args, playwright } from '../demo/core.mjs';
import { createRequire } from 'node:module';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const a = args();
// In the Gazette's order: by `published`, else the date in the slug (platform/coordinator/src/company.ts, gazette()).
const published = s => readFileSync(`${root}/knowledge/posts/${s}/index.md`, 'utf8').match(/^published:\s*['"]?([^'"\n]+)/m)?.[1].trim() ?? s.slice(0, 10);
const posts = readdirSync(`${root}/knowledge/posts`).filter(s => existsSync(`${root}/knowledge/posts/${s}/index.md`))
  .map(s => [published(s), s]).sort(([x], [y]) => x.localeCompare(y)).map(([, s]) => `knowledge/posts/${s}/cover.js`).filter(f => existsSync(`${root}/${f}`));
const files = a.all ? posts : a._;
if (!files.length && !a.recent) { console.error('usage: render.mjs <cover.js…> [--recent] | --all | --recent'); process.exit(1); }

const types = { '.js': 'text/javascript', '.html': 'text/html', '.yaml': 'text/plain', '.json': 'application/json' };
// The company's brand.yaml as JSON, for the kit's logo (YAML read with the coordinator's package, as the checks do).
const { parse } = createRequire(join(root, 'platform/coordinator/package.json'))('yaml');
const brandFile = join(root, 'company/brand.yaml');
const brand = JSON.stringify(existsSync(brandFile) ? parse(readFileSync(brandFile, 'utf8')) : {});
const server = createServer((req, res) => {
  const f = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (req.url === '/brand.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(brand); return; }
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>'); return; }
  if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
}).listen(0);
const port = server.address().port;

const browser = await playwright().chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.error(e.message));
for (const f of files) {
  const src = relative(root, resolve(f));
  await page.goto(`http://localhost:${port}/shared/covers/page.html?src=${encodeURIComponent(src)}`);
  const png = await page.waitForFunction(() => window.done, null, { timeout: 10000 }).then(h => h.jsonValue());
  const out = resolve(root, src.replace(/\.js$/, '.png'));
  writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
  console.log(relative(process.cwd(), out));
}
if (a.recent) console.log(await recentSheet(a.recent === true ? 6 : +a.recent));
await browser.close(); server.close();

// The new covers first, framed in gold, then the feed's last few, each at 3x: does the new one repeat their set-up?
async function recentSheet(count) {
  const mine = files.map(f => relative(root, resolve(f)).replace(/\.js$/, '.png'));
  const feed = posts.map(f => f.replace(/\.js$/, '.png')).filter(f => !mine.includes(f) && existsSync(`${root}/${f}`)).slice(-count);
  await page.goto(`http://localhost:${port}/`);
  const png = await page.evaluate(async ({ mine, feed }) => {
    const all = [...mine, ...feed], S = 3, PAD = 6, cols = 3, w = 128 * S, h = 72 * S;
    const c = document.createElement('canvas');
    c.width = cols * (w + PAD) + PAD; c.height = Math.ceil(all.length / cols) * (h + PAD) + PAD;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    g.fillStyle = '#1d1a2f'; g.fillRect(0, 0, c.width, c.height);
    for (const [i, src] of all.entries()) {
      const img = new Image(); img.src = '/' + src; await img.decode();
      const x = PAD + (i % cols) * (w + PAD), y = PAD + Math.floor(i / cols) * (h + PAD);
      if (i < mine.length) { g.fillStyle = '#ffd966'; g.fillRect(x - 3, y - 3, w + 6, h + 6); }
      g.drawImage(img, x, y, w, h);
    }
    return c.toDataURL('image/png');
  }, { mine, feed });
  const out = join(mkdtempSync(join(tmpdir(), 'covers-')), 'recent.png');
  writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
  return out;
}
