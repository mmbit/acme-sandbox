// book-check.mjs's stories of a book's bookmarks (shell/ink/bookmarks.js), real bookmarks on the cover's edge. On My
// journal seeded with two sketch pages, its Asks page with three asks open and two calls' notes pages, one stamped Sent
// by its follow-up and one still with it, at a phone, an iPad mini upright and sideways, a phone sideways and a wide
// desktop: each tab its own card colour for good, never lit, the page's own marked by depth only (aria-current, longer
// and in front), Asks' count in its label ("Asks · 3"), all below the status bar's blur. Beside HQ's page they stick out
// of the page block to the left, never over the paper, their words upright; on a page that is the whole screen they lie
// folded at its left edge as slivers showing their icons, a tap or a pull right brings them out over the margin, a tap
// on one then opens its chapter and folds them, and a press elsewhere folds them. Each opens its chapter's first page,
// the bar counting within it, the first call's page stamped Sent; none on the overview. Recorded with --shots. (A
// chapter with no pages and a round's guests: bookmarkschapters.mjs.)
import assert from 'node:assert/strict';
import { OVERVIEW, pressAlong, until } from './bookkit.mjs';
import { picked } from './bookjournal.mjs';
import { typedBoxes } from './shell/ink/notebookparts.js';

const T0 = '2026-10-29T15:00:00.000Z',
  ENDED = Date.parse('2026-10-29T16:21:00.000Z');
// (a tap or a wait on the shared machine under load: taps time out at 30 s there, on main too)
export const LOADED_MS = 90_000;
// a home-screen app's blurred strip at the top (style.css's standalone --sat), on the screens the page fills
const SAT_PX = 48;
// how much of a folded tab shows at the screen's left edge, px: a sliver, its icon in it (bookmarks.css)
const SLIVER = { least: 12, most: 30 };
const touch = { hasTouch: true, isMobile: true },
  mouse = { hasTouch: false, isMobile: false };
