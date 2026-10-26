#!/usr/bin/env node
// Artifacts' covers: a colour screenshot of each artifact, framed square to fill its tile in HQ's Artifacts. The
// company's list (a JSON file of its own) says, for each, where its picture goes (`picture`, a path from the repo's
// root, which the artifact's own file names as its `picture`) and what to shoot:
//   preview: "<slug>", page: "/path"   a product's preview page, through an `hq preview` pass this tool asks for
//   page: "products/…/index.html"      a page in the repo (a cycle's, or its folder), served from the repo here
//   hq: "/?…"                          HQ itself in dev mode on its mock data, in the company's theme
//   url: "http://localhost:…/"         any address, with `start`, a command (from the repo's root) that serves it
// and how: `width` and `height` (the window, 1000 by 1000 unless said; `phone: true` holds it like a phone, 430 wide),
// `ready` (a selector to wait for: a widget's script loaded), `hide` (CSS selectors hidden: a banner over it),
// `background` (a colour behind the page: a picture's own, around one opened by itself), `click`
// (a selector pressed first: a chat opened), `wheel` (a mouse wheel turned that far over what's clicked: a sketch
// zoomed out), `wait` (ms after the page settles, for an entrance or a canvas), `hold` (keys held down in turn after
// it, each for its ms: a sketch steered) and `at` (a CSS selector: the cover is that element's middle square, a
// section's picture). Without one the cover is the window's top square (`frame: "middle"`: its middle), its width
// across. Saved as a 640 px square JPEG.
//   node platform/hq/covers.mjs <list.json> [--only <picture>]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../coordinator/node_modules/yaml/dist/index.js';
import { serve, ROOT } from './serve.mjs';
import { serve as serveRepo } from '../../shared/demo/core.mjs';
import { playwright } from '../../shared/browser/browser.mjs';
import { authenticatePreview } from '../../shared/demo/preview.mjs';

const SIZE = 640; // the saved cover's side: twice the widest tile HQ shows, or more
const [listFile, ...rest] = process.argv.slice(2),
  only = rest[0] === '--only' ? rest[1] : null;
if (!listFile) throw new Error('usage: node platform/hq/covers.mjs <list.json> [--only <picture>]');
const all = JSON.parse(await readFile(listFile, 'utf8')).filter(c => !only || c.picture === only);

// A product's pages are shot under its own pass: run once per product under `hq preview`, which gives this run the pass
// in its environment alone.
const passOf = process.env.HQ_PREVIEW_URL && new URL(process.env.HQ_PREVIEW_URL).hostname.split('.')[0];
if (!passOf)
  for (const slug of new Set(all.filter(c => c.preview).map(c => c.preview))) {
    const args = [fileURLToPath(import.meta.url), listFile, ...(only ? ['--only', only] : [])];
    const run = spawnSync('hq', ['preview', slug, '--', process.execPath, ...args], { stdio: 'inherit' });
    if (run.status) process.exitCode = 1;
  }
const covers = all.filter(c => (passOf ? c.preview === passOf : !c.preview));

// The servers a cover `start`s, each its own process group: stopped after its shot, or when this run is stopped
const groups = new Set();
const stopStarted = () => {
  for (const pid of groups)
    try {
      process.kill(-pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error; // (one that ended by itself, which its shot has said)
    }
  groups.clear();
};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopStarted();
    process.exit(128 + constants.signals[signal]);
  });
