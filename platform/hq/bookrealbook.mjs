// book-check.mjs's story of the Notebook's frame as a real book (board, calls 190 and 191; shell/ink/book.css,
// bookstrip.css, bookmarks.css), at the sizes of the board's mock-up: an iPhone upright (390 × 844, its status bar's
// blur 54 px and home bar 34 px), an iPad sideways (1133 × 744, its blur 24 px) and upright, an iPad mini as the
// browser has it, and a desktop. At each: the paper running the screen's whole height and to its right edge, no
// cover band; nothing to press under the blur; the tools' island on the right, short (well under half the page's
// height on a phone), clear of the bar; the bar along the foot between the screen's corners, Undo and Redo at its
// left, the page's count in its very middle; the bookmarks below the blur, out of the page block beside HQ's page or
// folded at the page's left edge where the page is the whole screen. Recorded with --shots, the board's pictures.
import assert from 'node:assert/strict';
import { until } from './bookkit.mjs';
import { typedBoxes } from './shell/ink/notebookparts.js';

const SIZES = {
  iphone: { width: 390, height: 844, sat: 54, sab: 34 },
  ipad: { width: 1133, height: 744, sat: 24, sab: 20 },
  'ipad-upright': { width: 744, height: 1133, sat: 24, sab: 20 },
  'ipad-mini': { width: 1133, height: 744 },
  desktop: { width: 1440, height: 900 },
};
// the share of the screen's height the tools' island may take on a phone: the board's "well under half" (the mock-up's
// is 32%)
const TOOLS_SHARE = 0.4;
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
  ],
  slips: [],
  asks: [],
  names: { lyra: 'Lyra' },
};

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function realBookStories(c) {
  return {
    "the Notebook as a real book: the page to the screen's edges, nothing under the blur, two islands clear of the corners, the bar's count centred":
      async browser => {
        const failed = [];
        for (const [name, size] of Object.entries(SIZES))
          await atSize(browser, c, name, size).catch(e => failed.push(`${name}: ${e.message}`));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

async function atSize(browser, c, name, size) {
  const { context, p, errors } = await opened(browser, c, name, size);
  try {
    judged(name, size, await frame(p, size.sat ?? 0));
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
  if (sat)
    await context.addInitScript(
      ([top, foot]) =>
        document.addEventListener('DOMContentLoaded', () =>
          document.head.append(
            Object.assign(document.createElement('style'), {
              textContent: `:root { --sat: ${top}px !important; --sab: ${foot}px !important; }`,
            }),
          ),
        ),
      [sat, sab],
    );
  const p = await context.newPage(),
    errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(`${c.base}/?intro=0`);
  await p.waitForSelector('#book .bk-lip', { timeout: 30_000 });
  if (height > width) {
    await c.settled(p, 'folded');
    await p.evaluate(() => document.querySelector('#book .bk-lip').click());
  }
  await c.settled(p, height > width ? 'spread' : 'open');
  await until(() => p.evaluate(() => !!document.querySelector('#book .bk-marks .bk-mk-tab')), 'the bookmarks');
  return { context, p, errors };
}

// The board's other pictures: the bookmarks out (a phone's, folded till tapped), the dots menu, and a page torn from
// the spine, in hand, then over a target (let go over none of them, it flies back)
async function pictures(p, c, name, { width, sat = 0 }) {
  if (name !== 'iphone' && name !== 'ipad') return;
  // (a call's notes on the page; on a phone the first tap brings the folded tabs out, the second goes to the chapter)
  const calls = p.locator('#book .bk-marks .bk-mk-tab[data-chapter="calls"]');
  await calls.click();
  await p.waitForTimeout(600);
  if (name === 'iphone') {
    await c.shot(`realbook-${name}-bookmarks`, p);
    await calls.click();
  }
  await p.waitForTimeout(800);
  await c.shot(`realbook-${name}-notes`, p);
  await p.locator('#book .bk-more').click();
  await p.waitForSelector('#book .bk-more-card');
  await c.shot(`realbook-${name}-menu`, p);
  await p.keyboard.press('Escape');
  const y = sat + 90,
    across = Math.min(width * 0.45, 240);
  await p.mouse.move(width - 6, y);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(width - 6 - (across * i) / 12, y + 4 * i);
  await until(() => p.evaluate(() => !!document.querySelector('#book .bk-controls[data-targets]')), 'the targets');
  await p.waitForTimeout(400);
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

// The frame judged against the board's points
function judged(name, { width, height, sat = 0, sab = 0 }, f) {
  const upright = height > width;
  // the page: the whole height, to the screen's right edge (the spine), no cover band at its head or foot
  assert.ok(f.paper.top <= 0 && f.paper.bottom >= height, `the paper runs the screen's height: ${json(f.paper)}`);
  assert.ok(f.paper.right >= width, `the paper reaches the screen's right edge: ${json(f.paper)}`);
  if (upright) assert.ok(f.paper.left <= 0, `upright, the page is the whole screen: ${json(f.paper)}`);
  assert.ok(f.desk.top >= sat, `the drawable page starts below the blur: ${f.desk.top}`);
  assert.deepEqual(f.underBlur, [], 'nothing pressable under the blur');
  // the tools: on the right, short, clear of the bar, the pen first and shapes after it
  assert.ok(f.tools.right <= width && width - f.tools.right <= 16, `the tools at the right: ${json(f.tools)}`);
  assert.ok(f.tools.top >= sat, `the tools below the blur: ${json(f.tools)}`);
  if (name === 'iphone')
    assert.ok(f.tools.height <= TOOLS_SHARE * height, `the tools' island short: ${f.tools.height} of ${height}`);
  assert.ok(f.tools.bottom <= f.bar.top, `the tools clear of the bar: ${json(f.tools)} ${json(f.bar)}`);
  assert.deepEqual(f.toolsOrder.slice(1, 2), ['shapes'], `the pen first, then shapes: ${f.toolsOrder}`);
  // the bar: along the foot, between the corners, clear of the home bar, Undo and Redo at its left, the count centred
  assert.ok(f.bar.bottom <= height - Math.max(12, sab), `the bar clear of the home bar: ${json(f.bar)}`);
  assert.ok(f.bar.left >= f.paper.left + 8 && f.bar.right <= width - 8, `the bar on the page: ${json(f.bar)}`);
  assert.deepEqual(f.start, ['Undo', 'Redo'], "Undo and Redo at the bar's left");
  assert.ok(Math.abs(f.where - f.middle) <= 1, `the count in the bar's middle: ${f.where} against ${f.middle}`);
  assert.match(f.whereWords, /^\d+ \/ \d+$/, `the count reads "3 / 12"`);
  // the bookmarks: below the blur, out of the page block (beside HQ's page) or folded at the page's left edge
  for (const t of f.tabs) {
    assert.ok(t.top >= sat, `${t.chapter} below the blur: ${t.top}`);
    if (upright) assert.ok(t.right <= 24, `${t.chapter} folded at the left edge: ${t.right}`);
    else assert.ok(t.left < f.paper.left - 12, `${t.chapter} out of the page block: ${t.left}`);
  }
}

// The frame as it's drawn: the paper's and the islands' boxes, what's pressable under the blur, the bar's parts
const frame = (p, sat) =>
  p.evaluate(sat => {
    const box = el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      },
      $ = s => document.querySelector(s),
      leaf = box($('#book .bk-leaf')),
      bar = $('#book .bk-bar'),
      where = $('#book .bk-bar .bk-where'),
      underBlur = [];
    // (every 6 px across the book, just under the screen's top and just above the blur's foot; none without a blur)
    for (let x = Math.max(0, leaf.left - 40); x < innerWidth; x += 6)
      for (const y of sat ? [2, sat - 2] : []) {
        const hit = document.elementFromPoint(x, y)?.closest('#book button, #book [role=separator], #book a');
        if (hit && !underBlur.includes(hit.className)) underBlur.push(hit.className);
      }
    return {
      paper: box($('#book .bk-paper')),
      desk: box($('#book .bk-desk')),
      tools: box($('#book .bk-strip')),
      toolsOrder: [...document.querySelectorAll('#book .bk-strip [data-mode]')]
        .filter(b => b.offsetParent)
        .map(b => b.dataset.mode),
      bar: box(bar),
      start: [...bar.querySelectorAll('.bk-bar-start .bk-btn')].map(b => b.getAttribute('aria-label')),
      middle: box(bar).left + box(bar).width / 2,
      where: box(where).left + box(where).width / 2,
      whereWords: where.textContent.trim(),
      underBlur,
      tabs: [...document.querySelectorAll('#book .bk-marks .bk-mk-tab')].map(t => ({
        chapter: t.dataset.chapter,
        ...box(t),
      })),
    };
  }, sat);
const json = b => JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)])));
