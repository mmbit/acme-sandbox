#!/usr/bin/env node
// The call's screen pictures show the board's screen as it is: on the real coordinator, the board's HQ in the company's
// look (and in the wire's) on an iPad-sized screen shows its screen on a live call, and each picture the call's agent
// gets (the voice line's screen tool, from the mirror) is held against the board's own screenshot of the same moment,
// part by part. Three screens, each with something a replay draws unlike the page unless the mirror puts it right:
//   1. the call's notes with the agent's own drawing on a post-it, drawn and opened while the screen is shown (a
//      picture HQ serves only behind the board's sign-in, loaded after the element showing it): it shows, never broken,
//      and HQ's type around it (the page's title, the HUD's counters) is the board's, never a serif or system face,
//      in the wire's look too (its Google font, as the brownstone's);
//   2. the Shelf open (a modal dialog, which review mode's controls move into): no black pen across it, and the Shelf
//      in the look's own wood (the look's rules follow <body>);
//   3. a picture only the board's page could load: marked as not captured, never shown broken.
// Screenshots side by side with --shots.
//   node platform/hq/callshot-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launched, playwright } from '../../shared/browser/browser.mjs';
import { coordinator } from './book/guestserver.mjs';
import { fulfilResponse } from './book/originroute.mjs';
import { FONT_FILES, STYLESHEETS } from '../../shared/watchalong/fonthosts.js';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const shots = arg('--shots');
if (shots) mkdirSync(shots, { recursive: true });
// the board's iPad on its side
const IPAD = { width: 1180, height: 820 };
// A part of the screen (a cell of a GRID) differs when its mean difference, 0 to 255 a channel, passes PART_OFF: a
// moving cloud or a walking figure in the building stays well under it, a broken picture or a black shape is far over
const GRID = { columns: 12, rows: 8 },
  PART_OFF = 40;
// A line of HQ's type (a box from its words on, CSS px of the board's screen) is in the board's face when its ink (its
// pixels darker than INK, 0 to 255: the type's own colour, not the muted grey's) spans as wide as the board's, to
// TYPE_OFF of it: the same letters drawn at the agent's picture's size came out up to 2% off, another face 8% or more
// (a look's fallback for its Google font: the wire's 8%, the brownstone's 13%; the serif or system face in HQ's place
// 13 to 17%). The ink runs from the first letter to the first gap of WORDS_GAP px with none (a chip's border is none:
// no letters): wider than the space between two words (11 px at most, the counters' grey dot between them), narrower
// than the space to the next chip's words (27 px).
const INK = 80,
  WORDS_GAP = 16,
  TYPE_OFF = 0.05;
// the not-captured mark's grey (mirrorpage.ts .unshown), and how far the agent's picture's mean colour in a box may be
// from what it should be there (that grey, or the board's own screen's)
const MARK = [234, 231, 224],
  MARK_OFF = 30;
// the mirror's Chromium: Playwright's, unless one is named
process.env.CHROMIUM_PATH ??= playwright().chromium.executablePath();

const { h, origin } = await coordinator();
const browser = await launched({ args: ['--disable-dev-shm-usage'] }); // (the worker's /dev/shm is 64 MB)
assert.ok(browser, 'no Chromium for Playwright');
const said = r => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
// A blank page of the check's own, for drawing and comparing pictures
const scratch = await (await browser.newContext()).newPage();

// The board's HQ on its iPad in a look, signed in: HQ's own origin answered by the coordinator, nothing else reached
// but Google's fonts (the look's), and a picture only the board's page can load (ONLY_HERE, red: no file of HQ's). HQ's
// notes' pictures come LATE_MS after they're asked for, past a batch of the recording's (watchalong.js FLUSH_MS): a
// picture that loads on the board's network after the element showing it reached the mirror
const ONLY_HERE = '/only-on-this-device/photo.png',
  LATE_MS = 1500;
