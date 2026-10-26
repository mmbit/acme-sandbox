#!/usr/bin/env node
// The book's stories as the board lives them, held like an iPad mini in WebKit (touch, 744 × 1133). One check for all of
// them; each thread adds its story here.
//   node platform/hq/book-check.mjs [--shots dir]
// The Pencil on HQ: a ring drawn on HQ's own page with a pen, no button first; nothing moves as the pen lifts (the line
// on screen just before is the line after, pixel for pixel but antialiasing); its number at the mark; the post-it with
// the words said while drawing, live from a stand-in voice line; Send puts the note on its sheet in the book (the
// anchor in document px, the words as spoken, a snip), and the mark stays numbered on the page. A finger's drag draws
// nothing. Held still, the pen takes a voice note there. A scribble wipes a mark, a two-finger tap brings it back. The
// ring, its number and Send again in Wire (?renderer=wire). And on a page of their own, every kind of line (pressure, a
// lift at no pressure, one crossing another, a highlighter) is the same wet as dry (shared/review/inkcheck.mjs).
// The book beside HQ's page, on an iPad mini and a desktop, in WebKit and Chromium (HQ in dev mode, on its mock data):
// HQ's page laid out in the room the book leaves (its toolbar whole, nothing of it under the book), the rail put, the
// book folded and brought back, spread, portrait starting folded, what's remembered after a reload, a page that grows
// as it's written down and New page starting the next.
// The Pencil on HQ's page, never over the book beside it, in WebKit and Chromium at iPad mini landscape: review mode's
// layer the page's width, a pen on the book's paper drawing nothing, the post-it and the pin on the page, over a dialog
// too, and the spread covering them with the page.
// The post-it where the book is folded away a scrap of the book, in both looks; pinched out, the day's pages side by
// side, then the week as a contact sheet, and back.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { serve, ROOT } from './serve.mjs';
import { playwright, errorsOf, until, openPage } from '../../shared/browser/browser.mjs';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { wetDry, STILL } from '../../shared/review/inkcheck.mjs';
import { callStory } from './bookcall.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (name, page) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const org = await (await fetch(`${base}/mock/org.json`)).json();
const reviewJs = (await readFile(`${ROOT}/shared/review/review.js`, 'utf8')).replace('{{HQ_ORIGIN}}', base);

// ---- the book's store, played (booknotes.ts): today's pages, notes numbered on their sheet, wiped
const pages = [],
  notes = [],
  posts = [],
  snips = new Map();
let ids = 0;
// (a call's page numbers its notes on its own sheet, never listed to send: bookcalls.ts)
const sheetOf = n => (pages.find(p => p.id === n.page)?.kind === 'call' ? `call ${n.page}` : 'sheet');
const sheetNotes = (sheet = 'sheet') => notes.filter(n => n.status === 'open' && sheetOf(n) === sheet);
const renumber = () => new Set(notes.map(sheetOf)).forEach(sheet => sheetNotes(sheet).forEach((n, i) => (n.n = i + 1)));
function store(path, body, q) {
  if (path === '/api/book') return { day: '2026-10-26', today: '2026-10-26', days: [], pages };
  if (path === '/api/book/page/new') {
    const page = { id: ++ids, ...body };
    pages.push(page);
    return page;
  }
  if (path === '/api/book/notes') return { notes: notes.filter(n => n.page === +q.get('page')) };
  if (path === '/api/book/sheets')
    return { open: [{ id: 1, owner: org.company.ceo, status: 'open', notes: sheetNotes() }], sent: [] };
  if (path === '/api/book/note') {
    const note = {
      id: ++ids,
      page: body.page,
      anchor: body.anchor,
      words: body.words,
      said: body.said,
      by: body.by ?? 'board',
      snip: body.snip ? `/api/book/snip?id=${ids}` : null,
      status: 'open',
    };
    if (body.snip) snips.set(note.id, body.snip);
    notes.push(note);
    renumber();
    return { note, sheet: { id: 1 } };
  }
  if (path === '/api/book/page/delete') {
    pages.splice(
      pages.findIndex(p => p.id === body.id),
      1,
    );
    return { ok: true };
  }
  if (path === '/api/book/note/delete') {
    notes.find(n => n.id === body.id).status = 'wiped';
    renumber();
    return { ok: true };
  }
  return null;
}

// ---- a stand-in voice line: the words come as the microphone's audio does
const SAID = ['Make this', 'Make this headline shorter'];
function voiceLine(ws) {
  let frames = 0,
    said = 0;
  ws.onMessage(m => {
    if (typeof m !== 'string') {
      frames += m.length;
      if (said < 1 && frames > 16000) ws.send(JSON.stringify({ type: 'heard', text: SAID[said++], partial: true }));
      return;
    }
    if (JSON.parse(m).type !== 'end') return;
    ws.send(JSON.stringify({ type: 'heard', text: SAID[1], partial: false }));
    ws.send(JSON.stringify({ type: 'done' }));
  });
}

