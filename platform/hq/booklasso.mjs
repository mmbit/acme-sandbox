// book-check.mjs's story of a lasso on a page drawn like the board's sketches (--stories lasso, --webkit for the
// iPad's engine): a face in pen with a thick scribbled brow, handwriting and marker fills scribbled back and forth, as
// many points as a Pencil reports. The Pencil on Select circles the face and lets go: the face is picked, and the
// loop and its release each keep up, timed and printed for the record. The eraser rubbed through the brow and a fill
// on the same page, at a Pencil's rate, each frame's work timed, the marker
// fill it cut through still one even colour. And the marker scribbled back and
// forth over one small place for ten seconds, as the board coloured in a tongue, at a Pencil's rate: each frame's work
// and the lift timed, the fill one even colour.
import assert from 'node:assert/strict';
import { freePage, paperBox, savedWhere } from './bookmouse.mjs';
import { MINI, heard, pressAlong } from './bookkit.mjs';
import { MARKERS, MARKER_ALPHA } from './shell/ink/bookinkmath.js';

// c: book-check.mjs's played store and helpers
export function lassoStories(c) {
  return {
    'a lasso round a page of marker fills on an iPad mini: drawn and let go without a stall, the face picked':
      browser => lasso(browser, c),
    'the eraser rubbed through a thick brow and a marker fill on an iPad mini: it keeps up with the pen, the ink gone where it went':
      browser => rubbed(browser, c),
    'the marker scribbled back and forth for ten seconds on an iPad mini: it keeps up with the pen and its lift, one even colour':
      browser => scribbled(browser, c),
  };
}