async function boardsIpad(look) {
  const red = Buffer.from(await scratch.evaluate(redPicture), 'base64');
  const context = await browser.newContext({ viewport: IPAD, hasTouch: true, ignoreHTTPSErrors: true });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if ([STYLESHEETS, FONT_FILES].includes(url.hostname)) return route.fallback();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
    if (url.pathname === ONLY_HERE) return route.fulfill({ contentType: 'image/png', body: red });
    if (url.pathname === '/api/notebooks/pictures') await new Promise(resolve => setTimeout(resolve, LATE_MS));
    const response = await route.fetch({
      url: h.base + url.pathname + url.search,
      headers: { ...route.request().headers(), host: url.host },
      maxRedirects: 0,
    });
    return fulfilResponse(route, response);
  });
  const [name, value] = h.boardCookie.split('=');
  await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const listening = page.waitForRequest(r => new URL(r.url()).pathname === '/api/events', { timeout: 90_000 });
  await page.goto(`${origin}/?renderer=${look}`);
  await listening;
  await page.locator('#hint.gone').waitFor({ state: 'attached', timeout: 30_000 }); // (HQ's first hint fades by then)
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}
function redPicture() {
  const c = Object.assign(document.createElement('canvas'), { width: 200, height: 120 });
  const g = c.getContext('2d');
  g.fillStyle = '#d0443a';
  g.fillRect(0, 0, 200, 120);
  return c.toDataURL('image/png').split(',')[1];
}

// The board's screen now and the agent's picture of it, kept with --shots: the parts of the screen, each { column,
// row, off } (off: their mean difference), each one's mean colour in a box (CSS px of the board's screen): the
// agent's picture's (mean) and the board's (boards), and the mean difference in each box of type (types)
async function compared(board, call, name, box = { x: 0, y: 0, width: 1, height: 1 }, types = []) {
  await board.waitForTimeout(1500);
  const mine = await board.screenshot();
  await board.waitForTimeout(1500); // (the page's batch with it posted, once a second, and played in the mirror)
  const theirs = Buffer.from(
    said(await h.voice('screen', { purpose: 'call', ref: String(call) })).picture.data,
    'base64',
  );
  if (shots) {
    writeFileSync(`${shots}/${name}-board.png`, mine);
    writeFileSync(`${shots}/${name}-agent.jpg`, theirs);
  }
  const fractions = box => ({
    x: box.x / IPAD.width,
    y: box.y / IPAD.height,
    w: box.width / IPAD.width,
    h: box.height / IPAD.height,
  });
  return scratch.evaluate(held, {
    mine: `data:image/png;base64,${mine.toString('base64')}`,
    theirs: `data:image/jpeg;base64,${theirs.toString('base64')}`,
    grid: GRID,
    box: fractions(box),
    types: types.map(fractions),
    INK,
    gap: WORDS_GAP / IPAD.width,
  });
}
// (in the scratch page: both pictures at the agent's picture's size)
async function held({ mine, theirs, grid, box, types, INK, gap }) {
  const load = async src => {
    const img = Object.assign(new Image(), { src });
    await img.decode();
    return img;
  };
  const [a, b] = await Promise.all([load(mine), load(theirs)]);
  const w = b.naturalWidth,
    hgt = b.naturalHeight;
  const pixels = img => {
    const c = Object.assign(document.createElement('canvas'), { width: w, height: hgt });
    c.getContext('2d').drawImage(img, 0, 0, w, hgt);
    return c.getContext('2d').getImageData(0, 0, w, hgt).data;
  };
  const [p, q] = [pixels(a), pixels(b)];
  const over = (x0, y0, x1, y1, add) => {
    for (let y = Math.floor(y0); y < y1; y += 2) for (let x = Math.floor(x0); x < x1; x += 2) add((y * w + x) * 4);
  };
  const parts = [];
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++) {
      let sum = 0,
        n = 0;
      const [x0, x1] = [column, column + 1].map(c => (c * w) / grid.columns),
        [y0, y1] = [row, row + 1].map(r => (r * hgt) / grid.rows);
      over(x0, y0, x1, y1, i => {
        for (let k = 0; k < 3; k++) sum += Math.abs(p[i + k] - q[i + k]);
        n += 3;
      });
      parts.push({ column, row, off: Math.round(sum / n) });
    }
  const meanOf = pixels => {
    const mean = [0, 0, 0];
    let n = 0;
    over(box.x * w, box.y * hgt, (box.x + box.w) * w, (box.y + box.h) * hgt, i => {
      for (let k = 0; k < 3; k++) mean[k] += pixels[i + k];
      n++;
    });
    return mean.map(v => Math.round(v / Math.max(1, n)));
  };
  // (where a box's dark letters reach from the first one, its ink: the width they span, in the picture's px, up to a
  // gap with none)
  const inkIn = (pixels, box) => {
    // (a column with letters in it: a border runs the box's whole height, letters never do)
    const inked = x => {
      let rows = 0,
        dark = 0;
      for (let y = Math.floor(box.y * hgt); y < (box.y + box.h) * hgt; y++, rows++) {
        const i = (y * w + x) * 4;
        if (0.3 * pixels[i] + 0.59 * pixels[i + 1] + 0.11 * pixels[i + 2] < INK) dark++;
      }
      return dark > 0 && dark < rows;
    };
    let [left, right] = [-1, -1];
    for (let x = Math.floor(box.x * w); x < Math.min(w, (box.x + box.w) * w); x++) {
      if (!inked(x)) {
        if (left >= 0 && x - right > gap * w) break;
        continue;
      }
      if (left < 0) left = x;
      right = x;
    }
    return right - left + 1;
  };
  return { parts, mean: meanOf(q), boards: meanOf(p), types: types.map(box => [inkIn(q, box), inkIn(p, box)]) };
}
// The parts of the screen a box (CSS px of the board's screen) covers
const partsOf = box => {
  const cell = { w: IPAD.width / GRID.columns, h: IPAD.height / GRID.rows };
  return part =>
    part.column * cell.w < box.x + box.width &&
    (part.column + 1) * cell.w > box.x &&
    part.row * cell.h < box.y + box.height &&
    (part.row + 1) * cell.h > box.y;
};
const differing = (parts, except = () => false) => parts.filter(p => p.off > PART_OFF && !except(p));