export const SIZES = {
  phone: { width: 390, height: 844, sat: SAT_PX, ...touch },
  'ipad-mini-upright': { width: 744, height: 1133, sat: SAT_PX, ...touch },
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
  asks: { open: 3, all: 4 },
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
    "the book's bookmarks: Sketch, Asks and Calls each in its own colour for good, the page's own by depth, out of the page block or folded at the edge by the screen's orientation, and a call's page under Calls stamped by its follow-up":
      async browser => {
        const failed = [];
        for (const [name, size] of Object.entries(SIZES))
          await onBook(browser, c, name, size, SEED, (p, press) => bookmarks(p, c, name, press)).catch(e =>
            failed.push(e.message),
          );
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

// HQ in a fresh context at a size, its Notebook seeded, the book open and its bookmarks drawn, then walk(p, press)
// (press: a tap where the screen has touch, else a click); no page errors. A failure is shot as `bookmarks-${name}-failed`.
export async function onBook(browser, c, name, size, seed, walk) {
  const { book, sat, ...viewport } = size,
    { hasTouch, isMobile } = viewport,
    context = await c.hqIn(browser, viewport, { notebooks: structuredClone(seed), hasTouch, isMobile });
  if (book)
    await context.addInitScript(
      w => localStorage.setItem('hq.book.wide', JSON.stringify({ mode: 'open', book: w })),
      book,
    );
  if (sat)
    await context.addInitScript(px => {
      const set = () => document.documentElement.style.setProperty('--sat', `${px}px`);
      document.addEventListener('DOMContentLoaded', set);
    }, sat);
  const p = await context.newPage(),
    errors = [];
  p.on('pageerror', e => errors.push(e.message));
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

// My journal's bookmarks: placed, coloured and marked; each chapter picked, and the page after it
async function bookmarks(p, c, name, press) {
  await p.waitForTimeout(500);
  const colours = await placed(p, name),
    folded = await isFolded(p);
  const asks = (await tabs(p)).find(t => t.chapter === 'asks');
  assert.deepEqual(
    [asks.words, asks.count, asks.label],
    ['Asks · 3', ' · 3', 'Asks, 3 open'],
    `${name}: Asks' open count in its label`,
  );
  if (folded) await pulledOut(p, c, name, press);
  for (const [chapter, first, where] of [
    ['sketch', 'Ideas', '1 / 2'],
    ['asks', 'Asks', '1 / 1'],
    ['calls', 'Call with Lyra: cover edge', '1 / 2'],
  ]) {
    await picked(p, press, chapter);
    await landedOn(p, first, `${name}: ${chapter} opens ${first}`);
    const s = await shown(p);
    assert.equal(s.here, chapter, `${name}: the ${chapter} tab the page's own`);
    assert.equal(s.where, where, `${name}: the bar counts within ${chapter}`);
    if (chapter === 'calls') assert.match(s.stamp ?? '', /^Sent\b.*\d\d:\d\d$/, `${name}: the call's page stamped`);
    await byDepth(p, chapter, colours, name);
    await c.shot(`bookmarks-${name}-${chapter}`, p);
  }
  // (the call still with its follow-up: the next page under Calls, shut and unstamped)
  await press(p.locator('#book .bk-bar').getByRole('button', { name: 'The page after', exact: true }));
  await landedOn(p, 'Call with Moss', `${name}: the next call`);
  const moss = await shown(p);
  assert.deepEqual([moss.where, moss.stamp], ['2 / 2', null], `${name}: with its follow-up, unstamped`);
  await noneFar(p, name);
  await c.shot(`bookmarks-${name}-overview`, p);
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

// The overview open: no bookmarks over it
async function noneFar(p, name) {
  await p.locator(`#book .bk-bar .bk-btn[aria-label="${OVERVIEW}"]`).dispatchEvent('click');
  await p.waitForFunction(() => document.querySelector('#book')?.dataset.far, null, { timeout: LOADED_MS });
  await p.waitForTimeout(600);
  assert.equal(await p.locator('#book .bk-marks').isVisible(), false, `${name}: no bookmarks on the overview`);
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
const isFolded = p => p.evaluate(() => matchMedia('(orientation: portrait)').matches);
export const tabs = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-marks button')].map(b => {
      const box = el => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const look = getComputedStyle(b);
      return {
        chapter: b.dataset.chapter,
        words: b.querySelector('span').textContent,
        count: b.querySelector('.bk-mk-count')?.textContent ?? null,
        label: b.getAttribute('aria-label'),
        here: b.getAttribute('aria-current') === 'page',
        colour: [look.backgroundColor, look.color],
        z: Number(look.zIndex) || 0,
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

// Where the tabs lie, by the screen's orientation, each in its own colour, all below the blur and apart. Beside HQ's
// page: out of the page block left of the book, never over the paper nor HQ's own keys, their words upright and whole
// in the tab under its icon (a phone on its side: icons only, the words don't fit between HQ's keys). Never under the
// book's pull tab. Upright: folded at the screen's left edge, a sliver of each with its icon. Returns each tab's
// colours, in order.
async function placed(p, name) {
  const t = await tabs(p),
    folded = await isFolded(p),
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
  const colours = t.map(a => a.colour);
  assert.equal(new Set(colours.map(String)).size, t.length, `${name}: each tab its own colour (${colours})`);
  for (const [i, a] of t.entries()) {
    assert.ok(a.box.y >= sat && a.box.bottom <= height, `${name}: ${a.chapter} below the blur (${a.box.y} by ${sat})`);
    if (folded) {
      assert.ok(
        a.box.right >= SLIVER.least && a.box.right <= SLIVER.most,
        `${name}: ${a.chapter} folded at the screen's left edge, a sliver (${a.box.right} px)`,
      );
      assert.ok(
        a.icon.x + a.icon.width / 2 >= 0 && a.icon.right <= a.box.right,
        `${name}: ${a.chapter}'s icon in its sliver (${a.icon.x}–${a.icon.right})`,
      );
    } else beside(name, a, { edge, paper, keys, height });
    const b = t[i + 1];
    if (b) assert.ok(a.box.bottom <= b.box.y, `${name}: ${a.chapter} and ${b.chapter} apart`);
    const underLip = lip.y < a.box.bottom && a.box.y < lip.bottom && lip.x < a.box.right && a.box.x < lip.right;
    assert.ok(!underLip, `${name}: ${a.chapter} clear of the book's pull tab (${JSON.stringify([a.box, lip])})`);
  }
  return colours;
}
// A tab beside HQ's page: out of the page block, never over the paper nor HQ's own keys, its words upright and whole
// under its icon (but on a phone on its side)
function beside(name, a, { edge, paper, keys, height }) {
  assert.ok(a.box.x >= 0, `${name}: ${a.chapter} on the screen`);
  assert.ok(a.box.x < edge.x, `${name}: ${a.chapter} out of the page block (${a.box.x} by ${edge.x})`);
  assert.ok(a.box.right <= paper.x + 1, `${name}: ${a.chapter} never over the paper (${a.box.right} > ${paper.x})`);
  if (height > 520) {
    assert.ok(a.wordsBox.height > a.wordsBox.width, `${name}: ${a.chapter}'s words upright`);
    assert.ok(
      a.wordsBox.y >= a.icon.bottom && a.wordsBox.bottom <= a.box.bottom,
      `${name}: ${a.chapter}'s words whole in its tab, below its icon (${JSON.stringify([a.wordsBox, a.box])})`,
    );
  }
  const covered = keys.filter(k => k.x < a.box.right && a.box.x < k.right && k.y < a.box.bottom && a.box.y < k.bottom);
  assert.deepEqual(covered, [], `${name}: ${a.chapter} clear of HQ's own keys (${JSON.stringify(a.box)})`);
}
// The page's own tab marked by depth alone: longer than the others and in front, every tab in the colour it
// had at first (never lit)
async function byDepth(p, chapter, colours, name) {
  const t = await tabs(p),
    folded = await isFolded(p),
    own = t.find(a => a.chapter === chapter);
  assert.deepEqual(
    t.map(a => a.colour),
    colours,
    `${name}: every tab in its own colour still, ${chapter} the page's own`,
  );
  assert.deepEqual(
    t.filter(a => a.here).map(a => a.chapter),
    [chapter],
    `${name}: ${chapter} alone the page's own`,
  );
  for (const a of t.filter(a => a !== own)) {
    // (folded, further out from the screen's edge; beside HQ's page, longer and from the top page, nearer the paper)
    const further = folded ? own.box.right > a.box.right : own.box.width > a.box.width && own.box.right > a.box.right;
    assert.ok(further, `${name}: ${chapter} longer than ${a.chapter} (${JSON.stringify([own.box, a.box])})`);
    assert.ok(own.z > a.z, `${name}: ${chapter} in front of ${a.chapter}`);
  }
}
