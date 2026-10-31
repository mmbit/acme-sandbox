// book-check.mjs's story of a book's bookmarks (shell/ink/bookmarks.js) on My journal seeded with two sketch pages, its
// Asks page with three asks open and two calls' notes pages, one stamped Sent by its follow-up and one still with it. At
// a phone, an iPad mini upright and sideways and a wide desktop: the tabs placed (along the top upright, clear of the
// dog-ear; out of the page stack at the left sideways, never over the paper), the chapter shown lit, Asks' red count,
// each tab opening its chapter's first page and the bar counting within it, and the first call's page stamped Sent.
// Recorded with --shots.
import assert from 'node:assert/strict';
import { until } from './bookkit.mjs';
import { press } from './bookbar.mjs';
import { typedBoxes } from './shell/ink/notebookparts.js';

const T0 = '2026-10-29T15:00:00.000Z',
  ENDED = Date.parse('2026-10-29T16:21:00.000Z');
// (a tap or a wait on the shared machine under load: taps time out at 30 s there, on main too)
const LOADED_MS = 90_000;
const SIZES = {
  phone: { width: 390, height: 844 },
  'ipad-mini-upright': { width: 744, height: 1133 },
  'ipad-mini-sideways': { width: 1133, height: 744 },
  'phone-sideways': { width: 844, height: 390 },
  'desktop-wide': { width: 1920, height: 1080, book: 1100 },
};
const page = (id, pos, label, more = {}) => ({
  id,
  notebook: 1,
  pos,
  label,
  created: T0,
  updated: T0,
  w: 1200,
  h: 1600,
  ...more,
});
// a note typed on a page, by the call's agent
const note = (id, on, words) => ({
  id,
  page: on,
  kind: 'note',
  by: 'lyra',
  owner_name: 'Lyra',
  ink: [],
  texts: typedBoxes(words, { x: 0, w: 320, color: '#1d1a2f' }),
  pictures: [],
  words: '',
  said: 'typed',
  status: 'sent',
  created: T0,
  updated: T0,
  pos: id,
  h: 136,
});
const SEED = {
  notebooks: [
    {
      id: 1,
      kind: 'mine',
      name: 'My journal',
      archived: false,
      created: T0,
      updated: T0,
      asks: { open: 3, all: 4 },
    },
  ],
  pages: [
    page(1, 0, 'Ideas'),
    page(2, 1, 'Call with Lyra: cover edge', { kind: 'call', send_at: ENDED - 3_600_000, followed: ENDED }),
    page(3, 2, 'Shop page'),
    page(4, 3, 'Asks', { kind: 'asks' }),
    page(5, 4, 'Call with Moss', { kind: 'call', send_at: ENDED }),
  ],
  groups: [
    note(1, 2, 'Cover on top, bottom, outer edge; never on the spine.'),
    note(2, 2, 'Promise for Marloes: cover edge, once it is sent.'),
    note(3, 5, 'Tabs a little bigger.'),
  ],
  slips: [],
  asks: [],
  names: { lyra: 'Lyra', moss: 'Moss' },
};

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function bookmarksStories(c) {
  return {
    "the book's bookmarks: Sketch, Asks and Calls placed by the screen's orientation, and a call's page under Calls stamped by its follow-up":
      async browser => {
        const failed = [];
        for (const [name, size] of Object.entries(SIZES))
          await atSize(browser, c, name, size).catch(e => failed.push(e.message));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

async function atSize(browser, c, name, size) {
  const { book, ...viewport } = size,
    context = await c.hqIn(browser, viewport, { notebooks: structuredClone(SEED), hasTouch: false, isMobile: false });
  if (book)
    await context.addInitScript(
      w => localStorage.setItem('hq.book.wide', JSON.stringify({ mode: 'open', book: w })),
      book,
    );
  const p = await context.newPage(),
    errors = [];
  p.on('pageerror', e => errors.push(e.message));
  try {
    await opened(p, c);
    await p.waitForTimeout(500);
    await placed(p, name);
    for (const [chapter, first, where] of [
      ['sketch', 'Ideas', '1/2'],
      ['asks', 'Asks', '1/1'],
      ['calls', 'Call with Lyra: cover edge', '1/2'],
    ]) {
      await p.locator(`#book .bk-marks [data-chapter=${chapter}]`).click({ timeout: LOADED_MS });
      await until(async () => (await shown(p)).title === first, `${name}: ${chapter} opens ${first}`, 8000);
      await p.waitForTimeout(700);
      const s = await shown(p);
      assert.equal(s.lit, chapter, `${name}: the ${chapter} tab lit`);
      assert.equal(s.where, where, `${name}: the bar counts within ${chapter}`);
      if (chapter === 'calls') assert.match(s.stamp ?? '', /^Sent\b.*\d\d:\d\d$/, `${name}: the call's page stamped`);
      await c.shot(`bookmarks-${name}-${chapter}`, p);
    }
    // (the call still with its follow-up: the next page under Calls, shut and unstamped)
    await p.locator('#book .bk-btn[aria-label="The page after"]').click({ timeout: LOADED_MS });
    await until(async () => (await shown(p)).title === 'Call with Moss', `${name}: the next call`, 8000);
    await p.waitForTimeout(700);
    const moss = await shown(p);
    assert.deepEqual([moss.where, moss.stamp], ['2/2', null], `${name}: with its follow-up, unstamped`);
    assert.equal((await tabs(p)).find(t => t.chapter === 'asks').count, '3', `${name}: Asks' count`);
    await noneFar(p, name);
    await c.shot(`bookmarks-${name}-overview`, p);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`bookmarks-${name}-failed`, p);
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}

// The overview open: no bookmarks over it, nor the room they take on a page
async function noneFar(p, name) {
  await p.locator('#book .bk-column').waitFor({ timeout: LOADED_MS });
  await press(p, "The overview: the notebook's pages, and the Shelf");
  await p.waitForFunction(() => document.querySelector('#book')?.dataset.far, null, { timeout: LOADED_MS });
  await p.waitForTimeout(600);
  assert.equal(await p.locator('#book .bk-marks').isVisible(), false, `${name}: no bookmarks on the overview`);
}
// HQ with the book open (tapped open from its tab where it starts folded: a phone's) and its bookmarks drawn
async function opened(p, c) {
  await p.goto(`${c.base}/?intro=0`);
  await p.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  await p.waitForFunction(
    () => document.documentElement.dataset.book && !document.querySelector('#book.bk-swinging'),
    null,
    { timeout: LOADED_MS },
  );
  if ((await p.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await p.locator('#book .bk-lip').click({ timeout: LOADED_MS });
    await p.waitForFunction(() => !['folded', 'shut'].includes(document.documentElement.dataset.book), null, {
      timeout: LOADED_MS,
    });
  }
  await until(async () => (await tabs(p)).length === 3, 'three bookmarks');
}
const tabs = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-marks button')].map(b => {
      const r = b.getBoundingClientRect();
      return {
        chapter: b.dataset.chapter,
        count: b.querySelector('.bk-mk-count')?.textContent ?? null,
        box: { x: r.left, y: r.top, right: r.right, bottom: r.bottom },
      };
    }),
  );
// The page shown: its title at its head, where it is on the rail, the lit tab and its stamp's words
const shown = p =>
  p.evaluate(() => {
    const name = document.querySelector('#book .bk-where');
    const stamp = document.querySelector('#book .bk-page:not([hidden]) [data-slot=stamp].bk-stamped svg');
    return {
      title: document.querySelector('#book .bk-page:not([hidden]) .bk-page-title')?.textContent ?? '',
      where: name?.querySelector('small')?.textContent || null,
      lit: document.querySelector('#book .bk-marks [aria-current=page]')?.dataset.chapter ?? null,
      stamp: stamp?.getAttribute('aria-label') ?? null,
    };
  });
// Upright: along the top over the paper's head, clear of the dog-ear. Sideways: in the page stack left of the paper.
// Never over each other, all on screen.
async function placed(p, name) {
  const t = await tabs(p),
    { height } = p.viewportSize(),
    { paper, ear, upright } = await p.evaluate(() => {
      const box = el => {
        const r = el?.getBoundingClientRect();
        return r && { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
      };
      return {
        paper: box(document.querySelector('#book .bk-paper')),
        ear: box(document.querySelector('#book .bk-dogear')),
        upright: matchMedia('(orientation: portrait)').matches,
      };
    });
  for (const [i, a] of t.entries()) {
    assert.ok(a.box.x >= 0 && a.box.bottom <= height, `${name}: ${a.chapter} on screen`);
    if (upright) {
      assert.ok(a.box.bottom <= paper.y + 1, `${name}: ${a.chapter} above the paper (${a.box.bottom} > ${paper.y})`);
      if (ear) assert.ok(a.box.right <= ear.x, `${name}: ${a.chapter} clear of the dog-ear`);
    } else
      assert.ok(a.box.right <= paper.x + 1, `${name}: ${a.chapter} left of the paper (${a.box.right} > ${paper.x})`);
    const b = t[i + 1];
    if (b)
      assert.ok(
        upright ? a.box.right <= b.box.x : a.box.bottom <= b.box.y,
        `${name}: ${a.chapter} and ${b.chapter} apart`,
      );
  }
}
