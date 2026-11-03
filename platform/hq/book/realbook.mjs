// book-check.mjs's story of the Notebook's frame as a real book (the Ink README, "The book's frame"; shell/ink/book.css,
// bookstrip.css, bookmarks.css), at the sizes of the board's mock-up: an iPhone upright (390 × 844, its status bar's
// blur 54 px and home bar 34 px), an iPad sideways (1133 × 744, its blur 24 px) and upright, an iPad mini as the
// browser has it, and a desktop. At each: the paper running the screen's whole height and to its right edge, no
// cover band, and the page written on below the blur; the two islands of use (islands.mjs), the bar clear of the
// home bar; the bookmarks below the blur. What the islands hold: bar.mjs; where the bookmarks lie:
// bookmarks.mjs. Recorded with --shots, the board's pictures. (the islands' and the bookmarks' checks)
import assert from 'node:assert/strict';
import { atEverySize, toChapter, until } from './kit.mjs';
import { blurred, islandsSeen, islandsUsable } from './islands.mjs';
import { tabs } from './bookmarks.mjs';
import { hqLoaded, restsOpen } from './start.mjs';
import { typedBoxes } from '../shell/ink/notebookparts.js';

const SIZES = {
  iphone: { width: 390, height: 844, sat: 54, sab: 34 },
  ipad: { width: 1133, height: 744, sat: 24, sab: 20 },
  'ipad-upright': { width: 744, height: 1133, sat: 24, sab: 20 },
  'ipad-mini': { width: 1133, height: 744 },
  desktop: { width: 1440, height: 900 },
};
// My journal as the mock-up has it: a sketch page, a call's notes, the shop page and the Asks page, so the pictures have
// pages and notes on them
const T0 = '2026-11-02T10:00:00.000Z',
  page = (id, label, more = {}) => ({
    id,
    notebook: 1,
    pos: id - 1,
    label,
    created: T0,
    updated: T0,
    w: 1200,
    h: 1600,
    ...more,
  }),
  note = (id, on, words, h = 136) => ({
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
    h,
  });
const SEED = {
  notebooks: [
    { id: 1, kind: 'mine', name: 'My journal', archived: false, created: T0, updated: T0, asks: { open: 2, all: 3 } },
  ],
  pages: [
    page(1, 'Ideas'),
    page(2, 'Call with Lyra: the real book', { kind: 'call' }),
    page(3, 'Shop page'),
    page(4, 'Asks', { kind: 'asks' }),
  ],
  groups: [
    note(1, 2, 'Tabs out of the page block on the iPad; folded at the edge on the phone.'),
    note(2, 2, 'Tear from the spine: the page shrinks and goes onto Send. Room to write under it:', 320),
    note(3, 2, 'The count and its arrows exactly in the middle of the bar.'),
    note(4, 3, 'The price under the picture, not beside it.'),
    note(5, 3, 'A softer page turn, and a paper sound with it.', 220),
  ],
  slips: [],
  asks: [],
  names: { lyra: 'Lyra' },
};

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function realBookStories(c) {
  return {
    "the Notebook as a real book: the page to the screen's edges, the islands of use and nothing under the blur, the bar clear of the home bar":
      atEverySize(SIZES, (browser, name, size) => atSize(browser, c, name, size)),
  };
}

