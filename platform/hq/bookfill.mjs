// book-check.mjs's story of the notebook on the board's iPad, held and used by hand: HQ as a home-screen app with iOS's
// blurred band at the top (style.css's --sat), sideways (1133 × 744) and upright (744 × 1133), with Chromium's own
// Pencil and fingers (trusted). Upright, a finger's tap on the pull tab opens the book. Each way up, the paper runs
// from the band's foot to the screen's, its head never below HQ's buttons. The scraps spread across the page's width.
// The bookmarks stand along the top, tucked behind the page, each reaching out a step less than the one before, and a
// finger's tap turns to a chapter and back. A call's page has one title, the Pencil near it changing nothing there.
// The tool rail floats: slim toolbars in HQ's look, in from the paper's edges, the paper running on under them and
// what's written ending left of them, the page's controls in the one at the rail's foot; the Pencil's tap and a
// finger's each pick a tool on it.
// The Pencil's line in a scrap's room is saved as that scrap's ink. The Pencil's arrow begun by the page's left edge
// draws, the book staying open; a finger's taps, each where the page arrows were at the start, turn to a read-only
// call's page and back, the arrows never moving; and a finger's swipe from that edge still closes the book (board,
// call 174). Two fingers move the page down and draw nothing. Recorded with --shots.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, chromiumPen, middleOf, touchOf, until } from './bookkit.mjs';
import { SEED, units } from './bookunitspage.mjs';
import { UNIT_W } from './shell/ink/scrapunit.js';
import { bareOf } from './bookdrawn.mjs';
import { picksByHand, railFloats } from './bookfillrail.mjs';