const IPAD_MINI = { viewport: { width: 744, height: 1133 }, deviceScaleFactor: 2, hasTouch: true };
// HQ held like an iPad mini in a browser, its coordinator and voice line played
async function hqIn(browser, viewport = IPAD_MINI.viewport) {
  const context = await browser.newContext({
    ...IPAD_MINI,
    viewport,
    serviceWorkers: 'block',
    permissions: ['microphone'],
  });
  // review mode's closed shadow root opened, and a recorder for the microphone (the browser's own stand-in, once
  // allowed): Safari has MediaRecorder, Linux's headless WebKit doesn't (the words come over the live line, the clip is
  // only its fallback)
  await context.addInitScript(() => {
    const a = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (o) {
      return a.call(this, { ...o, mode: 'open' });
    };
    window.MediaRecorder ??= class {
      static isTypeSupported = type => type === 'audio/webm';
      state = 'inactive';
      mimeType = 'audio/webm';
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob([new Uint8Array(400)], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    };
  });
  await context.routeWebSocket(/\/__review\/dictate(\?.*)?$/, voiceLine);
  await context.route(`${base}/__review/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, reviewJs)) return;
    if (path === '/__review/mine') return r.fulfill({ json: { notes: 0, list: [], sent: false, more: false } });
    return r.fulfill({ json: { show: false } });
  });
  await context.route(`${base}/api/**`, async r => {
    const url = new URL(r.request().url()),
      body = r.request().method() === 'POST' ? r.request().postDataJSON() : null;
    if (url.pathname === '/api/org') return r.fulfill({ json: org });
    // (a call reads the board's language before it dials, and its Show starts a watch-along: nothing recorded here)
    if (url.pathname === '/api/language') return r.fulfill({ json: { lang: 'en' } });
    if (url.pathname === '/api/watchalong/start') return r.fulfill({ json: { id: 1, events: null } });
    if (url.pathname === '/api/book/snip') {
      const snip = snips.get(+url.searchParams.get('id'));
      return r.fulfill({ contentType: 'image/jpeg', body: Buffer.from(snip.split(',')[1], 'base64') });
    }
    if (body && url.pathname.startsWith('/api/book')) posts.push({ path: url.pathname, body });
    const answer = store(url.pathname, body, url.searchParams);
    if (answer) return r.fulfill({ json: answer });
    if (['/api/requests', '/api/gazette'].includes(url.pathname)) return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  return context;
}
// ---- the book beside HQ's page, a story at a time, in a browser: the failures counted, each one told
const MINI = { width: 1133, height: 744 },
  MINI_PORTRAIT = { width: 744, height: 1133 },
  DESKTOP = { width: 1440, height: 900 };
const SETTLE_MS = 700; // the book's slide (260 ms) and HQ laying itself out again after it

function STORIES() {
  return {
    'iPad mini landscape: the book open beside the page, HQ whole in it': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const seen = await sight(page);
        assert.equal(seen.mode, 'open');
        beside(seen);
        hqWhole(seen);
        await shot('book-landscape', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    "the book folds under the rail, the page grows, and a face's tap brings it back": async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const open = await sight(page);
        await page.click('#book [title^="Put the book away"]');
        await settled(page, 'folded');
        let seen = await sight(page);
        assert.equal(seen.mode, 'folded');
        assert.ok(seen.page > open.page, `the page stayed ${seen.page} px wide`);
        folded(seen);
        railStays(seen, open);
        hqWhole(seen);
        await shot('book-folded', page);
        await page.click('#book [title^="For "]');
        await settled(page, 'open');
        seen = await sight(page);
        assert.equal(seen.mode, 'open');
        assert.equal(seen.page, open.page, 'the page is back at its open width');
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'a flick of the spine to the right puts the book away; the rail edge pulled left brings it back': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const open = await sight(page);
        await drag(page, await spineAt(page), 120, 3);
        await settled(page, 'folded');
        assert.equal((await sight(page)).mode, 'folded');
        await drag(page, railMiddle(open), -240, 12);
        await settled(page, 'open');
        const seen = await sight(page);
        assert.equal(seen.mode, 'open');
        railStays(seen, open);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'the spine dragged left past half spreads the book over the screen, the rail still there': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const open = await sight(page);
        await drag(page, await spineAt(page), -260, 14);
        await settled(page, 'spread');
        const seen = await sight(page);
        assert.equal(seen.mode, 'spread');
        assert.ok(
          seen.book.left < open.page / 2 && seen.book.right <= seen.rail.left,
          `the spread is ${JSON.stringify(seen.book)}, beside a page of ${open.page}`,
        );
        railStays(seen, open);
        await shot('book-spread', page);
        await page.click('#book [title^="Put the book away"]');
        await settled(page, 'open');
        assert.equal((await sight(page)).page, open.page, 'the page is back at its open width');
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'portrait starts folded; pulled in, the book opens beside a narrower page, never over it': async browser => {
      const { page, errors, done } = await hq(browser, MINI_PORTRAIT);
      try {
        const start = await sight(page);
        assert.equal(start.mode, 'folded');
        folded(start);
        await drag(page, railMiddle(start), -260, 12);
        await settled(page, 'open');
        const seen = await sight(page);
        assert.equal(seen.mode, 'open');
        assert.ok(seen.page < start.page, `the page stayed ${seen.page} px wide`);
        beside(seen);
        railStays(seen, start);
        hqWhole(seen);
        await shot('book-portrait', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'turning the iPad keeps each shape its own: landscape open, portrait folded, landscape open again':
      async browser => {
        const { page, errors, done } = await hq(browser, MINI);
        try {
          const landscape = await sight(page);
          await page.setViewportSize(MINI_PORTRAIT);
          await settled(page, 'folded');
          let seen = await sight(page);
          assert.equal(seen.mode, 'folded');
          folded(seen);
          await page.setViewportSize(MINI);
          await settled(page, 'open');
          seen = await sight(page);
          assert.equal(seen.mode, 'open');
          assert.equal(seen.page, landscape.page, 'the page is back at its landscape width');
          assert.deepEqual(errors, []);
        } finally {
          await done();
        }
      },
    'remembered: folded stays folded after a reload, and the width the spine was dragged to': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const before = (await sight(page)).book.width;
        await drag(page, await spineAt(page), -60, 10);
        await page.waitForTimeout(SETTLE_MS);
        const wider = (await sight(page)).book.width;
        assert.ok(wider > before + 40, `dragged from ${before} to ${wider}`);
        await page.reload();
        await ready(page);
        assert.equal((await sight(page)).book.width, wider);
        await page.click('#book [title^="Put the book away"]');
        await settled(page, 'folded');
        await page.reload();
        await ready(page);
        assert.equal((await sight(page)).mode, 'folded');
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'a desktop: the book a column on the right, open, and HQ whole beside it': async browser => {
      const { page, errors, done } = await hq(browser, DESKTOP, { hasTouch: false });
      try {
        const seen = await sight(page);
        assert.equal(seen.mode, 'open');
        beside(seen);
        hqWhole(seen);
        await shot('book-desktop', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    "a page grows as it's written down": async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const paper = (await sight(page)).book,
          before = await pageAtMiddle(page, paper),
          stored = await storedPages(page);
        await write(page, paper.left + 60, MINI.height - 60);
        await page.waitForTimeout(SETTLE_MS);
        const after = await pageAtMiddle(page, paper);
        assert.ok(after.height > before.height, `the page stayed ${before.height} px tall`);
        const grown = (await storedPages(page)).find(p => p.h > stored.find(q => q.id === p.id).h);
        assert.ok(grown, 'no page grew in the store');
        assert.equal(grown.h, after.height);
        await shot('book-grown', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'New page starts the next: the row gets a page more, and writing on it keeps it': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const paper = (await sight(page)).book,
          row = await page.locator('#book section [data-kind]').count(),
          stored = (await storedPages(page)).length;
        await page.getByRole('button', { name: 'New page' }).click();
        await page.waitForTimeout(SETTLE_MS);
        assert.equal(await page.locator('#book section [data-kind]').count(), row + 1);
        const blank = await pageAtMiddle(page, paper);
        assert.ok(blank.left >= paper.left && blank.left < paper.left + 20, `the new page is at ${blank.left}`);
        assert.equal(blank.inked, false, 'the new page has ink on it');
        assert.equal((await storedPages(page)).length, stored, 'a page was kept before anything was written on it');
        await write(page, paper.left + 80, MINI.height / 2);
        await page.waitForTimeout(SETTLE_MS);
        const kept = await storedPages(page);
        assert.equal(kept.length, stored + 1);
        assert.equal(kept[kept.length - 1].strokes, 1);
        await shot('book-new-page', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    "pinched out, the day's pages side by side; again, the week as a contact sheet; a page tapped, or pinched in, back":
      async browser => {
        const { page, errors, done } = await hq(browser, MINI);
        try {
          const paper = (await sight(page)).book,
            today = (await storedPages(page)).length;
          await pinch(page, paper, 0.5);
          let far = await farView(page);
          assert.equal(far.level, 'day', 'one pinch out shows the day');
          assert.equal(far.days.length, 1);
          assert.equal(far.days[0].frames.length, today, "every page of the day's");
          const row = far.days[0].frames;
          assert.ok(
            row.every((f, i) => !i || (f.top === row[0].top && f.left > row[i - 1].right)),
            `side by side: ${JSON.stringify(row)}`,
          );
          assert.ok(
            row.every(f => f.left >= paper.left && f.right <= paper.left + paper.width),
            'all in the book',
          );
          assert.ok(
            row.every(f => f.inked),
            'each with its ink',
          );
          await shot('book-pinch-day', page);
          await pinch(page, paper, 0.5);
          far = await farView(page);
          assert.equal(far.level, 'week', 'again, the week');
          assert.deepEqual(
            far.days.map(d => d.name),
            ['Today', far.days[1]?.name].filter(Boolean),
            'a row a day with pages, the latest first',
          );
          assert.ok(far.days.length >= 2, "the week has the day before's pages too");
          assert.ok(far.days[1].frames[0].top > far.days[0].frames[0].top, 'its days in rows, a contact sheet');
          await shot('book-pinch-week', page);
          // a page tapped there opens it in the book, on its own day
          await page.locator('#book [data-level=week] .bk-frame').last().click();
          await page.waitForTimeout(SETTLE_MS);
          assert.equal((await farView(page)).level, undefined, 'a page tapped goes back to the page');
          assert.equal(await page.locator('#book .bk-when').textContent(), far.days[1].name, 'on its own day');
          // and a pinch in comes back from the day
          await pinch(page, paper, 0.5);
          assert.equal((await farView(page)).level, 'day');
          await pinch(page, paper, 2);
          assert.equal((await farView(page)).level, undefined, 'a pinch in goes back to the page');
          assert.deepEqual(
            errors.filter(e => !/can not be found here|No active pointer with the given id/.test(e)),
            [],
          );
        } finally {
          await done();
        }
      },
  };
}

// Two fingers on the book's paper, apart and then closing to (or opening to) k of that, as Safari hands them over
const pinch = (page, paper, k) =>
  page.evaluate(
    async ([x, y, k]) => {
      const on = document.querySelector('#book .bk-far:not([hidden])') ?? document.querySelector('#book .bk-desk');
      const at = (type, id, dx) =>
        on.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            isPrimary: id === 21,
            clientX: x + dx,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      at('pointerdown', 21, -90);
      at('pointerdown', 22, 90);
      for (let i = 1; i <= 8; i++) {
        const d = 90 * (1 + ((k - 1) * i) / 8);
        at('pointermove', 21, -d);
        at('pointermove', 22, d);
        await new Promise(res => setTimeout(res, 20));
      }
      at('pointerup', 21, 0);
      at('pointerup', 22, 0);
      await new Promise(res => setTimeout(res, 700));
    },
    [paper.left + paper.width / 2, MINI.height / 2, k],
  );
// The view pinched out: its level ('day', 'week' or none), and its days' names and frames (boxes, and ink drawn)
const farView = page =>
  page.evaluate(() => {
    const far = document.querySelector('#book .bk-far');
    return {
      level: far.hidden ? undefined : far.dataset.level,
      days: [...far.querySelectorAll('.bk-far-day')].map(d => ({
        name: d.querySelector('b').textContent,
        frames: [...d.querySelectorAll('.bk-frame')].map(f => {
          const r = f.getBoundingClientRect(),
            c = f.querySelector('canvas');
          return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), inked: c.width > 0 };
        }),
      })),
    };
  });

// The page under the middle of the book's paper: its box, and whether any ink is drawn on it
const pageAtMiddle = (page, paper) =>
  page.evaluate(
    ([x, y]) => {
      const el = document.elementsFromPoint(x, y).find(e => e.dataset.kind);
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        height: Math.round(r.height),
        inked: el.querySelectorAll('canvas').length > 0,
      };
    },
    [paper.left + paper.width / 2, MINI.height / 2],
  );
// Today's pages as the store keeps them (dev mode's, in memory): { id, h, strokes }
const storedPages = page =>
  page.evaluate(async () => {
    const book = await import('/shell/bookdata.js');
    return (await book.loadDay(true)).pages.map(({ id, h, strokes }) => ({ id, h, strokes }));
  });
// A mouse line across the paper from x, a little wavy, at y
async function write(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(x + i * 10, y + 10 * Math.sin(i / 2));
  await page.mouse.up();
}

// HQ in a fresh context at a size, the book drawn
async function hq(browser, viewport, options = {}) {
  const { context, page, errors } = await openPage(browser, { viewport, hasTouch: true, ...options });
  await page.goto(`${base}/?intro=0`);
  await ready(page);
  return { page, errors, done: () => context.close() };
}
async function ready(page) {
  await page.waitForSelector('#book [title^="For "]', { timeout: 30_000 });
  await page.waitForTimeout(SETTLE_MS);
}
// What the board sees, measured: the book's mode, HQ's page width, the book's paper and the rail's boxes, and HQ's
// toolbar buttons that show
const sight = page =>
  page.evaluate(() => {
    const box = el => {
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        top: Math.round(r.top),
      };
    };
    const shown = el => el.offsetParent && el.getBoundingClientRect().width > 0;
    return {
      mode: document.documentElement.dataset.book,
      page: document.body.getBoundingClientRect().width,
      book: box(document.querySelector('#book section')),
      rail: box(document.querySelector('#book nav')),
      tools: [...document.querySelectorAll('#hud .tools > *')].filter(shown).map(box),
    };
  });
// The rail where it was before the book moved
function railStays(seen, before) {
  assert.deepEqual(seen.rail, before.rail, 'the rail moved');
}
const railMiddle = seen => seen.rail.left + seen.rail.width / 2;
// The open book beside HQ's page, never over it
const beside = seen => assert.ok(seen.book.left >= seen.page, `the book at ${seen.book.left} is over the page`);
// The folded book out of sight under the rail
const folded = seen => assert.ok(seen.book.left >= seen.rail.left, `the book still shows at x ${seen.book.left}`);
// HQ's toolbar whole on its page: every button that shows inside the page's width, so none is under the book
function hqWhole(seen) {
  assert.ok(seen.tools.length >= 5, `only ${seen.tools.length} of HQ's tools show`);
  for (const t of seen.tools)
    assert.ok(t.left >= 0 && t.right <= seen.page, `a tool at ${t.left}-${t.right}, past the page's ${seen.page}`);
}
const spineAt = async page => {
  const r = await page.locator('#book [role=separator]').boundingBox();
  return r.x + r.width / 2;
};
// A drag across the screen at mid-height: from x by dx, in steps (few: a flick)
async function drag(page, x, dx, steps) {
  const y = (page.viewportSize().height * 2) / 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps });
  await page.mouse.up();
}
// The book in a mode, laid out: headless WebKit's frames come slowly under HQ's scene, and it tells the page a new
// size up to a second or two late
async function settled(page, mode) {
  for (const end = Date.now() + 5000; Date.now() < end; await page.waitForTimeout(100))
    if ((await page.evaluate(() => document.documentElement.dataset.book)) === mode) break;
  await page.waitForTimeout(SETTLE_MS);
}
async function bookStories(browser, which) {
  let failed = 0;
  for (const [name, story] of Object.entries(STORIES())) {
    try {
      await story(browser);
      console.log(`ok   ${which}: ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${which}: ${name}\n     ${e.message.split('\n').join('\n     ')}`);
    }
  }
  return failed;
}

const browser = await playwright().webkit.launch();
let context = await hqIn(browser);

// HQ at an address, on a page of its own
let page, errors;
const open = async url => {
  page = await context.newPage();
  errors = errorsOf(page);
  await page.goto(`${base}${url}`);
  await until(page, '#loading.gone');
  await page.waitForSelector('review-mode .fab');
};
const ui = s => `review-mode >> css=${s}`;

// A pen on the page, as Safari hands it over (pressure, then none at the lift): down, along the points, and up only
// when asked (lift), so what's on screen just before the lift can be seen
const pen = (points, { lift = true, type = 'pen' } = {}) =>
  page.evaluate(
    ([pts, lift, type]) => {
      const at = (kind, [x, y], pressure) =>
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
          new PointerEvent(kind, {
            pointerId: 7,
            pointerType: type,
            isPrimary: true,
            clientX: x,
            clientY: y,
            pressure,
            buttons: kind === 'pointerup' ? 0 : 1,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
      at('pointerdown', pts[0], 0.4);
      pts.slice(1).forEach((p, i) => at('pointermove', p, 0.35 + 0.4 * Math.sin((i / pts.length) * Math.PI)));
      window.__lift = () => at('pointerup', pts.at(-1), 0);
      if (lift) window.__lift();
    },
    [points, lift, type],
  );
const ring = (cx, cy, rx, ry) =>
  Array.from({ length: 48 }, (_, i) => [
    cx + rx * Math.cos((i / 44) * 2 * Math.PI),
    cy + ry * Math.sin((i / 44) * 2 * Math.PI),
  ]);
// What review mode's ink shows in a box as the pen lifts: its layers put together as the screen does (HQ's own page
// animates under it), at the very end of the line (its last piece drawn wet: ink.js's 'end'), then once it's dry
const lifting = clip =>
  page.evaluate(clip => {
    const k = devicePixelRatio,
      layers = () => {
        const out = Object.assign(document.createElement('canvas'), { width: clip.width * k, height: clip.height * k }),
          g = out.getContext('2d');
        g.fillStyle = '#808080';
        g.fillRect(0, 0, out.width, out.height);
        // (its ink layers only: the post-it's polaroid can develop in the same frame)
        for (const c of document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > canvas')) {
          g.globalAlpha = Number(getComputedStyle(c).opacity);
          g.drawImage(c, clip.x * k, clip.y * k, clip.width * k, clip.height * k, 0, 0, out.width, out.height);
        }
        return out.toDataURL('image/png');
      };
    let wet = null;
    const end = e => e.detail.phase === 'end' && (wet = layers());
    document.addEventListener('ink:stroke', end);
    window.__lift();
    document.removeEventListener('ink:stroke', end);
    return new Promise(res => requestAnimationFrame(() => res({ wet, dry: layers() })));
  }, clip);
// what's on screen in a box; a picture's pixels (a data URL, decoded in the page)
const grab = clip => page.screenshot({ clip }).then(b => `data:image/png;base64,${b.toString('base64')}`);
const pixels = src =>
  page.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
      g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return { data: [...g.getImageData(0, 0, c.width, c.height).data], width: c.width, height: c.height };
  }, src);
// how two pictures differ: the worst channel, and how many pixels differ past 24 (the first few of them), leaving out
// a square of corner device px at the top left
async function differ(a, b, { corner = 0 } = {}) {
  const [p, q] = await Promise.all([pixels(a), pixels(b)]);
  let worst = 0,
    changed = 0;
  const at = [];
  for (let i = 0; i < p.data.length; i += 4) {
    if ((i / 4) % p.width < corner && i / 4 / p.width < corner) continue;
    const d = Math.max(...[0, 1, 2].map(k => Math.abs(p.data[i + k] - q.data[i + k])));
    worst = Math.max(worst, d);
    if (d > 24 && changed++ < 6)
      at.push([(i / 4) % p.width, Math.floor(i / 4 / p.width), p.data.slice(i, i + 3), q.data.slice(i, i + 3)]);
  }
  return { worst, changed, at };
}
// whether the board sees the number's red disc at a point (ACCENT, #ff5a5f)
async function redAt(x, y) {
  const { data } = await pixels(await grab({ x: x - 3, y: y - 3, width: 6, height: 6 }));
  for (let i = 0; i < data.length; i += 4) if (data[i] > 220 && data[i + 1] < 130 && data[i + 2] < 130) return true;
  return false;
}

// ---- a ring round something on HQ's page: no button, no veil, and nothing moves at the lift; its number at it, the
// words said while drawing, no picture taken in, and Send. look: what the stills' names end in. Returns the note sent
// and how much moved at the lift.
async function ringed(look) {
  const url = new URL(page.url()),
    here = url.pathname + url.search,
    noted = posts.filter(p => p.path === '/api/book/note').length;
  const loop = ring(372, 330, 150, 60),
    clip = { x: 372 - 175, y: 330 - 85, width: 350, height: 170 };
  await pen(loop, { lift: false });
  const { wet, dry } = await lifting(clip);
  // (the mark's number may land in the very frame of the lift, its disc in the clip's top left 32 px, 64 device px:
  // the ring never comes that near)
  const jump = await differ(wet, dry, { corner: 64 });
  if (shots) {
    await writeFile(`${shots}/lift-wet${look}.png`, Buffer.from(wet.split(',')[1], 'base64'));
    await writeFile(`${shots}/lift-dry${look}.png`, Buffer.from(dry.split(',')[1], 'base64'));
  }
  // (a line moved or redrawn differently leaves ink where there was page, past 150 on a channel. HQ's canvases are on
  // headless WebKit's GPU here, which antialiases some paths coarsely, a few hundred edge pixels off by under 100:
  // inkcheck.mjs below holds every line to a few pixels on the CPU canvas, as Safari draws)
  assert.ok(jump.worst < 100, `nothing moves as the pen lifts${look} (${JSON.stringify(jump)})`);
  assert.equal(await page.locator(ui('.veil')).isHidden(), true, 'the Pencil draws on HQ with no mode over the page');
  await page.waitForSelector(ui('.sheet:not([hidden])'));
  await aScrap(look);
  // its number, at the top left of the ring
  for (let i = 0; i < 20 && !(await redAt(372 - 150 - 6, 330 - 60 - 6)); i++) await page.waitForTimeout(150);
  assert.ok(await redAt(372 - 150 - 6, 330 - 60 - 6), `the mark's number shows at it${look}`);
  assert.ok(
    !posts.some(p => p.path === '/api/book/page/new' && p.body.url === here),
    'counting its number makes no page in the book',
  );
  // the words said while drawing, live
  await page.waitForFunction(
    () => /shorter|Make this/.test(document.querySelector('review-mode').shadowRoot.querySelector('textarea').value),
    null,
    { timeout: 15_000 },
  );
  // a picture pasted into the post-it stays out: the book's notes take none
  const pics = await page.evaluate(async () => {
    const root = document.querySelector('review-mode').shadowRoot,
      c = Object.assign(document.createElement('canvas'), { width: 8, height: 8 }),
      png = await new Promise(res => c.toBlob(res, 'image/png')),
      dt = new DataTransfer();
    dt.items.add(new File([png], 'shot.png', { type: 'image/png' }));
    root
      .querySelector('textarea')
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, composed: true, cancelable: true }),
      );
    await new Promise(res => setTimeout(res, 300));
    return root.querySelectorAll('.pics li').length;
  });
  assert.equal(pics, 0, "a picture pasted into the book's post-it isn't taken");
  await shot(`book-pencil-ring${look}`, page);
  // (headless WebKit paints and hit-tests the post-it late while it pops in: the button's own click, as a tap gives)
  await page.locator(ui('.send')).dispatchEvent('click');
  await page.waitForSelector(ui('.sheet'), { state: 'hidden', timeout: 15_000 });
  const made = posts.find(p => p.path === '/api/book/page/new' && p.body.url === here)?.body,
    sent = posts.filter(p => p.path === '/api/book/note')[noted]?.body;
  assert.deepEqual(
    made && { kind: made.kind, owner: made.owner },
    { kind: 'sheet', owner: org.company.ceo },
    "HQ's page is a page in today's book, for the CEO until a screen has its owner",
  );
  assert.equal(sent.anchor.v, 1);
  assert.ok(sent.anchor.el?.selector, `the note is anchored on what was ringed${look}`);
  assert.equal(sent.anchor.ink.length, 1, 'the ring is its ink');
  assert.ok(
    Math.abs(Math.min(...sent.anchor.ink[0].points.map(p => p[0])) - 222) < 6,
    'its ink in document px, where it was drawn',
  );
  assert.match(sent.words, /shorter/, 'the words said while drawing are its words');
  assert.equal(sent.said, 'spoken');
  assert.match(sent.snip ?? '', /^data:image\/jpeg;base64,/, 'a snip of the page around it goes with it');
  assert.ok(
    await redAt(372 - 150 - 6, 330 - 60 - 6),
    `sent to its sheet, the mark keeps its number on the page${look}`,
  );
  await shot(`book-pencil-sent${look}`, page);
  return { sent, jump };
}
// The post-it where the book is folded away: it shows where the book is, and has the mic, a Cancel and one Send.
async function aScrap(look) {
  const seen = await page.evaluate(() => {
    const sheet = document.querySelector('review-mode').shadowRoot.querySelector('.sheet');
    return {
      book: document.documentElement.dataset.book,
      buttons: [...sheet.querySelectorAll('.row button')].filter(b => b.offsetWidth).map(b => b.textContent),
    };
  });
  assert.equal(seen.book, 'folded', `the post-it shows where the book is folded away${look}`);
  assert.deepEqual(seen.buttons, ['', 'Cancel', 'Send'], `the mic, a Cancel and one Send${look}`);
}
// ---- the Pencil writes on HQ's page, never on the book beside it: in landscape, the book open.
async function besideTheBook(browser) {
  await context.close();
  context = await hqIn(browser, MINI);
  await open('/?intro=0');
  await settled(page, 'open');
  // review mode's layer and its pin, and the post-it when it's up, beside the page's width
  const layer = () =>
    page.evaluate(() => {
      const root = document.querySelector('review-mode').shadowRoot,
        box = el => {
          const b = el.getBoundingClientRect();
          return b.width
            ? { left: Math.round(b.left), right: Math.round(b.right), x: b.x + b.width / 2, y: b.y + b.height / 2 }
            : null;
        };
      return {
        page: Math.round(document.body.getBoundingClientRect().width),
        ui: box(root.querySelector('.ui')),
        fab: box(root.querySelector('.fab')),
        sheet: box(root.querySelector('.sheet')),
      };
    });
  const onPage = (l, what) =>
    assert.ok(
      l[what].left >= 0 && l[what].right <= l.page,
      `${what} at ${l[what].left}-${l[what].right}, past the page's ${l.page}`,
    );
  const seen = await sight(page);
  let l = await layer();
  assert.deepEqual([l.ui.left, l.ui.right], [0, l.page], "review mode's layer is HQ's page, not the book beside it");
  onPage(l, 'fab');
  // a pen on the book's paper is the book's
  const noted = posts.length;
  await pen(Array.from({ length: 16 }, (_, i) => [seen.book.left + 40 + i * 12, 420 + 8 * Math.sin(i)]));
  // (a post-it waits for its screenshot: WebKit's takes up to 6 s)
  const opened = await page.waitForSelector(ui('.sheet'), { state: 'visible', timeout: 8000 }).then(
    () => true,
    () => false,
  );
  assert.equal(opened, false, "a pen on the book's paper opens no note on the page");
  assert.equal(posts.slice(noted).filter(p => p.path === '/api/book/note').length, 0);
  // a ring at the page's edge: its post-it on the page
  await pen(ring(l.page - 70, 420, 50, 34));
  await page.waitForSelector(ui('.sheet'), { state: 'visible' });
  await page.waitForTimeout(500); // (it pops in)
  onPage(await layer(), 'sheet');
  await shot('book-pencil-beside', page);
  await page.locator(ui('[data-cancel]')).dispatchEvent('click');
  await page.waitForSelector(ui('.sheet'), { state: 'hidden' });
  // over one of HQ's dialogs (the top layer, placed by the window), still the page's width
  await page.evaluate(() => {
    const d = Object.assign(document.createElement('dialog'), { id: 'beside' });
    document.body.append(d);
    d.showModal();
  });
  await page.waitForTimeout(300);
  l = await layer();
  assert.deepEqual([l.ui.left, l.ui.right], [0, l.page], "over a dialog, review mode's layer is still the page's");
  await page.evaluate(() => document.querySelector('#beside').remove());
  await page.waitForTimeout(300);
  // the spread covers HQ's page, the pin with it
  await drag(page, await spineAt(page), -260, 14);
  await settled(page, 'spread');
  l = await layer();
  assert.equal(
    await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#book'), [l.fab.x, l.fab.y]),
    true,
    'the spread book covers the pin with the page',
  );
  noErrors();
}
// (HQ's world captures the pointer of every pointerdown, and so does the book's paper: a scripted one has no pointer to
// capture, which WebKit and Chromium each say in their words)
const noErrors = () =>
  assert.deepEqual(
    errors.filter(e => !/can not be found here|No active pointer with the given id/.test(e)),
    [],
  );

await open('/?intro=0');
const { sent, jump } = await ringed('');

// ---- a finger works the page: its drag draws nothing
const before = posts.length;
await pen(
  Array.from({ length: 20 }, (_, i) => [200 + i * 12, 700]),
  { type: 'touch' },
);
await page.waitForTimeout(500);
assert.equal(await page.locator(ui('.sheet')).isHidden(), true, "a finger's drag opens no note");
assert.equal(posts.length, before);

// ---- held still, the pen listens there: the words land as a note as it lifts
await pen([[560, 520]], { lift: false });
await page.waitForSelector(ui('.listen:not([hidden])'), { timeout: 3000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__lift());

for (let i = 0; i < 60 && posts.filter(p => p.path === '/api/book/note').length < 2; i++)
  await page.waitForTimeout(250);
const voice = posts.filter(p => p.path === '/api/book/note')[1]?.body;
assert.ok(voice, 'a voice note went into the book as the pen lifted');
assert.equal(voice.said, 'spoken');
assert.equal(voice.anchor.ink.length, 0, 'a voice note is a pin, no ink');
assert.ok(voice.anchor.el, 'on what the pen held still over');

await page.waitForSelector(ui('.sheet'), { state: 'hidden' });
// ---- a scribble over the ring wipes it; a two-finger tap brings it back
const zigzag = Array.from({ length: 24 }, (_, i) => [300 + (i % 2) * 140, 300 + i * 2.5]);
await pen(zigzag);
for (let i = 0; i < 20 && !posts.some(p => p.path === '/api/book/note/delete'); i++) await page.waitForTimeout(150);
assert.equal(posts.find(p => p.path === '/api/book/note/delete')?.body.id, notes[0].id, 'a scribble wipes the mark');
await page.evaluate(() => {
  // (Linux's headless WebKit has no Touch to make: a touch event's lists, as Safari fills them)
  const t = (id, x) => ({ identifier: id, target: document.body, clientX: x, clientY: 600 });
  const fire = (type, touches, changed) =>
    document.body.dispatchEvent(
      Object.defineProperties(new Event(type, { bubbles: true, composed: true }), {
        touches: { value: touches },
        changedTouches: { value: changed },
      }),
    );
  const two = [t(1, 300), t(2, 400)];
  fire('touchstart', two, two);
  fire('touchend', [], two);
});
for (let i = 0; i < 20 && posts.filter(p => p.path === '/api/book/note').length < 3; i++)
  await page.waitForTimeout(150);
const back = posts.filter(p => p.path === '/api/book/note')[2]?.body;
assert.deepEqual(back?.anchor.ink, sent.anchor.ink, 'a two-finger tap brings the wiped mark back');
assert.deepEqual([back.words, back.said, back.snip], [sent.words, sent.said, sent.snip], '...with its words and snip');
noErrors();

// ---- a call drawing in (bookcall.mjs)
await context.close();
context = await hqIn(browser);
await callStory({ context, open, page: () => page, pen, ring, ui, posts, pages, org, pixels, grab, shot });
noErrors();
await besideTheBook(browser);
await context.close();

// ---- every kind of line, wet and dry, on a page of its own
const lines = await browser.newContext(IPAD_MINI);
for (const line of await wetDry(await lines.newPage()))
  assert.ok(line.changed <= STILL, `${line.name}: wet and dry are the same line (${JSON.stringify(line)})`);
let failed = await bookStories(browser, 'webkit');
await browser.close();

// ---- the ring, its number and Send in Wire, in Chromium: Linux's headless WebKit has no en-CA dates (its ICU writes
// 10/26/2026 for HQ's YYYY-MM-DD), so Wire's calendar can't start there and HQ shows Brownstone instead (Safari has them)
const chromium = await playwright().chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
context = await hqIn(chromium);
await open('/?intro=0&renderer=wire');
assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), false, 'Wire is the look');
const wire = await ringed('-wire');
noErrors();
// ---- a call drawing in, in Wire (bookcall.mjs)
await context.close();
context = await hqIn(chromium);
await callStory({
  context,
  open,
  page: () => page,
  pen,
  ring,
  ui,
  posts,
  pages,
  org,
  pixels,
  grab,
  shot,
  look: 'wire',
});
noErrors();
await besideTheBook(chromium);
failed += await bookStories(chromium, 'chromium');
await chromium.close();

server.close();
console.log(
  `book-check: on HQ in WebKit at iPad mini size, a pen's ring with no button first (nothing moving at the lift: at most ${jump.worst} off on an edge, ${wire.jump.worst} in Wire), its number at it (no page made for it), the words said while drawing, a pasted picture kept out, the post-it a scrap of the folded book (its paper, torn head, ribbon, one Send and a Cancel), Send to the book (anchor, words, snip), the mark kept numbered, in Brownstone and in Wire (Chromium); a finger's drag drawing nothing; a voice note held still; a scribble wiping a mark and a two-finger tap bringing it back with its words and snip; a call (in Brownstone, and in Wire in Chromium): the Pencil making it small, a note to the call's page and the line with the words heard, a private part painted over in its snip, a line drawn while it goes in drawn and the next note, a mark the book didn't take kept and told, the agent's ask and Show, its ring in its own ink, the page thrown away, the cards' answers Wire's keys; every kind of line the same wet and dry; the Pencil's layer HQ's page beside the open book (a pen on the book's paper drawing nothing, the post-it and the pin on the page, over a dialog too, the spread covering them), in WebKit and Chromium; the book's stories above (the pinch-out to the day and the week among them)${failed ? `, ${failed} failing` : ''}${shots ? ` (screenshots in ${shots})` : ''}`,
);
if (failed) process.exitCode = 1;