async function lasso(browser, c) {
  const free = freePage(c);
  free.ink.push(...face());
  const context = await c.hqIn(browser, MINI, { hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    await page.locator('#book .bk-strip').getByRole('button', { name: 'Select', exact: true }).tap();
    const drawn = await page.locator('#book canvas.bk-ink').first().boundingBox(),
      paper = await paperBox(page);
    const started = Date.now();
    await pressAlong(page, loopRound(drawn, paper), { lift: false });
    const loopMs = Date.now() - started;
    // (in the page's clock: two frames with nothing to do, then the lift's own work and the two frames after it)
    const release = await page.evaluate(async () => {
      const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      let t = performance.now();
      await frames();
      const idle = performance.now() - t;
      t = performance.now();
      window.__lift();
      const lift = performance.now() - t;
      await frames();
      return { idle, lift, shown: performance.now() - t };
    });
    const ms = n => `${Math.round(n)} ms`;
    console.log(
      `  lasso: ${points(free.ink)} points on the page, the loop drawn in ${ms(loopMs)}; let go: its work ` +
        `${ms(release.lift)}, the frame shown after ${ms(release.shown)} (two frames at rest: ${ms(release.idle)})`,
    );
    await page.locator('#book .bk-sel').waitFor();
    const frame = await page.locator('#book .bk-sel').boundingBox();
    assert.ok(frame.width > drawn.width / 2 && frame.height > drawn.height / 2, 'the face is picked');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// A Pencil's moves a frame (240 a second at 60 frames) and how far apart (CSS px: a brisk rub, 480 px a second)
const MOVES = 4,
  MOVE_PX = 2;

async function rubbed(browser, c) {
  const free = freePage(c);
  free.ink.push(...face());
  const context = await c.hqIn(browser, MINI, { hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    await page.locator('#book .bk-strip').getByRole('button', { name: 'Eraser', exact: true }).tap();
    const at = await page.evaluate(onScreen, rub());
    const before = await inked(page),
      twiceBefore = await page.evaluate(markerTwice, FACE_MARKER);
    const paper = await paperBox(page);
    assert.ok(
      at.every(
        ([x, y]) => x > paper.x + 40 && x < paper.x + paper.width - 60 && y > paper.y && y < paper.y + paper.height,
      ),
      'the rub is on the paper, clear of the tools',
    );
    await pressAlong(page, at.slice(0, 1), { lift: false });
    const took = await page.evaluate(timedAlong, { at, MOVES, MOVE_PX });
    const sorted = took.work.slice().sort((a, b) => a - b),
      ms = n => `${Math.round(n)} ms`;
    const after = await inked(page);
    console.log(
      `  eraser: ${points(free.ink)} points on the page, ${sorted.length} frames of ${MOVES} moves; each frame's work ` +
        `${ms(sorted[sorted.length >> 1])} (median), ${ms(sorted[Math.floor(sorted.length * 0.9)])} (90%), ` +
        `${ms(sorted.at(-1))} (worst), a frame with no moves ${ms(took.idle)}; ${before - after} inked px of ` +
        `${before} rubbed out`,
    );
    assert.ok(before - after > before / 20, 'the eraser took ink where it went');
    // (the marker fill it went through cut in pieces that lie over one another all along: still one even colour, its
    // colour laid twice only where another fill of it already lay.)
    const twice = await page.evaluate(markerTwice, FACE_MARKER);
    assert.ok(twice <= twiceBefore, `the marker one even colour: ${twice} px of it laid twice, ${twiceBefore} before`);
    const whole = await asWhole(page);
    // (a clipped paint's soft edges may shade apart from a whole one's: at most 64 in WebKit, 80 in Chromium at a pixel
    // or two. A coat of the marker missing or left behind on paper is 107, a pen's line 255.)
    assert.ok(whole.most <= 96, `painted only where it went, the page as painted whole: ${JSON.stringify(whole)}`);
    assert.ok((await page.evaluate(markerTwice, FACE_MARKER)) <= twiceBefore, 'one even colour painted whole too');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
// The marker scribbled over one small place on the face, back and forth for ten seconds as the board coloured in the
// tongue (2,400 moves at a Pencil's rate): nearly all its earlier passes lie under each new point, so a live line that
// fills again whatever reaches the new points' box does work that grows with the stroke. Each frame's work and the
// lift timed; the fill saved whole and one even colour.
async function scribbled(browser, c) {
  const free = freePage(c);
  free.ink.push(...face());
  // (at the iPad mini's own two device px a CSS px: a fill's work is mostly its pixels)
  const context = await c.hqIn(browser, MINI, { hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
    await markerInHand(page);
    const at = await page.evaluate(onScreen, tongue()),
      paper = await paperBox(page);
    assert.ok(
      at.every(
        ([x, y]) => x > paper.x + 40 && x < paper.x + paper.width - 60 && y > paper.y && y < paper.y + paper.height,
      ),
      'the scribble is on the paper, clear of the tools',
    );
    const ink = free.ink.length,
      twiceBefore = await page.evaluate(markerTwice, MARKERS[0].color);
    await pressAlong(page, at.slice(0, 1), { lift: false });
    const took = await page.evaluate(timedAlong, { at, MOVES, MOVE_PX });
    const sorted = took.work.slice().sort((a, b) => a - b),
      ms = n => `${Math.round(n)} ms`,
      tenth = Math.round(took.work.length / 10),
      median = some => some.sort((a, b) => a - b)[some.length >> 1];
    const saved = await savedWhere(c, free.id, p => p.ink.length === ink + 1),
      fill = saved.ink.at(-1);
    console.log(
      `  marker: ${points(free.ink.slice(0, ink))} points on the page, a fill of ${fill.points.length} points in ` +
        `${sorted.length} frames of ${MOVES} moves; each frame's work ${ms(sorted[sorted.length >> 1])} (median), ` +
        `${ms(sorted[Math.floor(sorted.length * 0.9)])} (90%), ${ms(sorted.at(-1))} (worst), the first tenth's ` +
        `${ms(median(took.work.slice(0, tenth)))} and the last tenth's ${ms(median(took.work.slice(-tenth)))} ` +
        `(median), a frame with no moves ${ms(took.idle)}; the lift's work ${ms(took.lift)}, its ` +
        `frame shown after ${ms(took.shown)}`,
    );
    assert.equal(fill.alpha, MARKER_ALPHA, 'drawn with the marker');
    assert.ok(fill.points.length > 1500, `the fill kept as drawn: ${fill.points.length} points`);
    const twice = await page.evaluate(markerTwice, MARKERS[0].color);
    assert.ok(twice <= twiceBefore, `the fill one even colour: ${twice} px of it laid twice, ${twiceBefore} before`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
// The marker picked in the pen's card (the pen in use tapped again), its card put away again (the pen and the marker are
// one key on the tools: bookpalette.js.)
async function markerInHand(page) {
  const ink = page.locator(
      "#book [data-island=tools] .bk-btn:is([data-mode='pen'], [data-mode='highlighter']):not([data-spare])",
    ),
    card = page.locator('#book .bk-palette');
  await ink.tap();
  if (!(await card.isVisible())) await ink.tap();
  await card.getByRole('menuitemradio', { name: 'Marker', exact: true }).tap();
  await page.keyboard.press('Escape');
  await card.waitFor({ state: 'detached' });
}
// (in the page) Page px on the screen, from the unit's canvas: its place on the page and on the screen
function onScreen(points) {
  const canvas = document.querySelector('#book canvas.bk-ink'),
    r = canvas.getBoundingClientRect(),
    k = r.width / parseFloat(canvas.style.width);
  const [left, top] = [parseFloat(canvas.style.left), parseFloat(canvas.style.top)];
  return points.map(([x, y]) => [r.x + (x - left) * k, r.y + (y - top) * k]);
}
// (in the page) The pressed eraser or pen along the points, MOVES moves a frame, then let go: each frame's work, its
// moves and the next frame's paint, timed between a callback asked for before the moves and one after, so the
// browser's own wait for a frame is left out; the same with no moves, what a frame costs on its own (the median of 20);
// and the lift's own work and the frame after it
async function timedAlong({ at, MOVES, MOVE_PX }) {
  const held = window.__pressed,
    moves = [];
  for (let i = 1; i < at.length; i++) {
    const [[x0, y0], [x1, y1]] = [at[i - 1], at[i]],
      n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / MOVE_PX));
    for (let k = 1; k <= n; k++) moves.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  // (act's own work, own, and that with the next frame's paint, shown.)
  const timed = act => {
    let painting = 0;
    requestAnimationFrame(() => (painting = performance.now()));
    const t = performance.now();
    act();
    const own = performance.now() - t;
    return new Promise(done => requestAnimationFrame(() => done({ own, shown: own + performance.now() - painting })));
  };
  const moved = these => () => {
    for (const m of these) {
      held.send('pointermove', m, 0.6);
      held.last = m;
    }
  };
  const step = async these => (await timed(moved(these))).shown;
  const work = [],
    idle = [];
  await step([]);
  for (let i = 0; i < moves.length; i += MOVES) work.push(await step(moves.slice(i, i + MOVES)));
  for (let i = 0; i < 20; i++) idle.push(await step([]));
  const { own: lift, shown } = await timed(() => window.__lift());
  return { work, idle: idle.sort((a, b) => a - b)[10], lift, shown };
}
// What differs once the page is painted whole (Undo and Redo on the bar, which paint all of it again): inkAgainst's
async function asWhole(page) {
  await page.evaluate(inkAgainst, true);
  const bar = page.locator('#book .bk-bar');
  const tap = async name => {
    await bar.getByRole('button', { name, exact: true }).tap();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    return page.evaluate(inkAgainst, false);
  };
  assert.ok((await tap('Undo')).n > 1000, 'Undo puts the rubbed ink back');
  return tap('Redo');
}
// (in the page) The ink canvases' pixels at each page px, kept (keep) or compared with those kept: { n: how many
// differ, most: the most a pixel's ink differs (its alpha), box: where }
function inkAgainst(keep) {
  const now = new Map();
  for (const canvas of document.querySelectorAll('#book canvas.bk-ink')) {
    const k = canvas.width / parseFloat(canvas.style.width),
      [left, top] = [parseFloat(canvas.style.left), parseFloat(canvas.style.top)],
      { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let px = 0; px < data.length / 4; px++)
      if (data[px * 4 + 3])
        now.set(`${left + (px % canvas.width) / k},${top + Math.floor(px / canvas.width) / k}`, [
          ...data.slice(px * 4, px * 4 + 4),
        ]);
  }
  if (keep) return void (window.__inkWas = now);
  const was = window.__inkWas,
    none = [0, 0, 0, 0],
    box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const some = []; // (every 50th, as the page painted whole has it for what was shown)
  let n = 0,
    most = 0;
  for (const key of new Set([...now.keys(), ...was.keys()])) {
    const [a, b] = [now.get(key) ?? none, was.get(key) ?? none],
      d = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    if (!d) continue;
    if (n++ % 50 === 0) some.push(`${key}: ${a} for ${b}`);
    most = Math.max(most, Math.abs(a[3] - b[3]));
    const [x, y] = key.split(',').map(Number);
    Object.assign(box, {
      x0: Math.min(box.x0, x),
      y0: Math.min(box.y0, y),
      x1: Math.max(box.x1, x),
      y1: Math.max(box.y1, y),
    });
  }
  return { n, most, box, some };
}
// (in the page) The pixels of a marker's colour laid twice: its 0.42 laid once is alpha 107, twice 169, its colour
// within 20 a channel (one marker over another's is neither)
function markerTwice(color) {
  const want = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  let n = 0;
  for (const canvas of document.querySelectorAll('#book canvas.bk-ink')) {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] > 150 && want.every((v, c) => Math.abs(data[i + c] - v) < 20)) n++;
  }
  return n;
}
// The inked pixels on the page's canvases
const inked = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('#book canvas.bk-ink')].reduce((n, canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 3; i < data.length; i += 4) if (data[i] > 24) n++;
      return n;
    }, 0),
  );
// The eraser's way on the page (its px, the face's box from (60, 60)): back and forth through the brow's thick lines,
// then down through the middle marker fill and back up, as a hand rubs
function rub() {
  const at = (x, y) => [60 + x, 60 + y];
  const brow = Array.from({ length: 41 }, (_, i) =>
      at(110 + 150 * Math.abs(((i / 20) % 2) - 1), 115 + 12 * Math.sin(i)),
    ),
    fill = Array.from({ length: 31 }, (_, i) =>
      at(200 + 50 * Math.sin(i * 1.3), 290 + 85 * Math.abs(((i / 15) % 2) - 1)),
    );
  return [...brow, ...fill];
}

// The marker's way on the page (its px, the face's box from (60, 60)): a tongue under the fills, scribbled across 60 px
// and back 40 times, going down and up its 50 px twice, 4,800 px in all (ten seconds at the rub's pace)
function tongue() {
  const at = (x, y) => [60 + x, 60 + y];
  return Array.from({ length: 81 }, (_, i) => at(190 + 60 * (i % 2), 415 + 50 * Math.abs(((i / 20) % 2) - 1)));
}

const points = ink => ink.reduce((n, s) => n + s.points.length, 0);

// The face's marker fills' colour
const FACE_MARKER = MARKERS.find(m => m.name === 'Pink').color;

// The board's kind of sketch, in a 440 × 480 px box from (60, 60) on its page: 24 pen lines of 300 points, a brow of six
// thick lines scribbled over one another, a greeting written in 12 strokes, and three marker fills scribbled back and
// forth for ten seconds each (a Pencil's 240 points a second)
function face() {
  const at = (x, y, i) => [round(60 + x), round(60 + y), 0.5 + 0.2 * Math.sin(i / 9), i * 4];
  const line = (n, size, xy, more = {}) => ({
    color: '#2a2352',
    size,
    ...more,
    points: Array.from({ length: n }, (_, i) => at(...xy(i), i)),
  });
  const pen = Array.from({ length: 24 }, (_, s) =>
    line(300, 5, i => [
      220 + 150 * Math.cos(s) + 50 * Math.cos(i / 50),
      260 + 160 * Math.sin(s) + 35 * Math.sin(i / 40),
    ]),
  );
  const brow = Array.from({ length: 6 }, (_, s) =>
    line(900, 9, i => [100 + (240 * (i % 300)) / 300, 120 + 12 * Math.sin(i / 7) + s]),
  );
  const greeting = Array.from({ length: 12 }, (_, s) =>
    line(150, 2.5, i => [20 + s * 30 + 12 * Math.sin(i / 10), 10 + i * 0.5]),
  );
  const marker = { color: FACE_MARKER, alpha: MARKER_ALPHA };
  const fills = Array.from({ length: 3 }, (_, s) =>
    line(
      2400,
      28,
      i => [120 + s * 70 + 60 * Math.abs(((i / 50) % 2) - 1), 330 + 40 * Math.sin(i / 300) + (i % 7)],
      marker,
    ),
  );
  return [...pen, ...brow, ...greeting, ...fills];
}
const round = n => Math.round(n * 100) / 100;

// A loop round a box on the screen, kept on the paper, a point every 4 px as a Pencil reports a quick loop, closing a
// little past its start as a hand does
function loopRound(box, paper) {
  const x0 = Math.max(box.x - 20, paper.x + 10),
    y0 = Math.max(box.y - 20, paper.y + 10),
    x1 = Math.min(box.x + box.width + 20, paper.x + paper.width - 10),
    y1 = Math.min(box.y + box.height + 20, paper.y + paper.height - 10);
  const [cx, cy, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2],
    n = Math.round((Math.PI * (rx + ry)) / 4);
  return Array.from({ length: Math.round(n * 1.08) }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}
