#!/usr/bin/env node
// The Pencil's post-it on HQ never stands over the ink being drawn, nor does its strip: on an iPad mini on its side and
// a phone, a line drawn low on the page brings the post-it up top, clear of it; a line drawn high leaves it at the foot;
// a line at 55% on the phone goes up top too, whole; a ring round the Today card on the iPad, where neither end clears
// the whole post-it, folds it to its head and words, as does a second line at 40% after one high up, and it's whole
// again once that line is undone. The strip shows with the
// ink, at the page's other end from the post-it, clear of an installed iPhone's status bar and home bar, and far enough
// off the ink that the mark's next line, started beside the first, draws. --shots dir adds the strip on a call in every
// HQ look, light and dark, on the iPad mini both ways and a phone.
//   node shared/review/postit-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { playwright, errorsOf, until } from '../browser/browser.mjs';
import { serve } from '../../platform/hq/serve.mjs';
import { scriptForHq, fulfilPart } from './parts.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const reviewJs = scriptForHq('review/review.js', base);
const DEVICES = {
  'ipad-landscape': { width: 1133, height: 744, scale: 2 },
  'ipad-portrait': { width: 744, height: 1133, scale: 2 },
  phone: { width: 390, height: 844, scale: 3 },
  'installed phone': { width: 390, height: 844, scale: 3, insets: { top: 47, bottom: 34 } }, // (HQ on the home screen)
};
const browser = await playwright().chromium.launch();