const files = covers.some(c => c.page && !c.preview) ? await serveRepo() : null;
const hq = covers.some(c => c.hq) ? await themed() : null;
const browser = await playwright().chromium.launch();
try {
  for (const cover of covers) {
    try {
      await shoot(cover);
      console.log(`${cover.picture}: shot`);
    } catch (error) {
      console.error(`${cover.picture}: ${error.message}`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
  files?.close();
  hq?.close();
}

async function shoot(cover) {
  const width = cover.width ?? (cover.phone ? 430 : 1000),
    height = cover.height ?? width;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: !!cover.phone,
    hasTouch: !!cover.phone,
    reducedMotion: 'reduce',
  });
  const started = cover.start ? begin(cover.start) : null;
  try {
    const url = cover.preview
      ? new URL(cover.page ?? '/', process.env.HQ_PREVIEW_URL).href
      : cover.hq
        ? `http://127.0.0.1:${hq.address().port}${cover.hq}`
        : (cover.url ?? `${files.origin}/${cover.page}`);
    if (started) await answering(url);
    if (cover.preview) await authenticatePreview(context, url);
    const page = await context.newPage();
    const answer = await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    if (!answer?.ok()) throw new Error(`${url} answered ${answer?.status()}`);
    // (quiet for a moment, as far as a page that keeps a line open ever is)
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    // (a page whose parts come up after it, a server `start`ed with another behind it: loaded again until they're there)
    for (
      const end = Date.now() + 60_000;
      cover.ready && !(await page.$(cover.ready));
      await page.reload({ waitUntil: 'load' })
    )
      if (Date.now() > end) throw new Error(`${cover.ready} never came`);
      else await page.waitForTimeout(1000);
    const shot = await page.screenshot({
      type: 'png',
      clip: square(await posed(page, cover), width, height, cover.frame),
    });
    // (a server that ended, on a port another holds, say: what answered isn't it)
    if (started && (started.exitCode ?? started.signalCode) !== null) throw new Error(`${cover.start} ended`);
    const path = join(ROOT, cover.picture);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await resized(context, shot));
  } finally {
    await context.close();
    stopStarted();
  }
}
// The page as the cover shows it, with the box of the element it frames (null for the window)
async function posed(page, cover) {
  if (cover.hide) await page.addStyleTag({ content: `${cover.hide} { visibility: hidden !important; }` });
  if (cover.background)
    await page.addStyleTag({ content: `html, body { background: ${cover.background} !important; }` });
  if (cover.click) await page.locator(cover.click).first().click();
  if (cover.wheel) await page.mouse.wheel(0, cover.wheel);
  const at = cover.at && page.locator(cover.at).first();
  const centre = () => at?.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await centre();
  await page.waitForTimeout(cover.wait ?? 500);
  for (const [key, ms] of Object.entries(cover.hold ?? {})) {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  }
  // (again, once what's above it has loaded and moved it)
  await centre();
  return at ? at.boundingBox() : null;
}
// A server a cover `start`s, a command run from the repo's root in a process group of its own
function begin(command) {
  const child = spawn(command, { shell: true, cwd: ROOT, stdio: 'ignore', detached: true });
  groups.add(child.pid);
  return child;
}
// The square the cover is: the middle of the element framed (as much of it as the window shows, its box rounded inward
// so no edge of the page around it shows), or the window's top (its middle)
function square(box, width, height, frame) {
  if (!box) {
    const side = Math.min(width, height);
    return { x: (width - side) / 2, y: frame === 'middle' ? (height - side) / 2 : 0, width: side, height: side };
  }
  const left = Math.max(0, Math.ceil(box.x)),
    top = Math.max(0, Math.ceil(box.y)),
    across = Math.min(width, Math.floor(box.x + box.width)) - left,
    down = Math.min(height, Math.floor(box.y + box.height)) - top;
  const side = Math.min(across, down);
  return {
    x: left + Math.floor((across - side) / 2),
    y: top + Math.floor((down - side) / 2),
    width: side,
    height: side,
  };
}
// The shot at the cover's size, smoothed down in a page of its own (none of the artifact's rules on it)
async function resized(context, png) {
  const page = await context.newPage();
  const jpeg = await page.evaluate(
    async ([data, size]) => {
      const picture = new Image();
      picture.src = `data:image/png;base64,${data}`;
      await picture.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
      const drawing = canvas.getContext('2d');
      drawing.imageSmoothingQuality = 'high';
      drawing.drawImage(picture, 0, 0, size, size);
      return canvas.toDataURL('image/jpeg', 0.84).split(',')[1];
    },
    [png.toString('base64'), SIZE],
  );
  return Buffer.from(jpeg, 'base64');
}
// a server `start`ed for the shot, once it answers (a minute at most)
async function answering(url) {
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise(wake => setTimeout(wake, 500)))
    if (
      await fetch(url).then(
        () => true,
        () => false,
      )
    )
      return;
  throw new Error(`${url} never answered`);
}

// HQ in dev mode, worn as the company wears it (theme/hq.yaml over the mock brand)
async function themed() {
  const theme = await readFile(join(ROOT, 'theme/hq.yaml'), 'utf8').then(parse, () => null);
  const brand = JSON.parse(await readFile(join(ROOT, 'platform/hq/mock/brand.json'), 'utf8'));
  if (theme) brand.theme = { ...brand.theme, ...theme };
  return serve(undefined, 0, { 'mock/brand.json': JSON.stringify(brand) });
}
