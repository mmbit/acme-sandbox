// book-check.mjs's stories of a book's bookmarks (shell/ink/bookmarks.js), real bookmarks on the cover's edge. On My
// journal seeded with two sketch pages, its Asks page with 128 asks open and two calls' notes pages, one stamped Sent
// by its follow-up and one still with it, at a phone, an iPad mini upright (its page the whole screen, and beside HQ's
// page with the book at its least) and sideways, a phone sideways and a wide desktop: the page's own alone marked as
// the page's own, Asks' count in its label ("Asks · 128"), all below the status bar's blur, apart and clear of the
// book's pull tab, and lying as they will once the book lands all through its swing open. Beside HQ's page they stick
// out of the page block to the left, never over the paper nor HQ's own keys, their words whole in them; on a page that
// is the whole screen they lie folded at its left edge, their icons showing, a tap or a pull right brings them out over
// the margin, a tap on one then opens its chapter and folds them, and a press elsewhere folds them. Each opens its
// chapter's first page, the bar counting within it, the first call's page stamped Sent; on the overview too, where one
// picked scrolls it to its chapter. Recorded with --shots. (A chapter with no pages and a round's guests:
// bookmarkchapters.mjs.) (the long count, the pull tab, the fold, the blur and the chapter's pick)
import assert from 'node:assert/strict';
import { LOADED_MS, OVERVIEW, atEverySize, pressAlong, toChapter, until, whole } from './kit.mjs';
import { blurred } from './islands.mjs';
import { typedBoxes } from '../shell/ink/notebookparts.js';
import { bookWide, watchedPage } from './start.mjs';
import { BOOK } from '../shell/ink/booklayout.js';

const T0 = '2026-10-29T15:00:00.000Z',
  ENDED = Date.parse('2026-10-29T16:21:00.000Z');
// a home-screen app's blurred strip at the top (style.css's standalone --sat), on the screens the page fills
const SAT_PX = 48;
const touch = { hasTouch: true, isMobile: true },
  mouse = { hasTouch: false, isMobile: false };
