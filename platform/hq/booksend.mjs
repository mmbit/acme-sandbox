// book-check.mjs's story of a page's Send (shell/ink/bookpagesend.js), on the played Notebook seeded as dev mode's
// (My Notebook's three pages, the first sent), on the iPad mini upright (touch) and a desktop: the page sent folds into
// a paper plane and the book is left on the page under it, the next, with no page made and none other turned to; its
// Undo brings it back; the last page sent leaves a fresh page under it. A sent page wears the red stamp with its day and
// time, clear of the tools, still wet while it sends; and there's no Send on a call's own page while the call is on.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clipped, turnTo, where } from './booknotebookscreen.mjs';
import { DESKTOP, MINI, until } from './bookkit.mjs';

const SEED = JSON.parse(await readFile(new URL('./mock/notebook.json', import.meta.url), 'utf8'));
const UPRIGHT = { width: MINI.height, height: MINI.width };
// the seed's pages in My Notebook (mock/notebook.json)
const SENT = 1,
  SECOND = 2,
  NEWEST = 3;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function sendStories(c) {
  return {
    'Send: a paper plane, the book left on the page under it (a fresh one after the last), the sent page stamped, none on the call page':
      browser => sends(browser, c),
  };
}

async function sends(browser, c) {
  for (const [viewport, touch] of [
    [UPRIGHT, true],
    [DESKTOP, false],
  ]) {
    const size = `${viewport.width}x${viewport.height}`,
      { page, play, errors, done } = await open(browser, c, viewport, touch);
    const press = name => {
      const button = page.locator('#book').getByRole('button', { name, exact: true });
      return touch ? button.tap() : button.click();
    };
    try {
      await onTheCall(page, size);
      await underIt(page, play, press, size);
      await c.shot(`book-send-under-${size}`, page);
      await stamped(page, size);
      await c.shot(`book-send-stamp-${size}`, page);
      c.noErrorsIn(errors);
    } finally {
      await done();
    }
  }
}

// No Send on the call's own page while the call is on (calldraw.js's call:page), and back once it's off
async function onTheCall(page, size) {
  const send = page.locator('#book').getByRole('button', { name: 'Send', exact: true });
  await until(() => send.isVisible(), `Send on an open page (${size})`);
  await page.evaluate(id => document.dispatchEvent(new CustomEvent('call:page', { detail: { page: id } })), NEWEST);
  await until(async () => !(await send.isVisible()), `no Send on the call's page while it's on (${size})`);
  await turnTo(page, SECOND);
  assert.ok(await send.isVisible(), `Send on another page during the call (${size})`);
  await turnTo(page, NEWEST);
  assert.ok(!(await send.isVisible()), `none again on the call's page (${size})`);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('call:off', { detail: { done: () => {} } })));
  await until(() => send.isVisible(), `Send back on it once the call's off (${size})`);
}

// The second page sent: a plane flies, the book shows the third (no page made, none other turned to), and Undo brings
// the second back; the third, the last, sent: a fresh page under it
async function underIt(page, play, press, size) {
  const count = () => pagesOf(play).length,
    before = count();
  await turnTo(page, SECOND);
  await watch(page);
  await press('Send');
  await until(() => pageOf(play, SECOND).sending, `the second page sending (${size})`);
  await until(async () => (await where(page)).endsWith(`${NEWEST} / ${before}`), `the page under it shown (${size})`);
  const seen = await page.evaluate(() => window.__sent);
  assert.ok(seen.planes >= 1, `the page flew off as a paper plane (${size})`);
  assert.deepEqual(seen.turns, [NEWEST], `turned to nothing but the page under it (${size})`);
  assert.equal(count(), before, `no page made while there's one under it (${size})`);
  // (headless WebKit plays it at a frame or so a second: late, but it ends)
  await until(async () => !(await page.locator('#book .bk-fx-plane').count()), `the plane gone (${size})`, 15_000);

  await page.locator('#toasts .toast', { hasText: 'Sent' }).locator('.cover').dispatchEvent('click');
  await until(() => !pageOf(play, SECOND).sending, `the send taken back (${size})`);
  await until(async () => (await where(page)).endsWith(`${SECOND} / ${before}`), `the page back (${size})`);

  await turnTo(page, NEWEST);
  await watch(page);
  await press('Send');
  await until(() => count() === before + 1, `a fresh page made under the last (${size})`);
  await until(async () => (await where(page)).endsWith(`${before + 1} / ${before + 1}`), `the fresh page (${size})`);
  assert.deepEqual((await page.evaluate(() => window.__sent)).turns, [pagesOf(play).at(-1).id], `only it (${size})`);
}

