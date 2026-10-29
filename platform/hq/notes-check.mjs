#!/usr/bin/env node
// Review mode's notes, the board's and an outside reviewer's. The board's note on a preview goes on its owner's sheet in
// the book (bookreview.ts), nothing waiting in HQ: in HQ's viewer a pin puts nothing over the page and the bar stays one
// slim row on a phone with no Send; the polaroid is framed on the pin; the note keeps the screen and the touch points.
// The board's menu says whose sheet a note there joins ("For Bolt · 1 on the sheet"), every line on one line on a phone,
// and its Open the book opens HQ's book at Bolt's sheet (on a phone its spread, over the viewer; after a late goodbye
// too); in a tab of its own it opens HQ at that sheet; its general note goes pinned to nothing. Reviews' Sent (HQ's mock): each sheet sent as one
// block, no ticks, Send or Discard. An outside reviewer's menu is a general note and where their notes go, asking
// nothing of theirs back; Shift + drag draws a rectangle, a circle in every other way; pictures pasted, dropped and
// taken off a note (scaled on the device), and a note cancelled while one is read goes nowhere. A note
// with pictures, put on its sheet and sent by the real coordinator, is one snip with the pictures under the screenshot,
// which hq note saves. A shelf's note posts to the shelf's own path. HQ itself always has the same tool, its notes going
// into the book; while the viewer shows a preview, only the preview's pin shows.
// (the book, and the waiting step gone)
//   node platform/hq/notes-check.mjs [--shots dir]
// First HQ in dev mode, then with a fake /api and a product preview played by Playwright at
// https://hello.preview.test running the real shared/review/review.js, its shadow root forced open.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { wrappedMenuLines } from '../../shared/review/lines.mjs';
import { shutBook } from './bookchrome.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const PRODUCT = 'https://hello.preview.test',
  DAY = '2026-10-26';