export const SIZES = {
  phone: { width: 390, height: 844, sat: SAT_PX, ...touch },
  'ipad-mini-upright': { width: 744, height: 1133, sat: SAT_PX, ...touch },
  // (beside HQ's page, as the board leaves it with its cover's edge at its least)
  'ipad-mini-upright-least': { width: 744, height: 1133, sat: SAT_PX, book: BOOK.min, ...touch },
  'ipad-mini-sideways': { width: 1133, height: 744, ...touch },
  'phone-sideways': { width: 844, height: 390, ...touch },
  'desktop-wide': { width: 1920, height: 1080, book: 1100, ...mouse },
};
export const page = (id, pos, label, more = {}) => ({
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
export const journal = (more = {}) => ({
  id: 1,
  kind: 'mine',
  name: 'My journal',
  archived: false,
  created: T0,
  updated: T0,
  // (a count long enough to lengthen the Asks tab beside HQ's page towards the book's pull tab)
  asks: { open: 128, all: 140 },
  ...more,
});
export const SEED = {
  notebooks: [journal()],
  pages: [
    page(1, 0, 'Ideas'),
    page(2, 1, 'Call with Lyra: cover edge', { kind: 'call', send_at: ENDED - 3_600_000, followed: ENDED }),
    page(3, 2, 'Shop page'),
    page(4, 3, 'Asks', { kind: 'asks' }),
    page(5, 4, 'Call with Moss', { kind: 'call', send_at: ENDED }),
  ],
  groups: [
    note(1, 2, 'Cover on top, bottom, outer edge; never on the spine.'),
    note(2, 2, 'Cover edge, once it is sent.'),
    note(3, 5, 'Tabs a little bigger.'),
  ],
  slips: [],
  asks: [],
  names: { lyra: 'Lyra', moss: 'Moss' },
};
// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function bookmarksStories(c) {
  return {
    "the book's bookmarks: Sketch, Asks and Calls, the page's own marked, out of the page block beside HQ's page or folded at the edge of a page that is the whole screen, clear of the pull tab, and a call's page under Calls stamped by its follow-up":
      atEverySize(SIZES, (browser, name, size) =>
        onBook(browser, c, name, size, SEED, (p, press) => bookmarks(p, c, name, press)),
      ),
  };
}

// HQ in a fresh context at a size, its Notebook seeded, the book open and its bookmarks drawn, then walk(p, press)
// (press: a tap where the screen has touch, else a click); no page errors. A failure is shot as `bookmarks-${name}-failed`.
export async function onBook(browser, c, name, size, seed, walk) {
  const { book, sat, ...viewport } = size,
    { hasTouch, isMobile } = viewport,
    context = await c.hqIn(browser, viewport, { notebooks: structuredClone(seed), hasTouch, isMobile });
  await bookWide(context, viewport, book);
  if (sat) await blurred(context, { sat });
  const { page: p, errors } = await watchedPage(context);
  try {
    await opened(p, c, hasTouch);
    await walk(p, loc => (hasTouch ? loc.tap({ timeout: LOADED_MS }) : loc.click({ timeout: LOADED_MS })));
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`bookmarks-${name}-failed`, p);
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}

// My journal's bookmarks: placed and marked; each chapter picked, and the page after it
async function bookmarks(p, c, name, press) {
  await p.waitForTimeout(500);
  // (folded in once the book has landed: WebKit's fold can stall a moment under load.)
  await until(
    () => p.evaluate(() => !document.querySelector('#book .bk-marks').getAnimations({ subtree: true }).length),
    `${name}: the bookmarks at rest`,
    LOADED_MS,
  );
  await placed(p, name);
  const asks = (await tabs(p)).find(t => t.chapter === 'asks');
  assert.deepEqual(
    [asks.words, asks.count, asks.label],
    ['Asks · 128', ' · 128', 'Asks, 128 open'],
    `${name}: Asks' open count in its label`,
  );
  await reopened(p, name, press);
  if (await whole(p)) await pulledOut(p, c, name, press);
  for (const [chapter, first, where] of [
    ['sketch', 'Ideas', '1 / 2'],
    ['asks', 'Asks', '1 / 1'],
    ['calls', 'Call with Lyra: cover edge', '1 / 2'],
  ]) {
    await toChapter(p, chapter, press);
    await landedOn(p, first, `${name}: ${chapter} opens ${first}`);
    const s = await shown(p);
    assert.deepEqual(
      (await tabs(p)).filter(a => a.here).map(a => a.chapter),
      [chapter],
      `${name}: the ${chapter} tab alone the page's own`,
    );
    assert.equal(s.where, where, `${name}: the bar counts within ${chapter}`);
    if (chapter === 'calls') assert.match(s.stamp ?? '', /^Sent\b.*\d\d:\d\d$/, `${name}: the call's page stamped`);
    await c.shot(`bookmarks-${name}-${chapter}`, p);
  }
  // (the call still with its follow-up: the next page under Calls, shut and unstamped)
  await press(p.locator('#book .bk-bar').getByRole('button', { name: 'The page after', exact: true }));
  await landedOn(p, 'Call with Moss', `${name}: the next call`);
  const moss = await shown(p);
  assert.deepEqual([moss.where, moss.stamp], ['2 / 2', null], `${name}: with its follow-up, unstamped`);
  await marksOnOverview(p, name, press);
  await c.shot(`bookmarks-${name}-overview`, p);
}

// The book shut and opened again from its pull tab: from the swing's start the tabs lie as they will once it lands
// (book.js's data-whole, where it's going), never as they did shut
async function reopened(p, name, press) {
  const open = await whole(p),
    lip = p.locator('#book .bk-lip'),
    rest = mode =>
      p.waitForFunction(
        mode =>
          (document.documentElement.dataset.book === 'folded') === mode && !document.querySelector('#book.bk-swinging'),
        mode,
        { timeout: LOADED_MS },
      );
  await press(lip);
  await rest(true);
  await press(lip);
  await p.waitForFunction(() => document.querySelector('#book.bk-swinging'), null, { timeout: LOADED_MS });
  assert.equal(await whole(p), open, `${name}: the tabs lie as they will once open, mid-swing`);
  await rest(false);
  assert.equal(await whole(p), open, `${name}: the tabs lie as before, open again`);
}

// Folded at the screen's left edge: a tap on them brings them out, their words on the screen, and a press elsewhere
// (the page count on the bar) folds them; a pull right brings them out too
async function pulledOut(p, c, name, press) {
  const out = p.locator('#book .bk-marks[data-out]'),
    where = p.locator('#book .bk-where'),
    { title } = await shown(p);
  await press(p.locator('#book .bk-marks [data-chapter=asks] .bk-mk-icon'));
  await out.waitFor({ timeout: LOADED_MS });
  await p.waitForTimeout(400);
  for (const t of await tabs(p)) {
    assert.ok(t.box.x >= -1, `${name}: ${t.chapter} out, wholly on the screen (${t.box.x})`);
    assert.ok(t.wordsBox.x >= 0 && t.wordsBox.width > 20, `${name}: ${t.chapter}'s words read once out`);
  }
  assert.equal((await shown(p)).title, title, `${name}: bringing them out turns no page`);
  await c.shot(`bookmarks-${name}-out`, p);
  await press(where);
  await out.waitFor({ state: 'detached', timeout: LOADED_MS });
  await p.locator('#book .bk-pages-menu').waitFor({ timeout: LOADED_MS });
  await press(where);
  await p.locator('#book .bk-pages-menu').waitFor({ state: 'detached', timeout: LOADED_MS });
  // (a finger's pull, from the sliver to the right)
  const sliver = (await tabs(p)).find(t => t.chapter === 'sketch').box,
    y = sliver.y + sliver.height / 2;
  await pressAlong(
    p,
    [
      [sliver.right - 6, y],
      [sliver.right + 20, y],
      [sliver.right + 60, y],
    ],
    { type: 'touch' },
  );
  await out.waitFor({ timeout: LOADED_MS });
  assert.equal((await shown(p)).title, title, `${name}: a pull turns no page`);
}

// The overview open: its bookmarks as on every page, and Calls' picked scrolls the overview to Calls' head, the
// overview still open
async function marksOnOverview(p, name, press) {
  await p.locator(`#book .bk-bar .bk-btn[aria-label="${OVERVIEW}"]`).dispatchEvent('click');
  await p.waitForFunction(() => document.querySelector('#book')?.dataset.far, null, { timeout: LOADED_MS });
  await p.waitForTimeout(600);
  assert.ok(await p.locator('#book .bk-marks').isVisible(), `${name}: the bookmarks on the overview`);
  await toChapter(p, 'calls', press);
  await until(() => p.evaluate(headInView, 'calls'), `${name}: Calls' bookmark scrolling the overview to Calls`);
  assert.ok(await p.evaluate(() => document.querySelector('#book').dataset.far), `${name}: still the overview`);
}
// (in the page) Whether a chapter's head in the overview is in view at the top of what scrolls it, or as near as its
// scroll goes
function headInView(chapter) {
  const head = document.querySelector(`#book .bk-pages > .bk-far .bk-far-chapter[data-chapter=${chapter}] h3`);
  let scroller = head.parentElement;
  while (
    scroller &&
    !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))
  )
    scroller = scroller.parentElement;
  const h = head.getBoundingClientRect(),
    view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight, height: innerHeight },
    shown = h.top >= view.top - 1 && h.bottom <= view.bottom + 1;
  const atEnd = !scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
  return shown && (h.top <= view.top + view.height / 3 || atEnd);
}
// HQ with the book open (tapped open from its lip where it starts folded: a phone's) and its bookmarks drawn
async function opened(p, c, hasTouch) {
  await p.goto(`${c.base}/?intro=0`);
  await p.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  await p.waitForFunction(
    () => document.documentElement.dataset.book && !document.querySelector('#book.bk-swinging'),
    null,
    { timeout: LOADED_MS },
  );
  if ((await p.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    const lip = p.locator('#book .bk-lip');
    await (hasTouch ? lip.tap({ timeout: LOADED_MS }) : lip.click({ timeout: LOADED_MS }));
    await p.waitForFunction(() => !['folded', 'shut'].includes(document.documentElement.dataset.book), null, {
      timeout: LOADED_MS,
    });
  }
  await until(async () => (await tabs(p)).length === 3, 'three bookmarks');
  await p.waitForFunction(() => !document.querySelector('#book.bk-swinging'), null, { timeout: LOADED_MS });
}
export const tabs = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-marks button')].map(b => {
      const box = el => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        chapter: b.dataset.chapter,
        words: b.querySelector('span').textContent,
        count: b.querySelector('.bk-mk-count')?.textContent ?? null,
        label: b.getAttribute('aria-label'),
        here: b.getAttribute('aria-current') === 'page',
        box: box(b),
        icon: box(b.querySelector('svg.bk-mk-icon')),
        wordsBox: box(b.querySelector('span')),
      };
    }),
  );
