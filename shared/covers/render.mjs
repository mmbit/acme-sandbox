#!/usr/bin/env node
// Renders pixel art covers: each cover.js (next to a post's index.md) becomes the cover.png beside it.
//   node shared/covers/render.mjs knowledge/posts/<slug>/cover.js [more…]
//   node shared/covers/render.mjs --all          every knowledge/posts/*/cover.js
//   node shared/covers/render.mjs <cover.js> --recent[=6]   also a sheet: the new cover first, then the feed's last six
//     (the flag goes after the files: before them it takes the first file as its count)
//   node shared/covers/render.mjs --recent      the feed's last six alone, to look at before drawing
//   node shared/covers/render.mjs <x.js…> --out=<dir> --scale=<n> --sheet   any drawings (a theme's covers): each
//     written as <dir>/<x>.png instead of beside it, each pixel n × n (square, unsmoothed), and a sheet of only these
// Prints each file it wrote. Guideline: shared/covers/README.md.
// (--out, --scale and --sheet, so a theme's covers render here, not in a copy)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname, relative, join, basename } from 'node:path';
import { args, playwright } from '../demo/core.mjs';
import { createRequire } from 'node:module';
import { deflateSync, crc32 } from 'node:zlib';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const a = args();
// In the Gazette's order: by `published`, else the date in the slug (platform/coordinator/src/company.ts, gazette()).
const published = s => readFileSync(`${root}/knowledge/posts/${s}/index.md`, 'utf8').match(/^published:\s*['"]?([^'"\n]+)/m)?.[1].trim() ?? s.slice(0, 10);
const posts = readdirSync(`${root}/knowledge/posts`).filter(s => existsSync(`${root}/knowledge/posts/${s}/index.md`))
  .map(s => [published(s), s]).sort(([x], [y]) => x.localeCompare(y)).map(([, s]) => `knowledge/posts/${s}/cover.js`).filter(f => existsSync(`${root}/${f}`));
const files = a.all ? posts : a._;
if (!files.length && !a.recent) { console.error('usage: render.mjs <cover.js…> [--recent] [--out=<dir>] [--scale=<n>] [--sheet] | --all | --recent'); process.exit(1); }
const scale = Number(a.scale ?? 1);
if (!Number.isInteger(scale) || scale < 1) { console.error(`--scale must be a whole number of pixels, not "${a.scale}"`); process.exit(1); }
if (a.out) mkdirSync(resolve(a.out), { recursive: true });

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
const drawn = []; // (each cover at 1x, for the sheet)
for (const f of files) {
  const src = relative(root, resolve(f));
  await page.goto(`http://localhost:${port}/shared/covers/page.html?src=${encodeURIComponent(src)}`);
  const png = await page.waitForFunction(() => window.done, null, { timeout: 10000 }).then(h => h.jsonValue());
  drawn.push(png);
  const out = a.out ? join(resolve(a.out), basename(src).replace(/\.js$/, '.png')) : resolve(root, src.replace(/\.js$/, '.png'));
  writeFileSync(out, pngOf(await pixels(), scale));
  console.log(relative(process.cwd(), out));
}
if (a.recent) console.log(await sheet(drawn, recent(a.recent === true ? 6 : +a.recent)));
else if (a.sheet) console.log(await sheet(drawn, []));
await browser.close(); server.close();

// The cover on the page, pixel by pixel (RGBA)
async function pixels() {
  const { width, height, data } = await page.evaluate(() => {
    const c = document.getElementById('c'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return { width: c.width, height: c.height, data: btoa(Array.from(d, b => String.fromCharCode(b)).join('')) };
  });
  return { width, height, data: Buffer.from(data, 'base64') };
}

// A PNG of the picture with each pixel n × n, square and unsmoothed. A cover's few colours (HQ's palette) go in a
// palette PNG, a few KB even at 8x, where the browser's full-colour one is three times that; more than 256 in RGBA.
function pngOf({ width, height, data }, n) {
  const colours = new Map(), index = new Uint8Array(width * height);
  for (let i = 0; i < width * height && colours.size <= 256; i++) {
    const rgba = data.readUInt32BE(i * 4);
    if (!colours.has(rgba)) colours.set(rgba, colours.size);
    index[i] = colours.get(rgba);
  }
  const palette = colours.size <= 256, bytes = palette ? 1 : 4, W = width * n, H = height * n;
  // each row: filter 0, then its pixels (the row n times, each pixel n times)
  const rows = Buffer.alloc((W * bytes + 1) * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = Math.floor(y / n) * width + Math.floor(x / n), at = y * (W * bytes + 1) + 1 + x * bytes;
      if (palette) rows[at] = index[i];
      else data.copy(rows, at, i * 4, i * 4 + 4);
    }
  const chunk = (type, body) => {
    const typed = Buffer.concat([Buffer.from(type), body]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    tail.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(W, 0);
  header.writeUInt32BE(H, 4);
  [header[8], header[9]] = [8, palette ? 3 : 6]; // (8 bits; palette or RGBA)
  const keys = [...colours.keys()];
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', Buffer.from(keys.flatMap(k => [k >>> 24, (k >>> 16) & 255, (k >>> 8) & 255])))] : []),
    ...(palette && keys.some(k => (k & 255) < 255) ? [chunk('tRNS', Buffer.from(keys.map(k => k & 255)))] : []),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The feed's last few covers, the ones just drawn left out
function recent(count) {
  const mine = files.map(f => relative(root, resolve(f)).replace(/\.js$/, '.png'));
  return posts.map(f => f.replace(/\.js$/, '.png')).filter(f => !mine.includes(f) && existsSync(`${root}/${f}`)).slice(-count).map(f => '/' + f);
}

// The covers just drawn first, each at 3x, three a row on HQ's ink; with others after them (the feed's last few: does
// the new one repeat their set-up?), the new ones framed in gold
async function sheet(mine, others) {
  await page.goto(`http://localhost:${port}/`);
  const png = await page.evaluate(async ({ mine, others }) => {
    const all = [...mine, ...others], S = 3, PAD = 6, cols = 3, w = 128 * S, h = 72 * S;
    const c = document.createElement('canvas');
    c.width = cols * (w + PAD) + PAD; c.height = Math.ceil(all.length / cols) * (h + PAD) + PAD;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    g.fillStyle = '#1d1a2f'; g.fillRect(0, 0, c.width, c.height);
    for (const [i, src] of all.entries()) {
      const img = new Image(); img.src = src; await img.decode();
      const x = PAD + (i % cols) * (w + PAD), y = PAD + Math.floor(i / cols) * (h + PAD);
      if (others.length && i < mine.length) { g.fillStyle = '#ffd966'; g.fillRect(x - 3, y - 3, w + 6, h + 6); }
      g.drawImage(img, x, y, w, h);
    }
    return c.toDataURL('image/png');
  }, { mine, others });
  const out = join(mkdtempSync(join(tmpdir(), 'covers-')), others.length ? 'recent.png' : 'sheet.png');
  writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
  return out;
}
