// book-check.mjs's second-screen story (shell/ink/pair.js, pairink.js, shared/review/handover.js; Ink's folder.): an iPad mini in WebKit and a desktop in Chromium, the coordinator's pairing
// (pair.ts) played in between. The desktop's book shows a code (its QR and six digits); the iPad opens HQ with it and
// the two are paired: the book stays open on the desktop and folds away on the iPad, each saying who it's paired with,
// the swap in both rails. A ring the Pencil draws on the iPad shows on the desktop's page while it's still being drawn,
// round the same element in the desktop's own layout; lifted and rested, the mark goes into the book from the iPad, no
// post-it on either screen, and the desktop's book turns to its note. Swapped, the desktop holds the page and the iPad
// the book: a ring on the desktop goes in from there, and the iPad's book turns to it. A page closed on one closes on
// the other, and Close ends it on both. Once each mark is in the book, nothing of it is drawn on either screen (rule
// zero: bookink.mjs).
// A phone paired the same way is bookphone.mjs's.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../shared/browser/browser.mjs';
import { nothingDrawn } from './bookink.mjs';

export const DESKTOP = { width: 1280, height: 800 },
  PHONE = { width: 390, height: 844 };

// The coordinator's pairing as a stand-in, shared by both contexts: a code makes a pairing, joining it tells both
// sides 'paired', a send reaches the other side. Its stream is answered as a long poll (each answer ends, and the
// EventSource comes back at once), which a route can do where it can't hold a stream open.
export function pairRelay() {
  const relay = { pairs: new Map(), codes: new Map(), made: 0 };
  const route = async r => {
    const req = r.request(),
      url = new URL(req.url()),
      body = req.method() === 'POST' ? req.postDataJSON() : null;
    if (url.pathname === '/api/pair') return r.fulfill({ json: codeFor(relay, body) });
    if (url.pathname === '/api/pair/join') return joined(relay, r, body);
    const pr = relay.pairs.get(url.searchParams.get('pair') ?? body?.pair),
      key = url.searchParams.get('key') ?? body?.key,
      side = pr && (pr.keys.a === key ? 'a' : pr.keys.b === key ? 'b' : null);
    if (!side) return r.fulfill({ status: 403, json: { error: 'Not this pairing' } });
    if (url.pathname === '/api/pair/live') return r.fulfill(await streamed(pr, side));
    const other = side === 'a' ? 'b' : 'a';
    if (url.pathname === '/api/pair/send') for (const ev of body.events) push(pr, other, ev);
    else if (url.pathname === '/api/pair/end') push(pr, other, state('ended'));
    else return r.fulfill({ status: 404, json: {} });
    return r.fulfill({ json: { ok: true } });
  };
  return route;
}
const state = s => ({ tag: 'pair', payload: { state: s } });
function push(pr, side, ev) {
  pr.queue[side].push({ id: pr.queue[side].length + 1, ev });
  for (const wake of pr.waiting[side].splice(0)) wake();
}
// A pairing's code: a new pairing, or a fresh code for one waiting
function codeFor(relay, body) {
  let pr = relay.pairs.get(body?.pair);
  if (!pr) {
    const n = ++relay.made;
    pr = {
      id: `p${n}`,
      keys: { a: `ka${n}`, b: `kb${n}` },
      queue: { a: [], b: [] },
      given: { a: 0, b: 0 },
      waiting: { a: [], b: [] },
    };
    relay.pairs.set(pr.id, pr);
    push(pr, 'a', state('waiting'));
  }
  for (const [c, id] of relay.codes) if (id === pr.id) relay.codes.delete(c);
  const code = String(100_000 + Math.floor(Math.random() * 900_000));
  relay.codes.set(code, pr.id);
  return { pair: pr.id, side: 'a', key: pr.keys.a, code, expires: Date.now() + 60_000 };
}
function joined(relay, r, body) {
  const pr = relay.pairs.get(relay.codes.get(String(body.code)));
  if (!pr) return r.fulfill({ status: 404, json: { error: 'No such code' } });
  relay.codes.delete(String(body.code));
  push(pr, 'a', state('paired'));
  push(pr, 'b', state('paired'));
  return r.fulfill({ json: { pair: pr.id, side: 'b', key: pr.keys.b } });
}
// What a side hasn't been given yet, or the next event within a moment. (A route doesn't see the EventSource's
// Last-Event-ID: the coordinator's tests prove a stream picked up again after a drop.)
async function streamed(pr, side) {
  const after = pr.given[side],
    fresh = () => pr.queue[side].filter(e => e.id > after);
  if (!fresh().length) await new Promise(wake => (pr.waiting[side].push(wake), setTimeout(wake, 400)));
  pr.given[side] = pr.queue[side].length;
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    body: `retry: 10\n\n${fresh()
      .map(e => `id: ${e.id}\ndata: ${JSON.stringify(e.ev)}\n\n`)
      .join('')}`,
  };
}