// The page titled title shown, the leaf turned to it landed (while it turns, it carries a copy of the page it left,
// stamp and all) and its stamp drawn
async function landedOn(p, title, what) {
  await until(async () => (await shown(p)).title === title, what, LOADED_MS);
  await until(
    async () => (await p.locator('#book .bk-turn-leaf').count()) === 0,
    `${what}: the leaf landed`,
    LOADED_MS,
  );
  await p.waitForTimeout(700);
}
// The page shown: its title at its head, the bar's count, the page's own tab and its stamp's words
export const shown = p =>
  p.evaluate(() => {
    const stamp = document.querySelector('#book .bk-page:not([hidden]) [data-slot=stamp].bk-stamped svg');
    return {
      title: document.querySelector('#book .bk-page:not([hidden]) .bk-page-title')?.textContent ?? '',
      where: document.querySelector('#book .bk-where')?.textContent || null,
      here: document.querySelector('#book .bk-marks [aria-current=page]')?.dataset.chapter ?? null,
      stamp: stamp?.getAttribute('aria-label') ?? null,
    };
  });

// Where the tabs lie: all below the blur, apart, and clear of the book's pull tab. On a page that is the whole screen,
// folded at the screen's left edge, most of each past it and its icon showing. Beside HQ's page: beside().
async function placed(p, name) {
  const t = await tabs(p),
    isWhole = await whole(p),
    { height } = p.viewportSize(),
    { paper, edge, sat, lip, keys } = await p.evaluate(() => {
      const box = el => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
      };
      return {
        paper: box(document.querySelector('#book .bk-paper')),
        edge: box(document.querySelector('#book .bk-edge')),
        sat: parseFloat(getComputedStyle(document.querySelector('#book')).getPropertyValue('--sat')) || 0,
        lip: box(document.querySelector('#book .bk-lip')),
        // (HQ's own keys beside the book)
        keys: [...document.querySelectorAll('body button, body a[href]')]
          .filter(b => !b.closest('#book') && b.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
          .map(b => ({ label: b.getAttribute('aria-label') || b.textContent.trim(), ...box(b) })),
      };
    });
  for (const [i, a] of t.entries()) {
    assert.ok(a.box.y >= sat && a.box.bottom <= height, `${name}: ${a.chapter} below the blur (${a.box.y} by ${sat})`);
    if (isWhole) {
      assert.ok(
        a.box.right < a.box.width / 2,
        `${name}: ${a.chapter} folded at the screen's left edge, most of it past it (${a.box.right} px show)`,
      );
      assert.ok(
        a.icon.x + a.icon.width / 2 >= 0 && a.icon.right <= a.box.right,
        `${name}: ${a.chapter}'s icon showing (${a.icon.x}–${a.icon.right})`,
      );
    } else beside(name, a, { edge, paper, keys, height });
    const b = t[i + 1];
    if (b) assert.ok(a.box.bottom <= b.box.y, `${name}: ${a.chapter} and ${b.chapter} apart`);
    const underLip = lip.y < a.box.bottom && a.box.y < lip.bottom && lip.x < a.box.right && a.box.x < lip.right;
    assert.ok(!underLip, `${name}: ${a.chapter} clear of the book's pull tab (${JSON.stringify([a.box, lip])})`);
  }
}
// A tab beside HQ's page: on the screen, out of the page block, never over the paper nor HQ's own keys, and its words
// whole in it where the screen is tall enough to show them (a phone on its side shows icons only)
function beside(name, a, { edge, paper, keys, height }) {
  assert.ok(a.box.x >= 0, `${name}: ${a.chapter} on the screen`);
  assert.ok(a.box.x < edge.x, `${name}: ${a.chapter} out of the page block (${a.box.x} by ${edge.x})`);
  assert.ok(a.box.right <= paper.x + 1, `${name}: ${a.chapter} never over the paper (${a.box.right} > ${paper.x})`);
  const w = a.wordsBox,
    whole = w.x >= a.box.x && w.right <= a.box.right && w.y >= a.box.y && w.bottom <= a.box.bottom;
  if (height > 520) assert.ok(whole, `${name}: ${a.chapter}'s words whole in it (${JSON.stringify([w, a.box])})`);
  const covered = keys.filter(k => k.x < a.box.right && a.box.x < k.right && k.y < a.box.bottom && a.box.y < k.bottom);
  assert.deepEqual(covered, [], `${name}: ${a.chapter} clear of HQ's own keys (${JSON.stringify(a.box)})`);
}