// an iPad's home-screen app: its status bar and iOS's blurred band under it (style.css)
const BAND = 24 + 48;
// the agent's scraps three times over, so the page is longer than the screen either way up, on a call's notes page titled
// as the store titles one: the call's date and time, then its topic (callnotes.ts). After it, a later call's page,
// read-only till its follow-up goes (as a page sent: the rail's tools give way to a lock).
const T1 = '2026-10-30T11:00:00.000Z';
const LONG = {
  ...SEED,
  pages: [
    ...SEED.pages.map((p, i) => (i ? p : { ...p, kind: 'call', label: '29 Oct, 15:00, Ink walk-through' })),
    { ...SEED.pages[0], id: 2, pos: 1, kind: 'call', label: '30 Oct, 11:00, Rail check', send_at: Date.parse(T1) },
  ],
  groups: [0, 100, 200].flatMap(n => SEED.groups.map(g => ({ ...g, id: g.id + n, pos: g.pos + n }))),
};

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function fillStories(c) {
  return {
    "the board's iPad by hand, both ways up: the notebook fills the height under iOS's blur and the page's width, the Pencil writes and two fingers scroll":
      async browser => {
        // (both ways up shot and checked, the failures told together)
        const failed = [];
        for (const [name, viewport] of [
          ['sideways', MINI],
          ['upright', UPRIGHT],
        ])
          await byHand(browser, c, name, viewport).catch(e => failed.push(`${name}: ${e.message}`));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

async function byHand(browser, c, name, viewport) {
  const context = await c.hqIn(browser, viewport, {
    notebooks: structuredClone(LONG),
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(band => {
    const set = () => document.documentElement.style.setProperty('--sat', `${band}px`);
    document.addEventListener('DOMContentLoaded', set);
  }, BAND);
  // (no microphone: a press held still before it moves is a voice note, bookinput.js)
  await context.addInitScript(() => (navigator.mediaDevices.enumerateDevices = async () => []));
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    const cdp = await context.newCDPSession(page),
      hand = { pen: chromiumPen(cdp), touch: touchOf(cdp) };
    await opened(page, c, hand, viewport);
    await c.shot(`fill-${name}-1-open`, page);
    await fillsHeight(page);
    await fillsWidth(page);
    await tabsOnTop(page, hand);
    await railFloats(page);
    await picksByHand(page, hand);
    await oneTitle(page, hand);
    await writes(page, context, hand);
    await edgeDraws(page, hand);
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
  await until(async () => (await units(page)).length === LONG.groups.length, 'the scraps drawn');
}

// The book's pages from the blurred band's foot to the screen's: their head (the bookmarks' where they stand on the
// paper, upright) no lower than HQ's buttons
async function fillsHeight(page) {
  const seen = await page.evaluate(() => {
    const paper = document.querySelector('#book .bk-paper').getBoundingClientRect(),
      marks = document.querySelector('#book .bk-marks').getBoundingClientRect(),
      buttons = [...document.querySelectorAll('#hud button')].map(b => b.getBoundingClientRect()).filter(r => r.width);
    return {
      head: Math.min(paper.top, marks.top),
      foot: paper.bottom,
      buttons: Math.min(...buttons.map(r => r.top)),
      screen: innerHeight,
    };
  });
  assert.ok(seen.head >= BAND - 1, `the book's head under the blur (${JSON.stringify(seen)})`);
  assert.ok(seen.head <= seen.buttons + 1, `the book's head no lower than HQ's buttons (${JSON.stringify(seen)})`);
  assert.ok(seen.foot >= seen.screen - 1, `the paper down to the screen's foot (${JSON.stringify(seen)})`);
}

// The scraps' columns across the whole page left of the tools: on each side a margin, never room for a fifth of a scrap
async function fillsWidth(page) {
  const desk = await page.locator('#book .bk-desk').boundingBox(),
    all = await units(page),
    left = Math.min(...all.map(u => u.x)) - desk.x,
    right = desk.x + desk.width - Math.max(...all.map(u => u.x + u.w)),
    fifth = all[0].w / 5;
  assert.ok(
    [left, right].every(side => side >= 0 && side < fifth),
    `the scraps across the page: ${Math.round(left)} px beside them on the left, ${Math.round(right)} on the right, between 0 and ${Math.round(fifth)} wanted`,
  );
}

// The Pencil's line in the first scrap's room: saved as that scrap's ink
async function writes(page, context, { pen }) {
  const [first] = await units(page),
    inked = () =>
      context.notebook.route('/api/notebooks/pages/groups', { page: 1 }).groups.find(g => g.id === first.id).ink.length,
    was = inked(),
    y = first.y + first.h - 40 * (first.w / UNIT_W);
  await pen.stroke(Array.from({ length: 14 }, (_, k) => [first.x + 40 + k * 12, y + Math.sin(k / 2) * 6]));
  await until(() => inked() > was, "the Pencil's line saved in the scrap's room", 8000);
}

// The Pencil's arrow begun by the page's left edge, moving right (away from the edge) first: drawn where it went, and
// the book stays open (board, call 174: only a deliberate pull on the edge moves the book)
async function edgeDraws(page, { pen }) {
  const mode = () => page.evaluate(() => document.documentElement.dataset.book),
    was = await mode(),
    paper = await page.locator('#book .bk-paper').boundingBox(),
    x = paper.x + 14,
    y = paper.y + paper.height * 0.55,
    shaft = Array.from({ length: 12 }, (_, k) => [x + k * 8, y]);
  await pen.stroke([...shaft, [x + 70, y - 14], [x + 60, y - 22]]);
  await page.waitForTimeout(800);
  assert.equal(await mode(), was, "the book left as it was by the Pencil's arrow by its edge");
  assert.deepEqual(await bareOf(page, [shaft[0], shaft[6]]), [], "the Pencil's arrow by the edge drawn where it went");
}

// The page arrows where they were whatever page they turn to: a finger's taps, each where the arrow was at the start,
// turn to the call's page after (read-only, the tools giving way to a lock) and back (board, call 174: the arrows
// jumped, and the board lost the call's page)
async function arrowsStay(page, c, name, { touch }) {
  const arrows = () =>
      page.evaluate(() =>
        ['The page before', 'The page after'].map(label => {
          const r = document.querySelector(`#book .bk-column [aria-label="${label}"]`).getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        }),
      ),
    where = () => page.locator('#book .bk-column .bk-where small').textContent(),
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
  assert.equal(await where(), '1/2', "the call's page first");
  await tap(at(was[1]), '2/2');
  await c.shot(`fill-${name}-3-read-only`, page);
  assert.deepEqual(await arrows(), was, 'the page arrows where they were on the read-only page');
  await tap(at(was[0]), '1/2');
  assert.deepEqual(await arrows(), was, 'the page arrows where they were back on the call page');
  await until(async () => (await units(page)).length === drawn, "the call's page back");
}

// A finger's swipe right from the page's left edge still closes the book: the board following it, folded once let go
async function fingerCloses(page, c, { touch }) {
  const paper = await page.locator('#book .bk-paper').boundingBox(),
    y = paper.y + paper.height * 0.55;
  await touch.down([[paper.x + 14, y]]);
  await touch.move([[paper.x + 14 + paper.width * 0.8, y]], 20);
  await touch.up();
  await c.settled(page, 'folded');
}

// The tabs along the top under the blur, behind the paper: each reaching out a step less than the one before it, the lit
// one too, and the paper over their feet, the lit one's too. A finger's tap on Sketch lights it, one on Calls brings
// the call's page back.
async function tabsOnTop(page, { touch }) {
  const seen = () =>
      page.evaluate(() => {
        const paper = document.querySelector('#book .bk-paper').getBoundingClientRect();
        return [...document.querySelectorAll('#book .bk-marks button')].map(b => {
          const r = b.getBoundingClientRect(),
            under = document.elementFromPoint(r.left + r.width / 2, paper.top + 2);
          return {
            chapter: b.dataset.chapter,
            lit: b.getAttribute('aria-current') === 'page',
            box: { x: r.left, y: r.top, width: r.width, height: r.height },
            reach: paper.top - r.top,
            tucked: r.bottom > paper.top && !b.contains(under),
          };
        });
      }),
    tabs = await seen(),
    said = JSON.stringify(tabs.map(({ chapter, reach, tucked }) => ({ chapter, reach, tucked })));
  assert.deepEqual(
    tabs.map(t => t.chapter),
    ['sketch', 'asks', 'calls'],
    said,
  );
  assert.ok(
    tabs.every(t => t.box.y >= BAND - 1),
    `the tabs under the blur: ${said}`,
  );
  assert.ok(
    tabs.every(t => t.tucked),
    `the paper over every tab's foot: ${said}`,
  );
  assert.ok(
    tabs.every((t, i) => !i || t.reach < tabs[i - 1].reach),
    `each tab reaching out less than the one before: ${said}`,
  );
  assert.equal(tabs.find(t => t.lit)?.chapter, 'calls', "the call's page under Calls");
  const tap = async chapter => {
    await touch.down([middleOf(tabs.find(t => t.chapter === chapter).box)]);
    await touch.up();
    await until(
      async () => (await seen()).find(t => t.lit)?.chapter === chapter,
      `a finger's tap on ${chapter} lights it`,
      8000,
    );
  };
  await tap('sketch');
  await tap('calls');
  await until(async () => (await units(page)).length === LONG.groups.length, "the call's page back");
}

// The call's page: one title, the call's date and time leading it, no date of its own under it; a Pencil line beside
// the title leaves it as it was, nothing in the page's head coming or going
async function oneTitle(page, { pen }) {
  const head = () =>
      page.evaluate(() => {
        const shown = document.querySelector('#book .bk-page:not([hidden])'),
          first = Math.min(...[...shown.querySelectorAll('.bk-unit')].map(u => u.getBoundingClientRect().top));
        return [...shown.querySelectorAll('.bk-page-title, .bk-day')]
          .map(el => ({ words: el.textContent, top: Math.round(el.getBoundingClientRect().top) }))
          .filter(el => el.top < first);
      }),
    was = await head();
  assert.deepEqual(
    was.map(el => el.words),
    ['29 Oct, 15:00, Ink walk-through'],
    `one title in the page's head: ${JSON.stringify(was)}`,
  );
  const title = await page.locator('#book .bk-page:not([hidden]) .bk-page-title span').boundingBox(),
    y = title.y + title.height + 10;
  await pen.stroke(Array.from({ length: 10 }, (_, k) => [title.x + title.width + 16 + k * 8, y + Math.sin(k) * 4]));
  await page.waitForTimeout(800);
  assert.deepEqual(await head(), was, "the page's head as it was after the Pencil came near the title");
}

// Two fingers a hand's width apart drawn up the page, put down on the page well clear of the scraps' room handles (a
// finger near a handle is the handle's: Chromium's touch adjustment takes it there): it moves down, and nothing new is
// drawn
async function scrolls(page, { touch }) {
  const desk = await page.locator('#book .bk-desk').boundingBox(),
    [[left, right], y] = await page.evaluate(desk => {
      const handles = [...document.querySelectorAll('#book .bk-room-handle')].map(h => h.getBoundingClientRect()),
        clear = (x, y) =>
          handles.every(r => y < r.top - 40 || y > r.bottom + 40 || x < r.left - 40 || x > r.right + 40),
        mid = desk.y + desk.height / 2;
      for (const pair of [
        [0.3, 0.7],
        [0.12, 0.5],
        [0.5, 0.88],
        [0.12, 0.88],
      ])
        for (const d of [0, 40, -40, 80, -80, 120, -120]) {
          const xs = pair.map(f => desk.x + desk.width * f),
            y = mid + d;
          if (xs.every(x => clear(x, y + 150) && clear(x, y - 150))) return [xs, y];
        }
      return [[desk.x + desk.width * 0.3, desk.x + desk.width * 0.7], mid];
    }, desk),
    count = async () => (await units(page)).length,
    was = { pan: await panned(page), units: await count() };
  await touch.down([
    [left, y + 150],
    [right, y + 150],
  ]);
  await touch.move([
    [left, y - 150],
    [right, y - 150],
  ]);
  await touch.up();
  await until(async () => (await panned(page)) > was.pan + 100, 'the page moved down by two fingers', 4000);
  await page.waitForTimeout(600);
  assert.equal(await count(), was.units, 'two fingers drew nothing');
}
// How far down the page is moved, in screen px
const panned = page =>
  page.evaluate(() => {
    const moved = /translate3d\(-?[\d.]+px, (-?[\d.]+)px/.exec(
      document.querySelector('#book .bk-world').style.transform,
    );
    return -Number(moved[1]);
  });