// c: book-check's { hqIn, base, penOn, ring, ui, posts, notes, shot }, with the iPad's browser (pad: WebKit) and the
// desktop's (desk: Chromium, as a desktop's Chrome)
export async function pairStory(c) {
  const route = pairRelay();
  const desk = await c.hqIn(c.desk, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 }),
    pad = await c.hqIn(c.pad);
  for (const context of [desk, pad]) await context.route(/\/api\/pair(\/[a-z]+)?(\?.*)?$/, route);
  const s = { ...c, route, ...(await paired(c, desk, pad)) };
  for (const page of [s.d.page, s.p.page]) await watchSheet(page);
  await settledOnTheIPad(s, await liveAcross(s));
  await swapped(s);
  for (const page of [s.d.page, s.p.page]) assert.equal(await sheetShowed(page), false, 'no post-it on either screen');
  await closed(s);
  await desk.close();
  await pad.close();
}

// HQ open at an address, with its errors counted
export async function opened(c, context, url) {
  const page = await context.newPage(),
    errors = errorsOf(page);
  await page.goto(`${c.base}${url}`);
  await until(page, '#loading.gone');
  await page.waitForSelector('review-mode .fab', { state: 'attached' }); // (away while the book's folded)
  return { page, errors };
}

// The desktop's code, its QR and its digits at the book's foot; the iPad opens its link: paired, the book open on the
// desktop and folded on the iPad
async function paired(c, desk, pad) {
  const d = await opened(c, desk, '/?intro=0&open=phone');
  // (the phone in the book's overview, closed again once the code shows)
  const overview = d.page.locator('#book').getByRole('button', { name: /^The overview/ });
  await overview.click();
  await d.page.getByRole('button', { name: 'Draw from your phone' }).click();
  await d.page.waitForSelector('#book .pair-qr path');
  await overview.click();
  assert.ok((await d.page.getAttribute('#book .pair-qr path', 'd')).length > 200, 'the book shows a QR to scan');
  const code = (await d.page.textContent('#book .pair-digits')).replace(/\D/g, '');
  assert.equal(code.length, 6, 'and six digits to type');
  await c.shot('pair-code', d.page);
  const p = await opened(c, pad, `/?intro=0&open=phone&pair=${code}`);
  // (which word each uses comes from its touch points, which an emulated iPad in headless WebKit doesn't have)
  await until(d.page, '#book .pair-line', /Your (tablet|phone|computer) draws here/, 10_000);
  await bookIs(p.page, 'folded');
  // (the iPad's book is folded away, its card with it: its words, not what shows.)
  await p.page.waitForFunction(
    () => /Paired with your (tablet|phone|computer)/.test(document.querySelector('#book .pair-line')?.textContent),
    null,
    { timeout: 10_000 },
  );
  assert.equal(await d.page.evaluate(() => document.documentElement.dataset.book), 'open', "the desktop's book stays");
  // (on the folded book's card too, which shows once the book comes out)
  for (const page of [d.page, p.page])
    assert.ok(await page.$eval('#book .bk-swap', b => !b.hidden), "the swap is on each pairing's card");
  return { d, p };
}
export const bookIs = (page, mode) =>
  page.waitForFunction(m => document.documentElement.dataset.book === m, mode, { timeout: 5000 });
export const ringRound = (c, page, b, opts) =>
  c.penOn(page)(c.ring(b.x, b.y, Math.min(140, b.w / 2 + 20), Math.min(60, b.h / 2 + 16)), opts);

