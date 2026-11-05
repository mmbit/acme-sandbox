// book-check.mjs's story of the notebook on the board's iPad, held and used by hand: HQ as a home-screen app with iOS's
// blurred band at the top (style.css's --sat), sideways (1133 × 744) and upright (744 × 1133), with the Pencil and
// fingers in either engine (hands.mjs). Upright, a finger's tap on the pull tab opens the book. Each way up, the paper
// runs from the screen's top, under the band, to its foot, the page on it from the band's foot, its head never below
// HQ's buttons. The scraps at their own size at the page's left, as many columns as its width holds. The bookmarks
// under the band: sideways out of the page block to the book's left, upright folded at the screen's left edge (a
// finger's tap brings them out); a finger's tap turns to a chapter and back. A call's page has one title, the Pencil
// near it changing nothing there. The two islands of use under the band (islands.mjs); the Pencil's tap and a finger's
// each pick a tool. (the islands' checks, the blur and the chapter's pick) The Pencil's tap opens a scrap and its line
// there is saved as that scrap's ink. The Pencil's arrow begun by the page's left edge leaves the book open; a
// finger's taps, each where the page arrows were at the start, turn to a read-only call's page and back, the arrows
// never moving; and a finger's swipe from that edge still closes the book (only a deliberate pull moves it). Two
// fingers move the page down and draw nothing. Recorded with --shots.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, closeScrap, middleOf, openScrap, toChapter, until } from './kit.mjs';
import { hands } from './hands.mjs';
import { SEED } from './unitspage.mjs';
import { OWN_W, anotherColumn, units } from './unitsread.mjs';
import { UNIT_W } from '../shell/ink/scrapunit.js';
import { picksByHand } from './fillislands.mjs';
import { blurred, islandsSeen, islandsUsable } from './islands.mjs';
import { tabs } from './bookmarks.mjs';
import { noMicrophone, watchedPage } from './start.mjs';