// The board's screen shown on the call, as the call screen's Show my screen starts it (callscreen.js startWatch)
async function showScreen(board, call, key) {
  await board.evaluate(
    async ({ call, key }) => {
      const r = await fetch('/api/watchalong/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ call, key }),
      });
      const { events } = await r.json();
      const { watch } = await import('/shared/watchalong/watchalong.js');
      window.shown = watch({ url: events, typed: 'shown', canvasFps: 0.5 });
    },
    { call, key },
  );
}
// The agent's drawing (a blue card, an orange sun) on a post-it in the call's notes, open on the board's iPad
async function notesWithDrawing(board, call) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#3da2e0"/><circle cx="160" cy="100" r="70" fill="#e8772a"/></svg>';
  said(await h.voice('drawing', { call, svg }));
  await openNotes(board, call);
}
// The call's notes open on the board's iPad, its pictures shown
async function openNotes(board, call) {
  const notes = said(await h.board('/api/notebooks/call', { call })).page;
  await board.evaluate(at => import('/shell/ink/book.js').then(m => m.openAt(at)), {
    page: notes.id,
    notebook: notes.notebook,
  });
  await board
    .locator('.bk-photo img')
    .first()
    .evaluate(img => img.decode(), undefined, { timeout: 30_000 });
  await board.waitForTimeout(1500);
}