// A ring on the iPad, round something of the phone's (on the desktop it's elsewhere and another size): live on the
// desktop while it's drawn, round the same element there
async function liveAcross({ d, p, ...c }) {
  const target = await p.page.evaluate(async () => {
    const { selector } = await import('/__review/anchor.js');
    const el = [...document.querySelectorAll('#tool .device *')].find(e => {
        const r = e.getBoundingClientRect();
        return (
          r.width > 120 && r.width < 500 && r.height > 30 && r.height < 200 && r.top > 80 && r.bottom < innerHeight - 80
        );
      }),
      b = el.getBoundingClientRect();
    return { sel: selector(el), x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
  });
  await ringRound(c, p.page, target, { lift: false });
  await d.page.evaluate(async () => (window.__anchor = await import('/__review/anchor.js')));
  const seen = await (await d.page.waitForFunction(inkOver, target.sel, { timeout: 5000, polling: 100 })).jsonValue();
  const near = (v, from, size) => v > from - 30 && v < from + size + 30;
  assert.ok(
    near(seen.x, seen.box.x, seen.box.w) && near(seen.y, seen.box.y, seen.box.h),
    `the iPad's ring shows on the desktop as it's drawn, round the same element (${JSON.stringify(seen)})`,
  );
  await c.shot('pair-live-ring', d.page);
  await c.shot('pair-live-ring-ipad', p.page);
  return target;
}
// (in the desktop's page: the middle of the other screen's ink, once there's some, and the element's box)
function inkOver(sel) {
  const canvas = document.querySelector('.pair-ink'),
    k = canvas.width / canvas.getBoundingClientRect().width,
    px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0,
    sx = 0,
    sy = 0;
  for (let i = 3; i < px.length; i += 4 * 3)
    if (px[i] > 200) {
      const at = (i - 3) / 4;
      n++;
      sx += (at % canvas.width) / k;
      sy += Math.floor(at / canvas.width) / k;
    }
  const b = n >= 100 && window.__anchor.found(sel, document)?.getBoundingClientRect();
  return b ? { x: sx / n, y: sy / n, box: { x: b.left, y: b.top, w: b.width, h: b.height } } : null;
}

// Lifted and rested, the mark goes into the book from the iPad, its ring and snip with it, and the desktop's book turns
// to its note
async function settledOnTheIPad({ d, p, ...c }, target) {
  const from = c.notes.length;
  await p.page.evaluate(() => window.__lift());
  const note = await noteIn(c, p.page, from);
  // (the Pencil's own pick: the smallest element holding most of the ring, inside the one it was drawn round)
  const on = note.anchor.el?.selector;
  assert.ok(on?.startsWith(target.sel), `on what the iPad's ring was round (${on})`);
  assert.ok(note.anchor.ink.length >= 1, "with the iPad's ring as its ink");
  assert.ok(note.snip, 'and its snip');
  await bookShows(d.page, note, "the desktop's book turns to the iPad's note");
  for (const [page, which] of [
    [d.page, 'the desktop'],
    [p.page, 'the iPad'],
  ])
    await nothingDrawn(page, `${which}, the iPad's mark in the book`);
  await c.shot('pair-noted', d.page);
}
// The next note in the book's store after the first `from`, waited for
export async function noteIn(c, page, from) {
  // (its snip's screenshot: a few seconds on a loaded worker's headless WebKit)
  for (let i = 0; i < 150 && c.notes.length === from; i++) await page.waitForTimeout(150);
  assert.ok(
    c.notes.length > from,
    `the mark goes into the book as it rests (last posted: ${c.posts?.slice(-4).map(p => p.path)})`,
  );
  return c.notes[from];
}
// A screen's book showing a note on the page turned to: the scrap it was carried into on the Notebook's current page
// (book-check.mjs carryNotes, as the coordinator's notebookcarry.ts does).
export async function bookShows(page, note, what) {
  for (let i = 0; i < 100 && !note.group; i++) await page.waitForTimeout(100);
  if (!note.group) assert.fail(`${what}: the note never went onto the Notebook`);
  await page
    .waitForSelector(`#book .bk-world .bk-page:not([hidden]) .bk-clip[data-g="${note.group}"]`, {
      state: 'attached',
      timeout: 10_000,
    })
    .catch(() => assert.fail(what));
}

// Swapped: the book on the iPad, the page on the desktop, where a ring now goes into the book from there, the iPad's
// book turning to it
async function swapped({ d, p, ...c }) {
  await d.page.click('#book .bk-swap');
  await bookIs(p.page, 'open');
  await bookIs(d.page, 'folded');
  const there = { x: 1000, y: 620, w: 160, h: 80 },
    from = c.notes.length;
  await ringRound(c, d.page, there);
  const note = await noteIn(c, d.page, from);
  await bookShows(p.page, note, "the iPad's book turns to the desktop's note");
  for (const [page, which] of [
    [d.page, 'the desktop'],
    [p.page, 'the iPad'],
  ])
    await nothingDrawn(page, `${which}, the desktop's mark in the book`);
  await c.shot('pair-swapped', p.page);
}

// A page closed on one screen closes on the other; Close on the screen with the book ends the pairing on both
async function closed({ d, p }) {
  await d.page.keyboard.press('Escape');
  // (10 s: the stand-in relay's long poll on a loaded worker.)
  await p.page.waitForSelector('#tool', { state: 'hidden', timeout: 10_000 });
  await p.page.click('#book .pair-line [data-do=end]');
  await d.page.waitForFunction(() => !('paired' in document.documentElement.dataset), null, { timeout: 5000 });
  assert.equal(await d.page.isVisible('#book .bk-swap'), false, 'the swap goes with the pairing');
  for (const [page, which] of [
    [d.page, 'the desktop'],
    [p.page, 'the iPad'],
  ])
    await nothingDrawn(page, `${which}, unpaired`);
  for (const { errors } of [d, p]) assert.deepEqual(errors, [], 'no errors on either screen');
}

// (in the page: whether review mode's post-it shows at any moment from now, seen each time it changes)
export function watchSheet(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('review-mode').shadowRoot.querySelector('.sheet'),
      look = () => (window.__sheetShown ||= !sheet.hidden);
    window.__sheetShown = false;
    new MutationObserver(look).observe(sheet, { attributes: true });
    look();
  });
}
export const sheetShowed = page => page.evaluate(() => window.__sheetShown);