// The sent pages wear the red stamp at their head, clear of the tool strip: the first with its day and time, the last
// sent still wet
async function stamped(page, size) {
  await turnTo(page, NEWEST);
  const wet = await stampOf(page);
  assert.equal(wet.label, 'Sent', `the page sending stamped Sent (${size})`);
  assert.ok(wet.wet, `its ink still wet (${size})`);
  await turnTo(page, SENT);
  const dry = await stampOf(page);
  assert.match(dry.label, /^Sent \w+ \d\d:\d\d$/, `the sent page stamped with its day and time (${size})`);
  assert.ok(!dry.wet, `dry (${size})`);
  assert.equal(dry.colour, 'rgb(194, 54, 47)', `in the overview stamp's red (${size})`);
  assert.ok(dry.box.width >= 100 && dry.box.height >= 40, `big enough to see (${size}): ${JSON.stringify(dry.box)}`);
  assert.ok(inside(dry.box, dry.desk), `on the paper in view (${size})`);
  assert.ok(!dry.strip.some(b => overlaps(dry.box, b)), `clear of the tools (${size})`);
}

// ---- the page

// HQ at a size on the played Notebook, the book open on its newest page (upright, the iPad's starts folded: opened by
// its lip, as booknotebook.mjs's open, with a click, which a loaded worker never leaves half pulled)
async function open(browser, c, viewport, touch) {
  const context = await c.hqIn(browser, viewport, { notebooks: structuredClone(SEED), hasTouch: touch }),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  if (touch) {
    await c.settled(page, 'folded');
    await page.locator('#book .bk-lip').evaluate(lip => lip.click());
  }
  await c.settled(page, touch ? 'spread' : 'open');
  await until(async () => (await clipped(page)).length, 'the groups drawn');
  return { page, play: context.notebook, errors, done: () => context.close() };
}

// What the book does from here: planes flying, pages turned to (book:turn)
const watch = page =>
  page.evaluate(() => {
    const seen = (window.__sent = { planes: 0, turns: [] });
    document.addEventListener('book:turn', e => seen.turns.push(e.detail.page));
    new MutationObserver(changes => {
      for (const n of changes.flatMap(m => [...m.addedNodes])) if (n.classList?.contains('bk-fx-plane')) seen.planes++;
    }).observe(document.getElementById('book'), { childList: true, subtree: true });
  });
// The shown page's stamp: its words, wet or dry, its colour and box; the paper's and the tool strip's boxes
const stampOf = page =>
  page.evaluate(() => {
    const shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden),
      node = shown.querySelector('[data-slot=stamp]'),
      box = r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    return {
      label: node.querySelector('svg')?.getAttribute('aria-label') ?? '',
      wet: node.classList.contains('bk-stamp-wet'),
      colour: getComputedStyle(node).color,
      box: box(node.getBoundingClientRect()),
      desk: box(document.querySelector('#book .bk-desk').getBoundingClientRect()),
      strip: [...document.querySelectorAll('#book .bk-strip .bk-island')].map(el => box(el.getBoundingClientRect())),
    };
  });
const inside = (a, b) => a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// ---- the played store
const pagesOf = play => play.route('/api/notebooks/pages', { notebook: 1 }).pages;
const pageOf = (play, id) => pagesOf(play).find(p => p.id === id);