// an iPad's home-screen app: its status bar and iOS's blurred band under it (style.css)
const BAND = 24 + 48;
// the agent's scraps three times over, so the page is longer than the screen either way up, on a call's notes page titled
// as the store titles one: the call's date and time, then its topic (callnotes.ts). After it, a later call's page,
// read-only till its follow-up goes (as a page sent: the tools give way to a lock), with the agent's scraps twice over.
const T1 = '2026-10-30T11:00:00.000Z';
const LONG = {
  ...SEED,
  pages: [
    ...SEED.pages.map((p, i) => (i ? p : { ...p, kind: 'call', label: '29 Oct, 15:00, Ink walk-through' })),
    { ...SEED.pages[0], id: 2, pos: 1, kind: 'call', label: '30 Oct, 11:00, Rail check', send_at: Date.parse(T1) },
  ],
  groups: [
    ...[0, 100, 200].flatMap(n => SEED.groups.map(g => ({ ...g, id: g.id + n, pos: g.pos + n }))),
    // (fewer on the read-only page: the scraps' count tells the two pages apart.)
    ...[1000, 1100].flatMap(n => SEED.groups.map(g => ({ ...g, id: g.id + n, pos: g.pos + n - 1000, page: 2 }))),
  ],
};
const FIRST = LONG.groups.filter(g => g.page === 1).length;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function fillStories(c) {
  return {
    "the board's iPad by hand, both ways up: the notebook fills the height under iOS's blur and the page's width, the Pencil writes and two fingers scroll":
      async browser => {
        // (both ways up shot and checked, the failures told together)
        const failed = [];
        for (const [name, viewport, columns] of [
          ['sideways', MINI, 0],
          ['upright', UPRIGHT, 2],
        ])
          await byHand(browser, c, name, viewport, columns).catch(e => failed.push(`${name}: ${e.message}`));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

async function byHand(browser, c, name, viewport, columns) {
  const context = await c.hqIn(browser, viewport, {
    notebooks: structuredClone(LONG),
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  await blurred(context, { sat: BAND });
  await noMicrophone(context);
  const { page, errors } = await watchedPage(context);
  try {
    const hand = await hands(page);
    await opened(page, c, hand, viewport);
    await c.shot(`fill-${name}-1-open`, page);
    await fillsHeight(page);
    await fillsWidth(page);
    if (columns) await scrapColumns(page, columns);
    await tabsBeside(page, hand, viewport);
    islandsUsable(await islandsSeen(page), 'by hand');
    await picksByHand(page, hand);
    await oneTitle(page, hand);
    await writes(page, context, hand);
    await edgeDraws(page, context, hand);
    await arrowsStay(page, c, name, hand);
    await scrolls(page, hand);
    await c.shot(`fill-${name}-2-scrolled`, page);
    await fingerCloses(page, c, hand);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`fill-${name}-failed`, page);
    throw e;
  } finally {
    await context.close();
  }
}

// The book open with its scraps drawn: sideways it starts open, upright a finger's tap on its pull tab opens it
async function opened(page, c, { touch }, viewport) {
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  if (viewport.height > viewport.width) {
    await c.settled(page, 'folded');
    await touch.down([middleOf(await page.locator('#book .bk-lip').boundingBox())]);
    await touch.up();
    await c.settled(page, 'spread');
  } else await c.settled(page, 'open');
  await until(async () => (await units(page)).length === FIRST, 'the scraps drawn');
}

// The book's paper from the screen's top, under the blurred band, to its foot; the page on it up under the band too, its
// content from the band's foot (README, The book's frame), its head no lower than HQ's buttons
async function fillsHeight(page) {
  const seen = await page.evaluate(() => {
      const paper = document.querySelector('#book .bk-paper').getBoundingClientRect(),
        desk = document.querySelector('#book .bk-pages .bk-desk'),
        buttons = [...document.querySelectorAll('#hud button')]
          .map(b => b.getBoundingClientRect())
          .filter(r => r.width);
      return {
        paper: [paper.top, paper.bottom],
        page: document.querySelector('#book .bk-pages').getBoundingClientRect().top,
        head: desk.getBoundingClientRect().top + parseFloat(getComputedStyle(desk).paddingTop),
        buttons: Math.min(...buttons.map(r => r.top)),
        screen: innerHeight,
      };
    }),
    said = JSON.stringify(seen);
  assert.ok(seen.paper[0] <= 1 && seen.paper[1] >= seen.screen - 1, `the paper the screen's height (${said})`);
  assert.ok(seen.page <= 1, `the page up under the blur (${said})`);
  assert.ok(Math.abs(seen.head - BAND) <= 1, `the page's content from the blur's foot (${said})`);
  assert.ok(seen.head <= seen.buttons + 1, `the page's head no lower than HQ's buttons (${said})`);
}

// The scraps' columns at the page's left, left of the tools: a margin left of them, never room for a fifth of a scrap,
// and right of them no room for another column at LEAST of its size (masonry.js: never drawn past their own size, the
// width left over paper.)
async function fillsWidth(page) {
  const desk = await page.locator('#book .bk-desk:not(.bk-turn-picture *)').boundingBox(),
    all = await units(page),
    left = Math.min(...all.map(u => u.x)) - desk.x,
    right = desk.x + desk.width - Math.max(...all.map(u => u.x + u.w)),
    fifth = all[0].w / 5,
    another = anotherColumn(left);
  assert.ok(
    left >= 0 && left < fifth && right >= 0 && right < another,
    `the scraps at the page's left: ${Math.round(left)} px beside them on the left (between 0 and ${Math.round(fifth)} wanted), ${Math.round(right)} on the right (under ${Math.round(another)} wanted)`,
  );
  assert.ok(all[0].w <= OWN_W, `a scrap ${Math.round(all[0].w)} px wide, past its own ${UNIT_W}`);
}

// The scraps in this many columns, two on an iPad mini upright (board, the Ink 1.1 deck: "Columns that fit the width".
async function scrapColumns(page, columns) {
  const found = new Set((await units(page)).map(u => Math.round(u.x))).size;
  assert.equal(found, columns, `${columns} columns of scraps`);
}

// The Pencil's tap on the first scrap opens it, and its line there is saved as that scrap's ink; Klaar puts it back.
async function writes(page, context, { pen }) {
  const [first] = await units(page),
    inked = () =>
      context.notebook.route('/api/notebooks/pages/groups', { page: 1 }).groups.find(g => g.id === first.id).ink.length,
    was = inked(),
    { gid, sheet } = await openScrap(page, pen, first.id),
    y = sheet.y + sheet.height * 0.6;
  assert.equal(gid, first.id, 'the scrap tapped opened');
  await pen.stroke(Array.from({ length: 14 }, (_, k) => [sheet.x + 40 + k * 12, y + Math.sin(k / 2) * 6]));
  await until(() => inked() > was, "the Pencil's line saved in the scrap", 8000);
  await closeScrap(page, pen);
}

// The Pencil's arrow begun by the page's left edge, moving right (away from the edge) first: the book stays open (only
// a deliberate pull on the edge moves the book), and the grid takes no ink from it (README, A page of scraps).
async function edgeDraws(page, context, { pen }) {
  const mode = () => page.evaluate(() => document.documentElement.dataset.book),
    strokes = () =>
      context.notebook.route('/api/notebooks/pages/groups', { page: 1 }).groups.reduce((n, g) => n + g.ink.length, 0),
    was = { mode: await mode(), strokes: strokes() },
    paper = await page.locator('#book .bk-paper').boundingBox(),
    x = paper.x + 14,
    y = await byTheEdge(page, paper),
    shaft = Array.from({ length: 12 }, (_, k) => [x + k * 8, y]);
  await pen.stroke([...shaft, [x + 70, y - 14], [x + 60, y - 22]]);
  await page.waitForTimeout(800);
  assert.equal(await mode(), was.mode, "the book left as it was by the Pencil's arrow by its edge");
  assert.equal(strokes(), was.strokes, "the Pencil's arrow by the edge no ink on the grid");
}

// A height by the page's left edge, a little over halfway down, below the pull tab where it lies over that edge
async function byTheEdge(page, paper) {
  const lip = await page.locator('#book .bk-lip').boundingBox();
  return Math.max(paper.y + paper.height * 0.55, lip.y + lip.height + 30);
}

// The page arrows where they were whatever page they turn to: a finger's taps, each where the arrow was at the start,
// turn to the call's page after (read-only, the tools giving way to a lock) and back (the page arrows stay put). On the
// read-only page the lock and "Locked" show under the view's title, and stay there as two fingers move the page.
async function arrowsStay(page, c, name, { touch }) {
  const arrows = () =>
      page.evaluate(() =>
        ['The page before', 'The page after'].map(label => {
          const r = document.querySelector(`#book .bk-bar [aria-label="${label}"]`).getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        }),
      ),
    where = () => page.locator('#book .bk-bar .bk-where').textContent(),
    was = await arrows(),
    drawn = (await units(page)).length,
    at = ([x, y, w, h]) => [x + w / 2, y + h / 2],
    tap = async (spot, to) => {
      await touch.down([spot]);
      await touch.up();
      await until(
        async () => (await where()) === to,
        () => `a finger's tap where the arrow was turning to ${to}`,
        8000,
      );
    };
  assert.equal(await where(), '1 / 2', "the call's page first");
  await tap(at(was[1]), '2 / 2');
  await c.shot(`fill-${name}-3-read-only`, page);
  assert.deepEqual(await arrows(), was, 'the page arrows where they were on the read-only page');
  await lockedUnderTitle(page, 'on the read-only page');
  await twoFingers(page, touch);
  await lockedUnderTitle(page, 'as two fingers move the read-only page');
  await tap(at(was[0]), '1 / 2');
  assert.deepEqual(await arrows(), was, 'the page arrows where they were back on the call page');
  await until(async () => (await units(page)).length === drawn, "the call's page back");
}

// A finger's swipe right from the page's left edge still closes the book: the board following it, folded once let go
async function fingerCloses(page, c, { touch }) {
  const paper = await page.locator('#book .bk-paper').boundingBox(),
    y = await byTheEdge(page, paper);
  await touch.down([[paper.x + 14, y]]);
  await touch.move([[paper.x + 14 + paper.width * 0.8, y]], 20);
  await touch.up();
  await c.settled(page, 'folded');
}

// The bookmarks under the blur, Sketch, Asks and Calls: sideways out of the page block to the book's left, over HQ's
// side; upright folded against the screen's left edge, slivers. The call's page under Calls; a finger's tap on Sketch
// (upright, its first tap bringing them out) turns there, one on Calls brings the call's page back.
async function tabsBeside(page, { touch }, viewport) {
  const seen = await tabs(page),
    said = JSON.stringify(seen.map(t => ({ chapter: t.chapter, ...t.box }))),
    paper = await page.locator('#book .bk-paper').boundingBox(),
    upright = viewport.height > viewport.width;
  assert.deepEqual(
    seen.map(t => t.chapter),
    ['sketch', 'asks', 'calls'],
    said,
  );
  assert.ok(
    seen.every(t => t.box.y >= BAND - 1),
    `the tabs under the blur: ${said}`,
  );
  // (folded: most of each past the screen's left edge, as bookmarks.mjs judges it)
  const placed = upright
    ? seen.every(t => t.box.right < t.box.width / 2)
    : seen.every(t => t.box.x < paper.x && t.box.right <= paper.x + 1);
  assert.ok(placed, `the tabs ${upright ? "folded at the screen's left edge" : "out of the book's left"}: ${said}`);
  assert.equal(seen.find(t => t.here)?.chapter, 'calls', "the call's page under Calls");
  const tap = async chapter => {
    // (a trial click first: Playwright's wait for the tab to show, still and on top, before the finger's tap)
    await toChapter(page, chapter, async tab => {
      await tab.click({ trial: true });
      await touch.down([middleOf(await tab.boundingBox())]);
      await touch.up();
    });
    await until(
      async () => (await tabs(page)).find(t => t.here)?.chapter === chapter,
      `a finger's tap turning to ${chapter}`,
      8000,
    );
  };
  await tap('sketch');
  await tap('calls');
  await until(async () => (await units(page)).length === FIRST, "the call's page back");
}

// The call's page: one title, the call's date and time leading it, no date of its own under it; a Pencil line beside
// the title leaves it as it was, nothing in the page's head coming or going
async function oneTitle(page, { pen }) {
  const head = () =>
      page.evaluate(() => {
        // (the title and day on the view, the dates on the page above its first scrap.)
        const shown = document.querySelector('#book .bk-page:not([hidden])'),
          first = Math.min(...[...shown.querySelectorAll('.bk-unit')].map(u => u.getBoundingClientRect().top));
        return [
          ...document.querySelectorAll('#book .bk-view-head :is(.bk-page-title, .bk-view-day)'),
          ...shown.querySelectorAll('.bk-day'),
        ]
          .filter(el => el.checkVisibility())
          .map(el => ({ words: el.textContent, top: Math.round(el.getBoundingClientRect().top) }))
          .filter(el => el.top < first);
      }),
    was = await head();
  assert.deepEqual(
    was.map(el => el.words),
    ['29 Oct, 15:00, Ink walk-through'],
    `one title in the page's head: ${JSON.stringify(was)}`,
  );
  const title = await page.locator('#book .bk-view-head .bk-page-title span').boundingBox(),
    y = title.y + title.height + 10;
  await pen.stroke(Array.from({ length: 10 }, (_, k) => [title.x + title.width + 16 + k * 8, y + Math.sin(k) * 4]));
  await page.waitForTimeout(800);
  assert.deepEqual(await head(), was, "the page's head as it was after the Pencil came near the title");
}

// Two fingers a hand's width apart drawn up the page across its middle: it moves down, and nothing new is drawn.
// (No room handles to keep clear of on a page of scraps)
async function scrolls(page, { touch }) {
  const count = async () => (await units(page)).length,
    was = await count();
  await twoFingers(page, touch);
  await page.waitForTimeout(600);
  assert.equal(await count(), was, 'two fingers drew nothing');
}

// Two fingers moving the page down, once the last page turn has landed
async function twoFingers(page, touch) {
  // (the last page turn landed first: its pictures hold copies of the page's scraps, and headless WebKit's slow frames
  // keep one turning past the steps before.)
  await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture'), null, { timeout: 30_000 });
  const desk = await page.locator('#book .bk-desk:not(.bk-turn-picture *)').boundingBox(),
    [left, right] = [0.3, 0.7].map(f => desk.x + desk.width * f),
    y = desk.y + desk.height / 2,
    was = await panned(page);
  await touch.down([
    [left, y + 150],
    [right, y + 150],
  ]);
  await touch.move([
    [left, y - 150],
    [right, y - 150],
  ]);
  await touch.up();
  await until(async () => (await panned(page)) > was + 100, 'the page moved down by two fingers', 4000);
}

// The lock and "Locked" in sight under the view's title (bookviewhead.js, shown by bookcontrols.js lockLine)
async function lockedUnderTitle(page, at) {
  const seen = await page.evaluate(() => {
      const lock = document.querySelector('#book .bk-view-locked'),
        title = document.querySelector('#book .bk-view-head .bk-page-title');
      return {
        shown: !!lock?.checkVisibility(),
        words: lock?.textContent.trim(),
        lock: lock?.getBoundingClientRect().toJSON(),
        title: title.getBoundingClientRect().toJSON(),
        screen: innerHeight,
      };
    }),
    said = JSON.stringify(seen);
  assert.ok(seen.shown && seen.words === 'Locked', `"Locked" shown ${at} (${said})`);
  assert.ok(
    seen.lock.top >= seen.title.bottom - 1 && seen.lock.bottom <= seen.screen,
    `under the title ${at} (${said})`,
  );
}
// How far down the page is moved, in screen px
const panned = page =>
  page.evaluate(() => {
    const moved = /translate3d\(-?[\d.]+px, (-?[\d.]+)px/.exec(
      document.querySelector('#book .bk-world').style.transform,
    );
    return -Number(moved[1]);
  });
