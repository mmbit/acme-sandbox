// book-check.mjs's story of the book's two islands as frosted glass (the Ink README, "The book's frame": the glass
// bars; shell/ink/bookstrip.css and each look's skin.css), in every HQ look: Slate by day and by night, Brownstone and
// Holo, on an iPhone, an iPad both ways and a desktop. A call's page of notes inked over, scrolled so a note runs under the bar.
// At each: the bar on the page and the tools' island on a note opened let what's under them through (their panel part
// see-through, blurred), and their keys still read on it. Recorded with --shots.
// (the tools an opened scrap's)
import assert from 'node:assert/strict';
import { LOOK_SCHEMES, openScrap, toChapter, until } from './kit.mjs';
import { mouseOf } from './hands.mjs';
import { cardInSight } from './mouse.mjs';
import { blurred } from './islands.mjs';
import { restsOpen } from './start.mjs';
import { typedBoxes } from '../shell/ink/notebookparts.js';

const SIZES = {
  iphone: { width: 390, height: 844, sat: 54, sab: 34, under: 72 },
  ipad: { width: 1133, height: 744, sat: 24, sab: 20, under: 96 },
  'ipad-upright': { width: 744, height: 1133, sat: 24, sab: 20, under: 96 },
  desktop: { width: 1440, height: 900, sat: 0, under: 96 },
};
const T0 = '2026-11-03T10:00:00.000Z',
  page = (id, label, more = {}) => ({
    id,
    notebook: 1,
    pos: id - 1,
    label,
    created: T0,
    updated: T0,
    w: 1200,
    h: 2400,
    ...more,
  }),
  note = (id, words, h = 136) => ({
    ...{ id, page: 2, kind: 'note', by: 'lyra', owner_name: 'Lyra', ink: INK(h), pictures: [] },
    ...{ words: '', said: 'typed' },
    ...{ texts: typedBoxes(words, { x: 0, w: 320, color: '#1d1a2f' }), status: 'sent', created: T0, updated: T0 },
    ...{ pos: id, h },
  });
// The board's ink over a note, in its own px: a red wave under the words and a blue circle round them
const INK = h => [
  {
    color: '#d83a34',
    size: 4,
    points: Array.from({ length: 33 }, (_, i) => [8 + i * 10, h - 24 + 7 * Math.sin(i / 1.6), 0.5, i * 16]),
  },
  {
    color: '#2f62c9',
    size: 3,
    points: Array.from({ length: 41 }, (_, i) => {
      const a = (i / 40) * 2.15 * Math.PI - 0.5;
      return [165 + 175 * Math.cos(a), (h - 30) / 2 + ((h - 6) / 2) * Math.sin(a), 0.5, i * 16];
    }),
  },
];
const WORDS = [
  'Tabs out of the page block on the iPad, folded at the edge on the phone.',
  'The count and its arrows exactly in the middle of the bar.',
  'The price under the picture, not beside it.',
  'A softer page turn, and a paper sound with it.',
  'The bars lighter, a little glass, not overdone.',
  'Send the sketch to Lyra once the colours are right.',
  'Try the marker over a photo before we ship it.',
  'Bookmarks with no dark outline, like the label.',
];
const SEED = {
  notebooks: [
    { id: 1, kind: 'mine', name: 'My journal', archived: false, created: T0, updated: T0, asks: { open: 2, all: 3 } },
  ],
  pages: [page(1, 'Ideas'), page(2, 'Call with Lyra: the bars', { kind: 'call' }), page(3, 'Asks', { kind: 'asks' })],
  groups: WORDS.map((w, i) => note(i + 1, w, i % 3 === 1 ? 200 : 136)),
  slips: [],
  asks: [],
  names: { lyra: 'Lyra' },
};

// c: book-check.mjs's hqIn, base, settled, shot
export function glassStories(c) {
  return {
    "the glass bars: the tools' island and the bar frosted glass in every look, their keys read on it":
      async browser => {
        for (const [look, how] of Object.entries(LOOK_SCHEMES))
          for (const [name, size] of Object.entries(SIZES))
            try {
              await glassAt(browser, c, `${look}-${name}`, how, size);
            } catch (e) {
              e.message = `${look} on the ${name}: ${e.message}`;
              throw e;
            }
      },
  };
}

async function glassAt(browser, c, name, { renderer, colorScheme }, size) {
  const { width, height, sat, sab } = size;
  const context = await c.hqIn(
    browser,
    { width, height },
    { notebooks: structuredClone(SEED), hasTouch: true, isMobile: false, colorScheme },
  );
  await blurred(context, { sat, sab });
  try {
    const p = await context.newPage();
    await p.goto(`${c.base}/?intro=0&renderer=${renderer}`);
    await restsOpen(p, c, size);
    await until(() => p.evaluate(() => !!document.querySelector('#book .bk-marks .bk-mk-tab')), 'the bookmarks');
    await toChapter(p, 'calls');
    await p.waitForTimeout(800);
    await p.evaluate(by => (document.querySelector('#book .bk-desk').scrollTop += by), size.under);
    await p.waitForTimeout(600);
    await c.shot(`glass-${name}`, p);
    const bars = await p.evaluate(glassOf, ['bar', '#book .bk-bar']);
    await openScrap(p, mouseOf(p), undefined, await cardInSight(p));
    await c.shot(`glass-${name}-scrap`, p);
    for (const bar of [...bars, ...(await p.evaluate(glassOf, ['tools', '#book .bk-strip']))]) {
      // (frosted and see-through at all, not by how much: the look's own numbers are the look's.)
      assert.match(bar.filter, /blur\(/, `the ${bar.which} isn't frosted: ${bar.filter}`);
      assert.ok(
        bar.alpha > 0 && bar.alpha < 1,
        `the ${bar.which}'s panel lets nothing through, or is none (${bar.alpha})`,
      );
      assert.ok(bar.keys > 0, `no key shows on the ${bar.which}`);
    }
  } finally {
    await context.close();
  }
}

// An island's frost (its backdrop filter), how opaque its panel is (its background colour's alpha) and how many keys
// show on it
function glassOf([which, selector]) {
  const alphaOf = colour => {
    const m = colour.match(/rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/);
    const parts = (m?.[1] ?? m?.[2] ?? '').split(/[ ,/]+/).filter(Boolean);
    return parts.length > 3 ? Number(parts[3]) : 1;
  };
  const el = document.querySelector(selector),
    style = getComputedStyle(el);
  return [
    {
      which,
      filter: style.backdropFilter || style.webkitBackdropFilter,
      alpha: alphaOf(style.backgroundColor),
      keys: [...el.querySelectorAll('.bk-btn')].filter(b => b.offsetWidth && !b.hidden).length,
    },
  ];
}