// HQ on a device, in a look, with review mode loaded and its shadow root open for the check
async function hq(device, { look = 'wire', scheme = 'dark' } = {}) {
  const { width, height, scale, insets } = DEVICES[device];
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    hasTouch: true,
    colorScheme: scheme,
  });
  await context.addInitScript(() => {
    const a = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (o) {
      return a.call(this, { ...o, mode: 'open' });
    };
  });
  await context.route(`${base}/__review/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, reviewJs)) return;
    return r.fulfill({ json: { show: false } });
  });
  const page = await context.newPage();
  const errors = errorsOf(page);
  const cdp = await context.newCDPSession(page);
  if (insets) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
  await page.goto(`${base}/?intro=0&renderer=${look}`);
  await until(page, '#loading.gone');
  await page.waitForFunction(
    () => document.querySelector('review-mode')?.shadowRoot.querySelectorAll('.strip .pot').length === 5,
    null,
    { timeout: 20_000 },
  );
  const pen = async points => {
    const at = ([x, y], type, buttons, force) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons,
        clickCount: 1,
        pointerType: 'pen',
        force,
      });
    await at(points[0], 'mousePressed', 1, 0.4);
    for (const p of points.slice(1)) await at(p, 'mouseMoved', 1, 0.5);
    await at(points.at(-1), 'mouseReleased', 0, 0);
  };
  const box = async s => {
    const b = await page.locator('review-mode').locator(s).boundingBox();
    return b && { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  // How much of the ink layer is drawn in a box (CSS px): its opaque pixels
  const inked = b =>
    page.evaluate(({ x, y, w, h }) => {
      const c = document.querySelector('review-mode').shadowRoot.querySelector('canvas.ink'),
        k = c.width / innerWidth,
        d = c.getContext('2d').getImageData(x * k, y * k, w * k, h * k).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n;
    }, b);
  const photoShows = () => page.locator('review-mode').locator('.sheet .polaroid').isVisible();
  return { page, errors, pen, box, inked, photoShows, close: () => context.close() };
}
// A wavy line across the page at a height, and the box round its ink (its width and white edge: 8 px)
const wave = (w, y) => Array.from({ length: 30 }, (_, i) => [w * 0.15 + (w * 0.7 * i) / 29, y + Math.sin(i / 3) * 20]);
const inkBox = points => {
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]);
  return {
    x: Math.min(...xs) - 8,
    y: Math.min(...ys) - 8,
    w: Math.max(...xs) - Math.min(...xs) + 16,
    h: Math.max(...ys) - Math.min(...ys) + 16,
  };
};
const apart = (a, b) => a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x;

// A ring round a box, closed where it starts
const ring = (cx, cy, rx, ry) =>
  Array.from({ length: 41 }, (_, i) => [
    cx + rx * Math.cos((i / 40) * 2 * Math.PI),
    cy + ry * Math.sin((i / 40) * 2 * Math.PI),
  ]);
// [what's drawn, the post-it's end, whether it folds, the line]
const CASES = {
  'ipad-landscape': [
    ['a line drawn low', 'up', false, ({ width, height }) => wave(width, height * 0.72)],
    ['a line drawn high', 'foot', false, ({ width, height }) => wave(width, height * 0.25)],
    ['a ring round the Today card', 'foot', true, () => ring(310, 330, 260, 60)],
  ],
  phone: [
    ['a line drawn low', 'up', false, ({ width, height }) => wave(width, height * 0.72)],
    ['a line drawn high', 'foot', false, ({ width, height }) => wave(width, height * 0.4)],
    ['a line at 55%', 'up', false, ({ width, height }) => wave(width, height * 0.55)],
  ],
  'installed phone': [
    ['a line drawn low', 'up', false, ({ width, height }) => wave(width, height * 0.72)],
    ['a line drawn high', 'foot', false, ({ width, height }) => wave(width, height * 0.4)],
  ],
};

for (const [device, cases] of Object.entries(CASES)) {
  const { width, height, insets = { top: 0, bottom: 0 } } = DEVICES[device];
  for (const [what, end, folds, drawn] of cases) {
    const h = await hq(device);
    const line = drawn(DEVICES[device]),
      ink = inkBox(line);
    await h.pen(line);
    await h.page.waitForFunction(
      () => !document.querySelector('review-mode').shadowRoot.querySelector('.sheet').hidden,
    );
    await h.page.waitForTimeout(500); // (its pop)
    const sheet = await h.box('.sheet'),
      strip = await h.box('.bar .strip');
    assert.ok(apart(sheet, ink), `${device}, ${what}: the post-it stands clear of it`);
    assert.equal(await h.photoShows(), !folds, `${device}, ${what}: the post-it ${folds ? 'folded' : 'whole'}`);
    assert.ok(strip && apart(strip, ink), `${device}, ${what}: the strip shows with the ink, clear of it`);
    assert.ok(apart(sheet, strip), `${device}, ${what}: the strip clear of the post-it`);
    const below = b => b.y >= ink.y + ink.h;
    assert.equal(below(sheet), end === 'foot', `${device}, ${what}: the post-it at the ${end}`);
    assert.notEqual(below(strip), below(sheet), `${device}, ${what}: the strip on the far side of the ink`);
    const gap = below(strip) ? strip.y - (ink.y + ink.h) : ink.y - (strip.y + strip.h);
    assert.ok(gap >= 60, `${device}, ${what}: the strip ${Math.round(gap)} px off the ink, clear of the next line`);
    assert.ok(
      strip.y >= insets.top && strip.y + strip.h <= height - insets.bottom,
      `${device}, ${what}: the strip clear of the safe area`,
    );
    // the mark's next line, started 35 px past the first on the strip's side, draws
    const ys = line.map(p => p[1]),
      y = below(strip) ? Math.max(...ys) + 35 : Math.min(...ys) - 35,
      next = { x: width * 0.3, y: y - 6, w: width * 0.4, h: 12 },
      before = await h.inked(next);
    await h.pen(Array.from({ length: 10 }, (_, i) => [width * (0.33 + (0.34 * i) / 9), y]));
    await h.page.waitForTimeout(300);
    assert.ok((await h.inked(next)) > before + 100, `${device}, ${what}: the next line, 35 px past it, draws`);
    if (end === 'foot') assert.ok(sheet.y + sheet.h > height - 40, `${device}, ${what}: the post-it at the foot`);
    if (shots) await h.page.screenshot({ path: `${shots}/postit-${device}-${what.replaceAll(' ', '-')}.png` });
    assert.deepEqual(h.errors, []);
    await h.close();
  }
}

// ---- folded for a second line, and whole again once it's undone
{
  const { width, height } = DEVICES['ipad-landscape'],
    h = await hq('ipad-landscape'),
    sheetShows = () =>
      h.page.waitForFunction(() => !document.querySelector('review-mode').shadowRoot.querySelector('.sheet').hidden);
  await h.pen(wave(width, height * 0.2));
  await sheetShows();
  assert.equal(await h.photoShows(), true, 'iPad: a line drawn high leaves the post-it whole');
  await h.pen(wave(width, height * 0.4)); // (just above the whole post-it at the foot)
  await h.page.waitForTimeout(300);
  assert.equal(await h.photoShows(), false, 'iPad: a second line at 40% folds the post-it');
  await h.page.locator('review-mode').locator('.strip .undo').click();
  await h.page.waitForTimeout(300);
  assert.equal(await h.photoShows(), true, 'iPad: that line undone, the post-it is whole again');
  assert.deepEqual(h.errors, []);
  await h.close();
}

// ---- the strip on a call, in every look, light and dark, on each device (pictures only)
if (shots)
  for (const device of Object.keys(DEVICES))
    for (const look of ['wire', 'brownstone', 'holo'])
      for (const scheme of ['light', 'dark']) {
        await strip(device, look, scheme).catch(() => strip(device, look, scheme)); // (once more: a look's WebGL can crash)
      }

console.log('postit-check: the post-it stands clear of the ink being drawn, and the strip shows with it');
await browser.close();
server.close();

// The strip on a call on one device in a look, pictured
async function strip(device, look, scheme) {
  const h = await hq(device, { look, scheme });
  await h.page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('call:on', { detail: { call: 5, agent: 'juno', name: 'Juno', color: '#7b5ea7' } }),
    ),
  );
  const { width, height } = DEVICES[device];
  await h.pen(wave(width, height * 0.5));
  await h.page.waitForTimeout(300);
  await h.page.screenshot({ path: `${shots}/strip-${device}-${look}-${scheme}.png` });
  await h.close();
}