// HQ's type: the call page's title (the Notebook's own face, a font HQ serves) and the HUD's counters (the look's), each
// a box of its words, twice as wide, as a wider face runs on past them
const TYPES = [
  ["the call page's title", '#book .bk-page-title'],
  ["the HUD's counters", '#status .flow-words > span'],
];
// The board's screen now and the agent's picture of it, as compared, with HQ's type held against the board's
async function typed(board, call, name, box) {
  const typeBoxes = await Promise.all(
    TYPES.map(async ([, at]) => {
      const box = await board
        .locator(at)
        .first()
        .evaluate(words => {
          const range = document.createRange();
          range.selectNodeContents(words);
          return range.getBoundingClientRect().toJSON();
        });
      return { x: box.x, y: box.y, width: Math.min(2 * box.width, IPAD.width - box.x), height: box.height };
    }),
  );
  const seen = await compared(board, call, name, box, typeBoxes);
  seen.types.forEach(([agents, boards], i) =>
    assert.ok(
      Math.abs(agents / boards - 1) <= TYPE_OFF,
      `${name}: ${TYPES[i][0]} isn't in the board's type in the agent's picture (its ink ${agents} px wide, ` +
        `the board's ${boards})`,
    ),
  );
  return seen;
}

let { context, page: board, errors } = await boardsIpad('brownstone');
try {
  const { call, key } = await h.liveCall('juno');
  await showScreen(board, call, key);
  await notesWithDrawing(board, call);

  const photo = await board.locator('.bk-photo img').first().boundingBox();
  const onNotes = await typed(board, call, '1-notes', photo);
  assert.deepEqual(differing(onNotes.parts.filter(partsOf(photo))), [], "the agent's drawing isn't the board's");
  // (a drawing of thin lines on the post-it differs from the not-captured mark by less than a part's PART_OFF)
  const drawn = Math.max(...onNotes.mean.map((v, k) => Math.abs(v - onNotes.boards[k])));
  assert.ok(drawn < MARK_OFF, `the agent's drawing isn't the board's (${onNotes.mean}, the board's ${onNotes.boards})`);
  assert.deepEqual(differing(onNotes.parts), [], "the agent's picture of the notes isn't the board's screen");
  console.log("ok 1: the notes with the agent's drawing on a post-it, in HQ's own type, as the board sees them");

  await board.evaluate(() => import('/shell/ink/bookshelfwindow.js').then(m => m.openShelf()));
  await board.locator('.bk-shelf-window[open]').waitFor({ timeout: 30_000 });
  const onShelf = await compared(board, call, '2-shelf');
  assert.deepEqual(differing(onShelf.parts), [], "the agent's picture of the open Shelf isn't the board's screen");
  console.log('ok 2: the Shelf open, as the board sees it');

  const only = { x: 40, y: 120, width: 200, height: 120 };
  await board.evaluate(
    ({ src, at }) => {
      const img = Object.assign(document.createElement('img'), { src, alt: '' });
      const place = { left: `${at.x}px`, top: `${at.y}px`, width: `${at.width}px`, height: `${at.height}px` };
      Object.assign(img.style, { position: 'fixed', zIndex: 5, ...place });
      document.body.append(img);
      return img.decode();
    },
    { src: ONLY_HERE, at: only },
  );
  const marked = await compared(board, call, '3-not-captured', { x: 60, y: 140, width: 160, height: 80 });
  assert.deepEqual(
    differing(marked.parts, partsOf(only)),
    [],
    "the agent's picture isn't the board's screen around it",
  );
  const off = Math.max(...marked.mean.map((v, k) => Math.abs(v - MARK[k])));
  assert.ok(off < MARK_OFF, `a picture the mirror couldn't load isn't marked as not captured (${marked.mean})`);
  console.log('ok 3: a picture only the board could load, marked as not captured');
  assert.deepEqual(errors, []);

  // (the wire's look: the board's HQ opened again in it, showing its screen anew)
  await context.close();
  ({ context, page: board, errors } = await boardsIpad('wire'));
  await showScreen(board, call, key);
  await openNotes(board, call);
  await typed(board, call, '1-notes-wire');
  console.log("ok 1, the wire's look: the notes in HQ's own type, as the board sees them");
  assert.deepEqual(errors, []);
  console.log("PASS the call's screen pictures show the board's screen as it is");
} finally {
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await browser.close();
  h.server.closeAllConnections();
  h.server.close();
}
process.exit(0);