async function atSize(browser, c, name, size) {
  const { context, p, errors } = await opened(browser, c, name, size);
  try {
    judged(
      name,
      size,
      await islandsSeen(p),
      (await tabs(p)).map(t => ({ chapter: t.chapter, top: t.box.y })),
    );
    await c.shot(`realbook-${name}`, p);
    await pictures(p, c, name, size);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`realbook-${name}-failed`, p);
    e.message = `${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}

// HQ at a size, with the device's blur and home bar as Safari's env() gives them (style.css's --sat and --sab), the
// book open: beside HQ's page sideways, the spread upright
async function opened(browser, c, name, { width, height, sat = 0, sab = 0 }) {
  const context = await c.hqIn(
    browser,
    { width, height },
    { notebooks: structuredClone(SEED), hasTouch: name !== 'desktop', isMobile: false },
  );
  if (sat) await blurred(context, { sat, sab });
  const { page: p, errors } = await hqLoaded(c, context);
  await restsOpen(p, c, { width, height });
  await until(() => p.evaluate(() => !!document.querySelector('#book .bk-marks .bk-mk-tab')), 'the bookmarks');
  return { context, p, errors };
}

// The board's other pictures: the bookmarks out (a phone's, folded till tapped), a call's notes, the pen's card, the
// dots menu, and a sketch page torn from the spine, in hand with Submit, PDF and PNG up, then over a target (let go
// over none of them, it flies back). (a call's notes, the pen's card and the tear from a sketch page)
async function pictures(p, c, name, { width, sat = 0 }) {
  if (name !== 'iphone' && name !== 'ipad') return;
  if (name === 'iphone') {
    await p.locator('#book .bk-marks [data-chapter=calls] .bk-mk-icon').click();
    await p.locator('#book .bk-marks[data-out]').waitFor();
    await p.waitForTimeout(600);
    await c.shot(`realbook-${name}-bookmarks`, p);
  }
  await toChapter(p, 'calls');
  await p.waitForTimeout(800);
  await c.shot(`realbook-${name}-notes`, p);
  // (the pen in use: pressed again, its card opens)
  await p.locator("#book .bk-strip .bk-btn[data-mode='pen']").click();
  await settledOn(p, '#book .bk-palette');
  await c.shot(`realbook-${name}-pen`, p);
  await p.keyboard.press('Escape');
  await p.locator('#book .bk-palette').waitFor({ state: 'detached' });
  await p.locator('#book .bk-more').click();
  await p.waitForSelector('#book .bk-more-card');
  await c.shot(`realbook-${name}-menu`, p);
  await p.keyboard.press('Escape');
  await torn(p, c, name, { width, sat });
}
// A page torn from the spine, from a sketch page (a call's notes page goes as its call ends, so Submit doesn't take
// it): in hand beside the three targets, then over one, then let go over none, flying back
async function torn(p, c, name, { width, sat }) {
  await toChapter(p, 'sketch');
  await p.waitForTimeout(800);
  const y = sat + 90,
    across = Math.min(width * 0.45, 240);
  await p.mouse.move(width - 6, y);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(width - 6 - (across * i) / 12, y + 4 * i);
  await until(() => p.evaluate(() => !!document.querySelector('#book .bk-controls[data-targets]')), 'the targets');
  assert.ok(await p.locator("#book .bk-share [data-share='submit']").isVisible(), 'Submit up for a sketch page');
  // (held just left of the targets, so the picture shows all three beside the page in hand)
  const targets = await p.locator('#book .bk-share').boundingBox();
  await p.mouse.move(targets.x - 24, y + 48, { steps: 8 });
  await settledOn(p, '#book .bk-held');
  await c.shot(`realbook-${name}-tear`, p);
  const target = await p.locator('#book .bk-share button:not([hidden])').first().boundingBox();
  await p.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await until(
    () =>
      p.evaluate(() => {
        const held = document.querySelector('#book .bk-held[data-over]');
        return !!held && !held.getAnimations().length;
      }),
    'the page drawn in towards the target',
  );
  await c.shot(`realbook-${name}-tear-target`, p);
  await p.mouse.move(width / 2, y, { steps: 8 });
  await p.mouse.up();
  await until(() => p.evaluate(() => !document.querySelector('#book .bk-controls[data-targets]')), 'the page back');
}

// What a selector finds shown and at rest: no transition or animation still running on it (WebKit's can stall a moment
// under load), so a picture never catches it half way
const settledOn = (p, selector) =>
  until(
    () =>
      p.evaluate(selector => {
        const el = document.querySelector(selector);
        return !!el?.checkVisibility() && !el.getAnimations({ subtree: true }).length;
      }, selector),
    `${selector} at rest`,
  );

// The frame judged against the board's points: the paper the screen's whole height and to its right edge, the whole
// screen upright, and the page written on starting below the blur; the islands of use, and the bar clear of the home
// bar; each bookmark below the blur
function judged(name, { width, height, sat = 0, sab = 0 }, seen, tabs) {
  const { paper, desk, bar } = seen;
  assert.ok(paper.top <= 0 && paper.bottom >= height, `the paper runs the screen's height: ${json(paper)}`);
  assert.ok(paper.right >= width, `the paper reaches the screen's right edge: ${json(paper)}`);
  if (height > width) assert.ok(paper.left <= 0, `upright, the page is the whole screen: ${json(paper)}`);
  assert.ok(desk.top >= sat, `the page written on starts below the blur: ${desk.top}`);
  islandsUsable(seen, name);
  assert.ok(bar.bottom <= height - sab, `the bar clear of the home bar: ${json(bar)}`);
  for (const t of tabs) assert.ok(t.top >= sat, `${t.chapter} below the blur: ${t.top}`);
}

// Where each bookmark's top is on the screen
// A box's edges, rounded, for the messages
const json = ({ left, top, right, bottom }) => JSON.stringify([left, top, right, bottom].map(Math.round));