const reviewJs = (await readFile(`${ROOT}/shared/review/review.js`, 'utf8')).replace('{{HQ_ORIGIN}}', base);
// (as the coordinator serves it to an outside reviewer on a share: guests.ts)
const outsideJs = reviewJs.replace("'{{OUTSIDE}}'", "'Testco'");
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hello</title>
  <style>body { font: 18px system-ui; margin: 24px; } h1 { margin-top: 80px; }</style>
  <h1>Hello, whoever you are</h1><p>A little card for a friend.</p><script src="/__review/review.js" defer></script>`;

// ---- the coordinator, played. The board's notes on the preview go on Bolt's sheet in its book (bookreview.ts toBook):
// today's sheet page for Bolt, made by the first, and a book note on it each. The Pencil's on HQ go on HQ's pages.
const OWNER = { owner: 'bolt', name: 'Bolt' };
let lastId = 0;
const pages = [],
  booked = [],
  posted = [],
  snips = new Map(),
  pencilled = [];
const sheetPage = url =>
  pages.find(p => p.kind === 'sheet' && p.owner === OWNER.owner) ??
  pages[pages.push({ id: ++lastId, day: DAY, kind: 'sheet', owner: OWNER.owner, url, label: '', w: 390, h: 844 }) - 1];
const onSheet = () => booked.filter(n => n.status === 'open');
function bookNote(body) {
  posted.push(body);
  const page = sheetPage(body.page),
    id = ++lastId,
    e = body.element ?? {};
  const general = e.kind === 'general';
  const note = {
    id,
    page: page.id,
    anchor: {
      v: 1,
      url: body.page,
      el: general ? null : (e.el ?? null),
      view: e.view ?? null,
      ink: general ? [] : (e.ink ?? []),
    },
    words: body.note,
    said: body.said ?? 'typed',
    snip: body.shot && !general ? `/api/book/snip?id=${id}` : null,
    status: 'open',
    n: onSheet().length + 1,
  };
  if (note.snip) snips.set(id, body.shot);
  booked.push(note);
  return { ok: true, id, n: note.n, ...OWNER };
}
function book(path, body, q) {
  if (path === '/api/book') return { day: DAY, today: DAY, days: [], pages };
  if (path === '/api/book/sheets')
    return {
      open: onSheet().length
        ? [{ id: 1, status: 'open', send_at: null, ...OWNER, name: null, sent: null, page: null, notes: onSheet() }]
        : [],
      sent: [],
    };
  if (path === '/api/book/notes' && q.has('url')) return { notes: [] }; // (HQ's own pages: the Pencil's marks there)
  if (path === '/api/book/notes') return { notes: booked.filter(n => n.page === +q.get('page')) };
  if (path === '/api/book/page') {
    const p = pages.find(x => x.id === +q.get('id'));
    return p && { ...p, ink: [], scraps: [], texts: [] }; // (texts)
  }
  if (path === '/api/book/page/save') {
    const p = pages.find(x => x.id === body.id);
    return p && Object.assign(p, { h: body.h ?? p.h });
  }
  if (path === '/api/book/page/new') return pages[pages.push({ id: ++lastId, day: DAY, ...body }) - 1];
  if (path === '/api/book/note') {
    pencilled.push(body);
    return { note: { id: ++lastId, n: 1, status: 'open', ...body }, sheet: { id: 2 } };
  }
  return null;
}

const shot = async (name, on) => {
  if (shots) await on.screenshot({ path: `${shots}/${name}.png` });
};
const browser = await playwright().chromium.launch();
// ---- Reviews' Sent, on HQ's mock in dev mode: each sheet sent one block (to whom, when, its job, its notes), then the
// notes sent before the book; no ticks, Send or Discard, and nothing waiting
{
  const dev = await openPage(browser, { viewport: { width: 390, height: 844 } });
  await dev.context.route(`${base}/mock/*.json`, async r =>
    r.fulfill({
      contentType: 'application/json',
      body: await readFile(`${ROOT}/platform/hq${new URL(r.request().url()).pathname}`),
    }),
  );
  await dev.page.goto(`${base}/?intro=0&renderer=wire`);
  await until(dev.page, '#loading.gone');
  await dev.page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('notes')));
  await dev.page.waitForSelector('section.notes.sent li.sent-note');
  assert.deepEqual(await dev.page.$$eval('[data-shown]', bs => bs.map(b => b.firstChild.textContent)), [
    'Sent',
    'Shared',
  ]);
  assert.deepEqual(
    await dev.page.$$eval('section.notes.sent h3', hs => hs.map(h => h.textContent)),
    ['To Moss', 'To Wren', 'To Bolt'],
    'newest first',
  );
  assert.match(await dev.page.textContent('section.notes.sent .dim'), /^1 note · .* · job /);
  assert.equal(
    await dev.page.locator('#tool :is([data-send], [data-discard], [data-note], input[type=checkbox])').count(),
    0,
    'no ticks, Send or Discard',
  );
  await shot('reviews-sent', dev.page);
  assert.deepEqual(dev.errors, []);
  await dev.context.close();
}

// ---- HQ, on the played coordinator, held like a phone
const { context, page, errors } = await openPage(browser, {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
await context.addInitScript(() => {
  const a = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) {
    return a.call(this, { ...o, mode: 'open' });
  };
});
await context.route(`${base}/api/**`, async r => {
  const url = new URL(r.request().url()),
    path = url.pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  // nobody invited: the book's rail draws no faces and no sheets when this fails
  if (['/api/requests', '/api/gazette', '/api/book/people'].includes(path)) return r.fulfill({ json: [] });
  if (path === '/api/preview/link') return r.fulfill({ json: { url: r.request().postDataJSON().url } });
  if (path === '/api/review/shares') return r.fulfill({ json: [] }); // (no outside links: shares-check.mjs has those)
  if (path === '/api/book/snip') {
    const s = snips.get(+url.searchParams.get('id'));
    return s
      ? r.fulfill({ contentType: s.slice(5, s.indexOf(';')), body: Buffer.from(s.split(',')[1], 'base64') })
      : r.fulfill({ status: 404, body: '' });
  }
  const answer =
    path.startsWith('/api/book') &&
    book(path, r.request().method() === 'POST' ? r.request().postDataJSON() : null, url.searchParams);
  if (answer) return r.fulfill({ json: answer });
  return r.fulfill({ status: 404, body: '' });
});
// the preview, for the board: its notes go on Bolt's sheet; the menu reads whose sheet and how many (with the page it's
// on); the page has nothing of the board's to change
const askedMine = [];
await context.route(`${PRODUCT}/**`, r => {
  const url = new URL(r.request().url()),
    path = url.pathname;
  if (fulfilPart(r, path, reviewJs)) return;
  if (path === '/__review/coach') return r.fulfill({ json: { show: false } });
  if (path === '/__review/notes') return r.fulfill({ json: bookNote(r.request().postDataJSON()) });
  if (path === '/__review/mine') {
    askedMine.push(url.searchParams.get('page'));
    return r.fulfill({ json: { book: OWNER, notes: onSheet().length } });
  }
  return r.fulfill({ contentType: 'text/html', body: PAGE });
});
await page.goto(`${base}/?intro=0`);
await until(page, '#loading.gone');

// a framed preview (frame.js) shows the whole mark: scaled with the img, it falls inside the img's box
const showsMark = (img, mark, viewportWidth) =>
  img.evaluate(
    (img, [mark, viewportWidth]) => {
      const scale = img.offsetWidth / viewportWidth,
        box = img.offsetParent;
      const left = img.offsetLeft + mark.x * scale,
        top = img.offsetTop + mark.y * scale;
      return (
        img.classList.contains('framed') &&
        left >= -1 &&
        top >= -1 &&
        left + mark.w * scale <= box.clientWidth + 1 &&
        top + mark.h * scale <= box.clientHeight + 1
      );
    },
    [mark, viewportWidth],
  );
// counts: the board's menu counts it (an outsider's has no count)
async function pinNote(where, text, startPin, mouse = page.mouse, counts = true) {
  await startPin();
  await where.waitForSelector('review-mode .veil:not([hidden])');
  const h1 = await where.locator('h1').boundingBox();
  await mouse.click(h1.x + 40, h1.y + h1.height / 2);
  await where.waitForSelector('review-mode .sheet:not([hidden])');
  await where.fill('review-mode textarea', text);
  const [pinned, viewportWidth] = await where.evaluate(() => {
    const r = document.querySelector('h1').getBoundingClientRect();
    return [{ x: r.x, y: r.y, w: r.width, h: r.height }, innerWidth];
  });
  const polaroid = where.locator('review-mode .polaroid .img :is(img, canvas)');
  await polaroid.waitFor();
  assert.ok(await showsMark(polaroid, pinned, viewportWidth), 'the polaroid is framed on the pinned headline');
  const count = () => document.querySelector('review-mode').shadowRoot.querySelector('.count').textContent;
  const was = await where.evaluate(count);
  await where.click('review-mode .send');
  await where.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
  // pinned: the pin counts it
  if (counts) await where.waitForFunction(`(${count})() !== ${JSON.stringify(was)}`, null, { timeout: 20_000 });
}
// nothing of review mode's covers the page after a pin: only its pin (the dock) is there
const overPage = where =>
  where.evaluate(() =>
    [...document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > *')]
      .filter(
        el =>
          !el.hidden &&
          !el.classList.contains('dock') &&
          !(
            el.localName === 'canvas' &&
            !el
              .getContext('2d')
              .getImageData(0, 0, el.width, el.height)
              .data.some(v => v)
          ) &&
          getComputedStyle(el).display !== 'none' &&
          getComputedStyle(el).opacity !== '0' &&
          el.getBoundingClientRect().height > 0,
      )
      .map(el => el.className),
  );
// the menu's items and their sub-lines, as shown
const items = where =>
  where.$$eval('review-mode .menu .items button:not([hidden])', bs => bs.map(b => b.firstChild.textContent));
const subs = where =>
  where.$$eval('review-mode .menu .items button:not([hidden]) small', s => s.map(x => x.textContent));
// the book open beside HQ's page at Bolt's sheet: its page "For Bolt" on the book's paper, the note on it
async function atBoltsSheet(on, words) {
  // (once the book has slid open: its spread on a phone, over HQ's page and the viewer alike)
  await on.waitForFunction(
    () => document.documentElement.dataset.book && document.documentElement.dataset.book !== 'folded',
    null,
    { timeout: 10_000 },
  );
  const sheet = on.getByRole('region', { name: 'For Bolt' });
  await sheet.waitFor({ timeout: 10_000 });
  // its notes on the book's paper, the table done sliding there (where they are now is where they were a moment ago)
  const place = () =>
    on.evaluate(() => {
      const paper = document.querySelector('#book section').getBoundingClientRect(),
        notes = [...document.querySelectorAll('#book [aria-label="For Bolt"] .bs-note')];
      const shown =
        notes.length > 0 &&
        notes.every(n => {
          const r = n.getBoundingClientRect(),
            img = n.querySelector('img');
          return (
            r.left >= paper.left - 1 &&
            r.left < paper.right &&
            r.top >= paper.top &&
            r.top < paper.bottom &&
            (!img || img.naturalWidth > 0)
          );
        });
      return shown && notes.map(n => Math.round(n.getBoundingClientRect().left)).join();
    });
  for (let at = await place(), i = 0; ; i++) {
    await on.waitForTimeout(250);
    const now = await place();
    if (now && now === at) break;
    assert.ok(i < 40, "Bolt's sheet comes to rest on the book's paper");
    at = now;
  }
  assert.doesNotMatch(
    await on.evaluate(() => document.querySelector('#book').innerText),
    /go through/,
    'nothing refused',
  );
  for (const w of words)
    assert.ok(
      await sheet.locator('textarea').evaluateAll((fs, w) => fs.some(f => f.value === w), w),
      `"${w}" on Bolt's sheet`,
    );
}

// a flick of the spine puts the spread away (folded, on a phone.)
async function foldAway(on) {
  await shutBook(on);
  await on.waitForSelector('html[data-book=folded]', { state: 'attached' });
  await on.waitForTimeout(700); // (HQ laid out again after it)
}

// ---- the viewer: a note pinned in the frame goes on Bolt's sheet in the book, nothing over the page, no Send on the bar
await page.evaluate(href => {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = 'preview';
  document.body.append(a);
  a.click();
  a.remove();
}, `${PRODUCT}/`);
await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
const frame = page.frame({ url: `${PRODUCT}/` });
await pinNote(frame, 'Make the headline warmer', () => page.click('#viewer .bar .pin'));
await page.waitForTimeout(600); // (where a message would have come up)
assert.deepEqual(await overPage(frame), [], 'nothing comes up over the page after a pin');
const warmer = booked.find(n => n.words === 'Make the headline warmer');
assert.ok(
  warmer && warmer.page === sheetPage().id && warmer.anchor.el?.tag === 'h1',
  "it's a note on Bolt's sheet page in the book, on the headline",
);
assert.ok(warmer.snip, 'with the screen as its snip');
const warmerBody = posted.at(-1);
assert.deepEqual(
  [warmerBody.viewport.sw, warmerBody.viewport.sh, warmerBody.viewport.touch > 0],
  [390, 844, true],
  'the note keeps the screen and the touch points',
);
assert.equal(await page.locator('#viewer .bar .send').count(), 0, 'no Send on the bar: nothing waits in HQ');
const fits = await page.$eval('#viewer .bar', bar =>
  [...bar.children]
    .filter(c => !c.hidden)
    .every(c => c.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5),
);
assert.ok(fits, 'the bar fits a phone');
assert.ok(await page.$eval('#viewer .bar', b => b.getBoundingClientRect().height <= 40), 'the bar is one slim row');
await shot('viewer-pinned', page);
// the menu: whose sheet a note here joins and how many it holds, and the way there; every line on one line on a phone
await frame.click('review-mode .more');
await frame.waitForFunction(() =>
  document.querySelector('review-mode').shadowRoot.querySelector('.menu .cap').textContent.startsWith('For '),
);
assert.equal(await frame.textContent('review-mode .menu .cap'), 'For Bolt · 1 on the sheet');
assert.deepEqual(await items(frame), ['General note', 'Open the book'], 'no My notes or Send my notes for the board');
assert.deepEqual(await subs(frame), ['About it all, not one spot', 'In your book, for Bolt']);
assert.deepEqual(await frame.evaluate(wrappedMenuLines), [], 'no line of the menu wraps on a phone');
assert.equal(askedMine.at(-1), `${PRODUCT}/`, 'the menu asks with the page it is on');
await shot('menu-in-frame', page);
// Open the book: HQ's book at Bolt's sheet (on a phone, its spread over the viewer)
await frame.click('review-mode [data-open-book]');
await atBoltsSheet(page, ['Make the headline warmer']);
await shot('book-from-frame', page);
assert.equal(await frame.isVisible('review-mode .menu'), false, 'the menu shuts');
// a goodbye that came late (the page before's) leaves HQ thinking review mode is gone: Open the book still opens it
await foldAway(page);
await frame.evaluate(hq => parent.postMessage({ hq: 'review', bye: 1 }, hq), base);
await page.waitForSelector('#viewer .bar .pin', { state: 'hidden' });
await frame.click('review-mode .more');
await frame.click('review-mode [data-open-book]');
await atBoltsSheet(page, ['Make the headline warmer']);
// (the page says hello again, as a new page would)
await frame.evaluate(hq => parent.postMessage({ hq: 'review', hello: 1 }, hq), base);
await page.waitForSelector('#viewer .bar .pin:not([hidden])');
await foldAway(page);
await page.click('#viewer [data-close]');

// ---- a preview in a tab of its own: the pin puts nothing over the page; Open the book opens HQ at Bolt's sheet in a
// new tab; the general note from the menu, pinned to nothing
const own = await context.newPage();
own.on('pageerror', e => errors.push(e.message));
await own.goto(`${PRODUCT}/`);
await pinNote(own, 'Seen in a browser tab', () => own.click('review-mode .fab', { force: true }), own.mouse);
await own.waitForTimeout(600);
assert.deepEqual(await overPage(own), [], 'nothing comes up over the page in a tab either');
await own.click('review-mode .more');
await own.waitForFunction(
  () =>
    document.querySelector('review-mode').shadowRoot.querySelector('.menu .cap').textContent ===
    'For Bolt · 2 on the sheet',
);
assert.deepEqual(await items(own), ['General note', 'Open the book']);
assert.equal(await own.textContent('review-mode .more .count'), '2', "the count is the notes on Bolt's sheet");
await shot('menu', own);
const [opened] = await Promise.all([context.waitForEvent('page'), own.click('review-mode [data-open-book]')]);
opened.on('pageerror', e => errors.push(e.message));
await opened.waitForURL(`${base}/?open=book&owner=bolt`);
await until(opened, '#loading.gone');
await atBoltsSheet(opened, ['Make the headline warmer', 'Seen in a browser tab']);
await shot('book-from-tab', opened);
await foldAway(opened); // (the book remembers how it was left, on every page of HQ)
await opened.close();
await own.click('review-mode .more');
await own.click('review-mode [data-general]');
await own.waitForSelector('review-mode .sheet:not([hidden])');
assert.equal(await own.textContent('review-mode .who h2'), 'A general note');
assert.ok(await own.isHidden('review-mode .polaroid'));
await own.fill('review-mode textarea', 'The pages greet in two different ways');
await shot('general-note', own);
await own.click('review-mode .send');
await own.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
const boardGeneral = posted.find(b => b.note === 'The pages greet in two different ways');
const { kind, el, ink: lines, area } = boardGeneral.element;
assert.deepEqual(
  [{ kind, el, lines, area }, boardGeneral.shot, boardGeneral.page],
  [{ kind: 'general', el: null, lines: [], area: null }, null, `${PRODUCT}/`],
);
assert.deepEqual(booked.find(n => n.words === boardGeneral.note).anchor.el, null, 'on the sheet, pinned to nothing');
await own.waitForFunction(
  () => document.querySelector('review-mode').shadowRoot.querySelector('.more .count').textContent === '3',
);
await own.close();

// ---- an outside reviewer on a share, in a browser of their own: each note goes as it's pinned (on the board's sheet,
// the coordinator's), and their menu says so, asking the coordinator nothing of theirs back
const guest = await openPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
await guest.context.addInitScript(() => {
  const a = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) {
    return a.call(this, { ...o, mode: 'open' });
  };
});
const theirs = [], // their notes, as review mode posted them
  GONE = ['/__review/mine', '/__review/submit', '/__review/more', '/__review/edit', '/__review/delete'],
  askedGone = [];
await guest.context.route(`${PRODUCT}/**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (fulfilPart(r, path, outsideJs)) return;
  if (path === '/__review/coach') return r.fulfill({ json: { show: false } });
  if (path === '/__review/notes') {
    const body = r.request().postDataJSON();
    theirs.push({ note: body.note, element: body.element, posted: body });
    return r.fulfill({ json: { ok: true, id: ++lastId } });
  }
  // (none of these is an outsider's: the coordinator's 404)
  if (GONE.includes(path)) {
    askedGone.push(path);
    return r.fulfill({ status: 404, json: { error: 'not found' } });
  }
  return r.fulfill({ contentType: 'text/html', body: PAGE });
});
const tab = guest.page,
  context2 = guest.context;
await tab.goto(`${PRODUCT}/`);
await pinNote(tab, 'Seen in a browser tab', () => tab.click('review-mode .fab', { force: true }), tab.mouse, false);
assert.ok(
  theirs.some(n => n.note === 'Seen in a browser tab'),
  'their note went as it was pinned',
);
await tab.click('review-mode .more');
assert.deepEqual(await items(tab), ['General note'], "an outsider's menu: a general note");
assert.equal(await tab.textContent('review-mode .more .count'), '', 'no count of theirs');
assert.deepEqual(await tab.evaluate(wrappedMenuLines), [], 'no line of the menu wraps on a phone');
await shot('menu-outsider', tab);
await tab.click('review-mode [data-general]');
await tab.waitForSelector('review-mode .sheet:not([hidden])');
await tab.fill('review-mode textarea', 'The pages greet in two different ways');
await tab.click('review-mode .send');
await tab.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
assert.equal(
  theirs.find(n => n.note === 'The pages greet in two different ways')?.element.kind,
  'general',
  'their general note, pinned to nothing',
);
assert.equal(
  booked.filter(n => /Seen in a browser tab|greet/.test(n.words)).length,
  2,
  "the board's own two, and none of theirs, in the board's played book",
);
await tab.setViewportSize({ width: 1280, height: 800 });

// ---- Shift + drag draws a rectangle: its four corners are the line (the pen's, ink.js), and the note is a circle's in
// every other way. Without Shift, the freehand line.
// (the ink on screen: whether there's some within 5 px of a point.)
const inkNear = ([x, y]) =>
  tab.$eval(
    'review-mode',
    (h, [x, y]) => {
      const c = h.shadowRoot.querySelector('.ink'),
        k = c.width / c.getBoundingClientRect().width;
      return c
        .getContext('2d')
        .getImageData(Math.round((x - 5) * k), Math.round((y - 5) * k), Math.round(10 * k), Math.round(10 * k))
        .data.some((v, i) => i % 4 === 3 && v > 128);
    },
    [x, y],
  );
const inkOn = async points => (await Promise.all(points.map(inkNear))).every(Boolean);
async function draw(points, shift = false) {
  await tab.waitForSelector('review-mode .veil:not([hidden])');
  if (shift) await tab.keyboard.down('Shift');
  await tab.mouse.move(...points[0]);
  await tab.mouse.down();
  for (const p of points.slice(1)) await tab.mouse.move(...p, { steps: 3 });
  const drawn = await tab.$eval('review-mode', h => {
    const c = h.shadowRoot.querySelector('.wet');
    return c
      .getContext('2d')
      .getImageData(0, 0, c.width, c.height)
      .data.some(v => v);
  });
  await tab.mouse.up();
  if (shift) await tab.keyboard.up('Shift');
  await tab.waitForSelector('review-mode .sheet:not([hidden])');
  return drawn;
}
const pinIt = async words => {
  await tab.fill('review-mode .sheet textarea', words);
  await tab.click('review-mode .send');
  await tab.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
};
const para = await tab.locator('body > p').boundingBox(),
  head = await tab.locator('body > h1').boundingBox();
const [x0, y0, x1, y1] = [
  Math.round(para.x - 12),
  Math.round(para.y - 10),
  Math.round(para.x + 300),
  Math.round(para.y + para.height + 10),
];
await tab.click('review-mode .fab', { force: true });
const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
  edges = [
    [(x0 + x1) / 2, y0],
    [x1, (y0 + y1) / 2],
    [(x0 + x1) / 2, y1],
    [x0, (y0 + y1) / 2],
  ];
assert.ok(
  await draw(
    [
      [x0, y0],
      [x0 + 100, y0 + 30],
      [x1, y1],
    ],
    true,
  ),
  'a rectangle while it is dragged',
);
assert.ok((await inkOn(edges)) && !(await inkNear([(x0 + x1) / 2, (y0 + y1) / 2])), 'and once it is drawn');
await pinIt('Box this line');
const boxed = theirs.find(n => n.note === 'Box this line');
assert.equal(boxed.element.kind, 'circle', 'a circle to everyone who reads the note');
assert.deepEqual(
  boxed.element.ink[0].points.map(p => p.slice(0, 2)),
  [...corners, corners[0]],
);
assert.deepEqual(boxed.element.area, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
const oval = n =>
  Array.from({ length: n }, (_, i) => [
    Math.round(head.x + 150 + 190 * Math.cos((i / n) * 2 * Math.PI)),
    Math.round(head.y + head.height / 2 + 45 * Math.sin((i / n) * 2 * Math.PI)),
  ]);
await tab.click('review-mode .fab', { force: true });
await draw(oval(16));
await pinIt('Circle the headline');
const circled = theirs.find(n => n.note === 'Circle the headline');
assert.ok(
  circled.element.kind === 'circle' && circled.element.ink[0].points.length >= 16,
  'without Shift, the freehand line',
);

// ---- pictures of the reviewer's own on a note, on a phone: a big screenshot pasted, a phone's photo and a sketch
// dropped, the sketch taken off again. Each is scaled down on the device and goes with the note. The same note as the
// board's, put on its sheet and sent by the real coordinator: one snip, the pictures under the screenshot, which hq
// note saves
await tab.setViewportSize({ width: 390, height: 844 });
const picturedAt = tab.url();
await tab.click('review-mode .fab', { force: true });
await tab.waitForSelector('review-mode .veil:not([hidden])');
const headline = await tab.locator('h1').boundingBox();
await tab.mouse.click(headline.x + 40, headline.y + headline.height / 2);
await tab.waitForSelector('review-mode .sheet:not([hidden])');
await tab.fill('review-mode textarea', 'Warmer, like these');
// made in the page: a 3000×1800 screenshot (a PNG), a 12-megapixel photo (a JPEG full of grain) and a small sketch
const made = ([width, height, type, name]) =>
  tab.evaluateHandle(
    async ([width, height, type, name]) => {
      const c = Object.assign(document.createElement('canvas'), { width, height }),
        g = c.getContext('2d');
      const fill = g.createLinearGradient(0, 0, width, height);
      fill.addColorStop(0, '#ffb36b');
      fill.addColorStop(1, '#6b8cff');
      g.fillStyle = fill;
      g.fillRect(0, 0, width, height);
      if (type === 'image/jpeg') {
        const grain = g.getImageData(0, 0, width, height);
        for (let i = 0; i < grain.data.length; i += 4) grain.data[i] ^= (i * 2654435761) >>> 27;
        g.putImageData(grain, 0, 0);
      }
      g.fillStyle = '#222';
      g.font = `${Math.round(height / 8)}px sans-serif`;
      g.fillText(name, width / 10, height / 2);
      return new File([await new Promise(r => c.toBlob(r, type, 0.95))], name, { type });
    },
    [width, height, type, name],
  );
const [screenshot, photoFile, sketch] = await Promise.all(
  [
    [3000, 1800, 'image/png', 'screen.png'],
    [4032, 3024, 'image/jpeg', 'IMG_2041.jpg'],
    [300, 200, 'image/png', 'sketch.png'],
  ].map(made),
);
// pasted: Ctrl+V with the screenshot on the clipboard
await context2.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PRODUCT });
await tab.evaluate(file => navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]), screenshot);
await tab.focus('review-mode textarea');
await tab.keyboard.press('ControlOrMeta+V');
const thumbs = () =>
  tab.$$eval('review-mode .sheet .pics li', ls =>
    ls.map(l => (l.classList.contains('busy') ? 'busy' : l.querySelector('img').naturalWidth > 0 ? 'shown' : 'blank')),
  );
await tab.waitForFunction(
  () => document.querySelector('review-mode').shadowRoot.querySelectorAll('.sheet .pics li:not(.busy)').length === 1,
  null,
  { timeout: 10_000 },
);
assert.equal(
  await tab.inputValue('review-mode textarea'),
  'Warmer, like these',
  'a pasted picture adds nothing to the words',
);
// dropped: the photo and the sketch, dragged onto the note together (which lights up as they come over it)
const droppedFiles = await tab.evaluateHandle(
  files => {
    const d = new DataTransfer();
    for (const f of files) d.items.add(f);
    return d;
  },
  [photoFile, sketch],
);
await tab.locator('review-mode .sheet').dispatchEvent('dragover', { dataTransfer: droppedFiles });
assert.ok(
  await tab.$eval('review-mode .sheet', s => s.classList.contains('taking')),
  'the note lights up under a dragged file',
);
await tab.locator('review-mode .sheet').dispatchEvent('drop', { dataTransfer: droppedFiles });
await tab.waitForFunction(
  () => document.querySelector('review-mode').shadowRoot.querySelectorAll('.sheet .pics li:not(.busy)').length === 3,
  null,
  { timeout: 15_000 },
);
assert.deepEqual(await thumbs(), ['shown', 'shown', 'shown'], 'three thumbnails under the words');
assert.equal(tab.url(), picturedAt, 'the page stays');
await shot('note-pictures', tab);
// the sketch taken off with its ×
await tab.click('review-mode .sheet .pics li:nth-child(3) .x');
assert.deepEqual(await thumbs(), ['shown', 'shown']);
await tab.click('review-mode .send');
await tab.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
const pictureNote = theirs.find(n => n.note === 'Warmer, like these');
const [pastedPicture, droppedPicture] = pictureNote.posted.pictures;
assert.equal(pictureNote.posted.pictures.length, 2, 'the two left on it went with the note');
// each drawn again at most 2,000 px a side, under what the coordinator keeps: the screenshot still a PNG, the photo a JPEG
const sizeOf = data =>
  tab.evaluate(async data => {
    const i = new Image();
    i.src = data;
    await i.decode();
    return [i.naturalWidth, i.naturalHeight];
  }, data);
assert.deepEqual([pastedPicture.slice(0, 15), await sizeOf(pastedPicture)], ['data:image/png;', [2000, 1200]]);
assert.deepEqual([droppedPicture.slice(0, 16), await sizeOf(droppedPicture)], ['data:image/jpeg;', [2000, 1500]]);
assert.ok(
  pictureNote.posted.pictures.every(p => p.length < 2_000_000),
  'each fits what the coordinator keeps',
);
// Cancel while a picture dropped on a note is still read: nothing goes, and the pin starts the next note (the read
// held here.)
await tab.click('review-mode .fab', { force: true });
await tab.waitForSelector('review-mode .veil:not([hidden])');
await tab.mouse.click(headline.x + 40, headline.y + headline.height / 2);
await tab.waitForSelector('review-mode .sheet:not([hidden])');
await tab.fill('review-mode textarea', 'Never sent');
await tab.evaluate(() => {
  const decode = (window.unheld = HTMLImageElement.prototype.decode),
    held = new Promise(res => (window.letRead = res));
  HTMLImageElement.prototype.decode = async function () {
    await held;
    return decode.call(this);
  };
});
const heldDrop = await tab.evaluateHandle(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 300, height: 200 }),
    d = new DataTransfer();
  d.items.add(new File([await new Promise(res => c.toBlob(res))], 'held.png', { type: 'image/png' }));
  return d;
});
await tab.locator('review-mode .sheet').dispatchEvent('drop', { dataTransfer: heldDrop });
await tab.waitForSelector('review-mode .sheet .pics li.busy');
const postedBefore = theirs.length;
await tab.click('review-mode .send');
await tab.click('review-mode [data-cancel]');
await tab.evaluate(() => {
  window.letRead();
  HTMLImageElement.prototype.decode = window.unheld;
});
await tab.waitForTimeout(800);
assert.equal(theirs.length, postedBefore, 'the cancelled note went nowhere');
assert.ok(await tab.isHidden('review-mode .sheet'), 'and its sheet stays away');
await tab.click('review-mode .fab', { force: true });
await tab.waitForSelector('review-mode .veil:not([hidden])', { timeout: 3000 });
// the next post-it is its own: nothing of the cancelled change touches it
const nextHeadline = await tab.locator('h1').boundingBox();
await tab.mouse.click(nextHeadline.x + 40, nextHeadline.y + nextHeadline.height / 2);
await tab.waitForSelector('review-mode .sheet:not([hidden])');
await tab.fill('review-mode textarea', 'The next one');
await tab.waitForTimeout(800);
assert.equal(await tab.inputValue('review-mode textarea'), 'The next one', 'the next post-it keeps its words');
assert.ok(await tab.isEnabled('review-mode .send'), 'and can be pinned');
await tab.click('review-mode [data-cancel]');
await tab.waitForSelector('review-mode .veil', { state: 'hidden' });
assert.deepEqual(askedGone, [], "the outsider's tool asked for nothing that's gone");
// hq note: the note as review mode posted it, the board's now, put on Bolt's sheet by the real coordinator (the test
// company, a throwaway DATA_DIR), sent with the plane (its ten seconds over), and read back by the real hq
const coordinator = `
  const { fixtureRepo } = await import(${JSON.stringify(`${ROOT}/platform/coordinator/src/fixture.ts`)});
  fixtureRepo();
  process.env.DATA_DIR = (await import('node:fs')).mkdtempSync(process.env.TMPDIR + '/notes-check-');
  process.env.PUBLIC_HOST = 'hq.company.test';
  const feedback = await import(${JSON.stringify(`${ROOT}/platform/coordinator/src/feedback.ts`)});
  const { SEND_MS } = await import(${JSON.stringify(`${ROOT}/platform/coordinator/src/ink/booknotes.ts`)});
  const booksheets = await import(${JSON.stringify(`${ROOT}/platform/coordinator/src/ink/booksheets.ts`)});
  const { db } = await import(${JSON.stringify(`${ROOT}/platform/coordinator/src/db.ts`)});
  const posted = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));
  const on = await feedback.saveNote('hello', 'hello.preview.test', posted);
  booksheets.send(db.prepare('select sheet from book_notes where id = ?').get(on.id).sheet);
  booksheets.deliverDue(Date.now() + SEND_MS + 1);
  const { review } = db.prepare('select review from book_notes where id = ?').get(on.id);
  process.stdout.write(JSON.stringify({ owner: on.owner, note: feedback.forWorker(review) }));`;
const { owner: sentTo, note: sentNote } = JSON.parse(
  execFileSync(process.execPath, ['--input-type=module', '-e', coordinator], {
    input: JSON.stringify(pictureNote.posted),
    maxBuffer: 64 << 20,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? '/tmp' },
  }),
);
assert.equal(sentTo, 'bolt', "on hello's owner's sheet");
const agentApi = createServer((q, s) =>
  s.end(q.url === `/api/agent/note?id=${sentNote.id}` ? JSON.stringify(sentNote) : '{}'),
);
await new Promise(r => agentApi.listen(0, '127.0.0.1', r));
const saved = await new Promise((resolve, reject) =>
  execFile(
    `${ROOT}/platform/worker/bin/hq`,
    ['note', String(sentNote.id)],
    {
      env: {
        PATH: process.env.PATH,
        HQ_URL: `http://127.0.0.1:${agentApi.address().port}`,
        HQ_TOKEN: 'job-token',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
      },
    },
    (err, out) => (err ? reject(err) : resolve(out)),
  ),
);
agentApi.close();
assert.doesNotMatch(saved, /^Picture \d+:/m, 'the pictures are in the snip, not apart');
const snipFile = saved.match(/^Screenshot: (\S+)$/m)[1];
// the snip: the screen cut around the headline, then the pasted screenshot and the photo under it, centred in the
// widest's width (bookreview.ts): taller than the two pictures alone at that width
const snipSize = await tab.evaluate(
  async data => {
    const i = new Image();
    i.src = data;
    await i.decode();
    return [i.naturalWidth, i.naturalHeight];
  },
  `data:image/jpeg;base64,${(await readFile(snipFile)).toString('base64')}`,
);
assert.ok(
  snipSize[1] > snipSize[0] * (1200 / 2000 + 1500 / 2000),
  `the pictures under the cut screenshot (${snipSize.join('×')})`,
);
await rm(snipFile);
await guest.context.close();
// ---- on a shelf (the front's preview door, /hello/): the script loaded by its relative address posts next to itself
const SHELF = 'https://front.preview.test',
  toShelf = [];
await context.route(`${SHELF}/**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (path.startsWith('/hello/') && fulfilPart(r, path, reviewJs)) return;
  if (path === '/hello/__review/coach') return r.fulfill({ json: { show: false } });
  if (path === '/hello/__review/mine')
    return r.fulfill({
      json: { book: OWNER, notes: toShelf.filter(p => p.endsWith('/notes')).length },
    });
  if (path.includes('/__review/') && r.request().method() === 'POST') {
    toShelf.push(path);
    return r.fulfill({ json: { ok: true, id: ++lastId } });
  }
  return r.fulfill({ contentType: 'text/html', body: PAGE.replace('src="/__review/', 'src="./__review/') });
});
const shelf = await context.newPage();
shelf.on('pageerror', e => errors.push(e.message));
await shelf.goto(`${SHELF}/hello/`);
await pinNote(shelf, 'Seen on a shelf', () => shelf.click('review-mode .fab', { force: true }), shelf.mouse);
// (the mark started the mic: its clip, if it went, goes there too)
assert.deepEqual(
  toShelf.filter(p => p !== '/hello/__review/voice'),
  ['/hello/__review/notes'],
  "a shelf's note goes to its own path",
);

await shelf.close();

// ---- HQ itself: review mode over HQ's own screens (drawn under HQ's CSP, which admits no inline style), its note goes
// into the board's book, on the sheet of HQ's page there (book-check.mjs has the Pencil's story).
const onHq = [];
await context.route(`${base}/__review/**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (fulfilPart(r, path, reviewJs)) return;
  if (path === '/__review/coach') return r.fulfill({ json: { show: false } });
  if (path === '/__review/mine') return r.fulfill({ json: { notes: 0 } }); // (HQ's notes are the book's:)
  if (path === '/__review/notes') {
    onHq.push(path);
    return r.fulfill({ json: { ok: true, id: ++lastId } });
  }
  return r.fulfill({ status: 404, body: '' });
});
await context.route(`${base}/?intro=0`, async r =>
  r.fulfill({
    response: await r.fetch(),
    headers: {
      'content-security-policy':
        "default-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' https://*.preview.test",
    },
  }),
); // (frame-src)
const hq = await context.newPage();
hq.on('pageerror', e => errors.push(e.message));
await hq.goto(`${base}/?intro=0`);
await until(hq, '#loading.gone');
await hq.waitForSelector('review-mode .fab', { state: 'attached' }); // (signed in, HQ always has it)
// away as HQ loads, the phone's pin comes with the book's pin control, which folds the book onto HQ (pinsummon.js)
await hq.click('#book .bk-lip');
await hq.waitForFunction(() => document.documentElement.dataset.book === 'spread');
await hq.click('#book .bk-pin');
await hq.waitForSelector('review-mode .fab');
// (the book folded and the pin's pop done: a tap while it's still coming back misses it.)
await hq.waitForSelector('html[data-book=folded]', { state: 'attached' });
await hq.waitForFunction(() =>
  document
    .querySelector('review-mode')
    .shadowRoot.getAnimations()
    .every(a => !(a instanceof CSSTransition)),
);
assert.equal(
  await hq.$eval('review-mode .fab', b => getComputedStyle(b).position),
  'absolute',
  "review mode is drawn under HQ's CSP",
);
await hq.click('review-mode .fab', { force: true });
await hq.waitForSelector('review-mode .veil:not([hidden])');
await hq.mouse.click(120, 24); // (HQ's plate, up in the corner)
// (a mark on HQ has no post-it: it goes into the book as it settles, with the words heard while it was made, here none:
// settle.js.)
await hq.waitForSelector('review-mode .veil', { state: 'hidden', timeout: 20_000 });
assert.ok(await hq.isHidden('review-mode .sheet'), "HQ's mark has no post-it");
assert.deepEqual(onHq, [], "a note on HQ doesn't go through review mode's door");
assert.deepEqual(
  pencilled.map(b => ({
    page: pages.some(p => p.id === b.page),
    words: b.words,
    said: b.said,
    v: b.anchor.v,
    pinned: !!b.anchor.el,
  })),
  [{ page: true, words: '', said: null, v: 1, pinned: true }],
  'it goes on its sheet in the book',
);
await shot('hq-pinned', hq);
await hq.click('review-mode .more');
assert.deepEqual(
  await hq.$$eval('review-mode .menu .items button:not([hidden])', items => items.map(i => i.firstChild.textContent)),
  ['General note'],
  'its menu, its notes sent: a general note, and no switch to put the pin away',
);
await hq.click('review-mode [data-general]');
const draft = 'The cards row is cut off on the right';
await hq.fill('review-mode textarea', draft);
// one pin at a time: a preview in the viewer shows only its own, and HQ's draft is back as it closes
const pinsShown = async () =>
  (
    await Promise.all(
      hq
        .frames()
        .map(f =>
          f.$$eval('review-mode', hosts =>
            hosts.filter(h => h.shadowRoot.querySelector('.fab').checkVisibility()).map(() => location.origin),
          ),
        ),
    )
  ).flat();
await hq.evaluate(href => {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = 'preview';
  document.body.append(a);
  a.click();
  a.remove();
}, `${PRODUCT}/`);
await hq.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
await hq.frame({ url: `${PRODUCT}/` }).waitForSelector('review-mode .fab');
assert.deepEqual(await pinsShown(), [PRODUCT], 'a framed preview shows exactly one pin, its own');
// (and HQ's covered note takes no picture pasted or dropped on HQ's page, while a drop still doesn't open the file.)
const missed = await hq.evaluate(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 40, height: 30 });
  const files = new DataTransfer();
  files.items.add(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'covered.png', { type: 'image/png' }));
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: files, bubbles: true, cancelable: true }));
  const over = new DragEvent('dragover', { dataTransfer: files, bubbles: true, cancelable: true }),
    drop = new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true });
  document.body.dispatchEvent(over);
  document.body.dispatchEvent(drop);
  const sheet = document.querySelector('review-mode').shadowRoot.querySelector('.sheet');
  return {
    effect: over.dataTransfer.dropEffect,
    opened: !drop.defaultPrevented,
    pictures: sheet.querySelectorAll('.pics li').length,
    lit: sheet.classList.contains('taking'),
  };
});
assert.deepEqual(
  missed,
  { effect: 'none', opened: false, pictures: 0, lit: false },
  "HQ's covered note ignores a paste and a drop on HQ's page",
);
await hq.keyboard.press('Escape');
await Promise.all([hq.waitForEvent('framedetached'), hq.click('#viewer [data-close]')]);
assert.equal(
  await hq.inputValue('review-mode textarea'),
  draft,
  "opening a preview and pressing Escape keeps HQ's draft",
);
await hq.waitForSelector('review-mode .sheet:not([hidden])');
await hq.click('review-mode [data-cancel]');
assert.deepEqual(await pinsShown(), [base], "HQ's own pin is back once the viewer closes");

assert.deepEqual(errors, []);
assert.deepEqual(guest.errors, []);
await context.unrouteAll({ behavior: 'ignoreErrors' }); // (HQ still polling as it closes)
await browser.close();
server.close();
console.log(
  `notes-check: Reviews' Sent (each sheet one block, no ticks, Send or Discard); the board's note pinned in HQ's viewer going on Bolt's sheet in the book, nothing over the page and no Send on the slim bar, the polaroid framed on the pin, the screen and touch points kept; the board's menu "For Bolt · 1 on the sheet" every line on one line on a phone, its Open the book opening HQ's book at Bolt's sheet over the viewer on a phone (after a late goodbye too) and, in a tab of its own, HQ at that sheet; the board's general note pinned to nothing; an outsider's menu (a general note, and where their notes go, asking nothing of theirs back), Shift's rectangle and the freehand circle; pictures pasted, dropped and taken off a note (scaled on the device), a note cancelled while one is read going nowhere; that note sent from the board's sheet by the real coordinator as one snip with its pictures, saved by hq note; a shelf's note on its own path; the pin always on HQ itself (its note on its sheet in the book), one pin over a framed preview (HQ's covered note taking nothing pasted or dropped)${shots ? ` (screenshots in ${shots})` : ''}`,
);
