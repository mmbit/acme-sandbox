// node --test platform/hq/shell/ink/bookunits.test.js   (a page's units laid as the board draws on it; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// (the browser has review mode's files at /__review/, as the coordinator serves them, and the sound kit at /foley.js)
const REVIEW = new URL('../../../../shared/review/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === '../foley.js'
      ? { url: 'data:text/javascript,export const foley = () => {};', shortCircuit: true }
      : next(
          specifier.startsWith('/__review/') ? new URL(specifier.slice('/__review/'.length), REVIEW).href : specifier,
          context,
        ),
});
// (what the modules read of the browser, and the page's own element: nothing hangs under its units)
const element = () => ({
  style: {},
  children: [],
  dataset: {},
  prepend() {},
  append() {},
  addEventListener() {},
  setAttribute() {},
  querySelector: () => null,
  querySelectorAll: () => [],
});
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, dispatchEvent: () => {}, createElement: element, head: element() };
globalThis.location = { hostname: '', search: '', pathname: '/' };
// (dev mode's store, notebookplay.js, seeded with the pages below: each test draws on one of its own)
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SEED });
const { cardOf, heightOf, inkUnit, layUnits } = await import('./bookunits.js');
const { UNIT_W } = await import('./scrapunit.js');
const { boxOf } = await import('./bookrow.js');
const { changed, readAgain, readPage, saved } = await import('./booksave.js');
const { widthFor } = await import('./masonry.js');

// an iPad mini upright's page: two columns (bookunits.js keeps 8 px off the paper's sides)
const WIDTH = widthFor(2) + 16;
const NOW = new Date().toISOString(),
  YESTERDAY = new Date(Date.now() - 864e5).toISOString();
// A line through points on the page (its px)
const line = points => ({ color: '#2a2352', size: 4, points: points.map(([x, y]) => [x, y, 0.5, 0]) });
// The board's drawings on each test's page as the store keeps them, by page: [{ column?, ink: [points], created? }],
// ink in each unit's own px, in their order
const PAGES = {
  // (the left column: a word, and a box drawn under it, kept under it)
  1: [
    {
      column: 0,
      ink: [
        [
          [10, 10],
          [200, 40],
        ],
      ],
    },
    {
      ink: [
        [
          [10, 10],
          [200, 60],
        ],
      ],
    },
  ],
  // (the same, and a tall drawing in the right column)
  2: [
    {
      column: 0,
      ink: [
        [
          [10, 10],
          [200, 40],
        ],
      ],
    },
    {
      ink: [
        [
          [10, 10],
          [200, 60],
        ],
      ],
    },
    {
      column: 1,
      ink: [
        [
          [10, 10],
          [200, 300],
        ],
      ],
    },
  ],
  // (three of an agent's scraps, a picture each: the first two side by side, the third under the first)
  4: [0, 1, 2].map(() => ({ scrap: true, ink: [], h: 260 })),
  // (yesterday's word, alone in the left column)
  3: [
    {
      column: 0,
      ink: [
        [
          [10, 10],
          [200, 40],
        ],
      ],
      created: YESTERDAY,
    },
  ],
};
// (the board's wide drawing in the left column, its line reaching into the right, and two scraps after it)
PAGES[10] = [
  {
    column: 0,
    ink: [
      [
        [10, 10],
        [500, 60],
      ],
    ],
  },
  ...PAGES[4].slice(0, 2),
];
// (the board's small drawing in the left column, a scrap beside it and one under it)
PAGES[11] = [PAGES[1][0], ...PAGES[4].slice(0, 2)];
// (the board's duck in the left column: its round outline, 280 by 220 and empty inside, and its beak)
const ROUND = Array.from({ length: 49 }, (_, i) => [
  150 + 140 * Math.cos((i / 48) * 2 * Math.PI),
  130 + 110 * Math.sin((i / 48) * 2 * Math.PI),
]);
PAGES[12] = [
  {
    column: 0,
    ink: [
      ROUND,
      [
        [285, 110],
        [320, 125],
        [285, 140],
      ],
    ],
  },
];
const SEED = {
  notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: NOW, updated: NOW }],
  pages: Object.keys(PAGES).map((id, k) => ({ id: Number(id), notebook: 1, pos: k, created: NOW, updated: NOW })),
  groups: Object.entries(PAGES).flatMap(([page, drawings]) =>
    drawings.map((d, k) => ({
      id: Number(page) * 100 + k,
      page: Number(page),
      kind: d.scrap ? 'scrap' : 'drawing',
      ink: d.ink.map(line),
      pictures: d.scrap ? [{ file: 'a.png', url: '/a.png', x: 0, y: 0, w: 320, h: 120, tilt: 0 }] : [],
      pos: k,
      h: d.h ?? 0,
      column: d.column ?? null,
      created: d.created ?? NOW,
      updated: d.created ?? NOW,
    })),
  ),
  slips: [],
  names: {},
};
// Test page id read from the store as the book reads it (booksave.js), on a book in dev mode showing it, laid at WIDTH
async function pageOf(id) {
  const page = { id },
    view = {
      page,
      el: element(),
      place: () => layUnits(view, WIDTH),
      redraw() {},
      refuse: words => (view.said = words),
    },
    book = { dev: true, views: [view] };
  await readPage(book, page);
  view.place();
  return { book, view };
}
// What's drawn, stroke by stroke, as the pen puts it: each into its unit, the page laid again after it
function draw(view, strokes) {
  for (const points of strokes) {
    const el = line(points);
    el.g = inkUnit(view.page, el);
    view.page.ink.push(el);
    layUnits(view, WIDTH);
  }
}
// The page saved as the book saves it (booksave.js: the units drawn here made in the store), read again as the store's
// change has it, and laid
async function save({ book, view }) {
  changed(book, view.page);
  await saved(book, view.page);
  assert.equal(view.said, '', 'saved, nothing refused');
  await readAgain(book, view.page);
  view.place();
}
// Every stroke's points on the page
const inked = page => page.ink.map(el => el.points.map(([x, y]) => [x, y]));

test("a stroke near the board's drawing, reaching past its foot into the gap over the drawing under it, moves neither", async () => {
  const { view } = await pageOf(1),
    before = inked(view.page),
    [word] = view.page.places;
  // (a line under the word, nearer it than the box, its foot in the gap between them)
  draw(view, [
    [
      [word.x + 20, word.y + word.h + 4],
      [word.x + 220, word.y + word.h + 14],
    ],
  ]);
  assert.deepEqual(inked(view.page).slice(0, 2), before, 'what was drawn before stays where it was');
  assert.deepEqual(inked(view.page)[2][0], [word.x + 20, word.y + word.h + 4], 'the line stays where it was drawn');
});

test('a stroke drawn between two units of a column, and the next near it, push neither down, saved or not', async () => {
  const shown = await pageOf(2),
    { view } = shown,
    before = inked(view.page),
    [word] = view.page.places;
  draw(view, [
    [
      [word.x + 10, word.y + word.h + 6],
      [word.x + 40, word.y + word.h + 16],
    ],
    [
      [word.x + 50, word.y + word.h + 6],
      [word.x + 80, word.y + word.h + 16],
    ],
  ]);
  const drawn = inked(view.page);
  assert.deepEqual(drawn.slice(0, 3), before, 'what was drawn before stays where it was');
  await save(shown);
  assert.ok([...view.page.groups.keys()].every(id => id > 0) && !view.page.pending?.length, 'the store has it');
  assert.deepEqual(inked(view.page), drawn, 'and all of it once the store has it');
});

test("a drawing on a page whose last unit is yesterday's stays where it was drawn once the store has it", async () => {
  const shown = await pageOf(3),
    { view } = shown,
    [word] = view.page.places;
  // (in the empty right column)
  draw(view, [
    [
      [word.x + 400, word.y + 300],
      [word.x + 600, word.y + 340],
    ],
  ]);
  const drawn = inked(view.page);
  await save(shown);
  const made = [...view.page.groups.values()].find(g => !PAGES[3].some((_, k) => g.id === 300 + k));
  assert.ok(made && made.created > YESTERDAY, `made in the store today: ${JSON.stringify(made)}`);
  assert.deepEqual(inked(view.page), drawn);
});

const placeOf = (page, id) => page.places.find(p => p.id === id);
// (the page's scraps' places, by id)
const cards = page => Object.fromEntries(page.places.filter(p => p.id > 400).map(p => [p.id, [p.x, p.y]]));

test('a scribble on the note at the bottom lands on it, and no scrap moves', async () => {
  const { view } = await pageOf(4),
    { page } = view,
    last = placeOf(page, 402),
    before = cards(page);
  // (started just above it, in the gap over it, and across its picture)
  draw(view, [
    [
      [last.x + 40, last.y - 12],
      [last.x + 120, last.y + 40],
      [last.x + 200, last.y + 20],
    ],
  ]);
  assert.equal(page.ink[0].g, 402, 'the scribble is the note’s');
  assert.deepEqual(cards(page), before, 'every scrap where it was');
});

test("the board's drawing reaching into the next column is fitted to its one column, and no scrap after it lies over its card, at every width", async () => {
  const { view } = await pageOf(10),
    { page } = view;
  for (const width of [widthFor(1) + 16, WIDTH, widthFor(3) + 16]) {
    layUnits(view, width);
    const card = placeOf(page, 1000);
    assert.ok(page.fits.get(1000).k < 1, `shown smaller to fit at ${width} px`);
    assert.equal(card.w, UNIT_W, 'never wider than a column');
    for (const id of [1001, 1002]) {
      const p = placeOf(page, id);
      assert.ok(
        p.y >= card.y + card.h || p.x >= card.x + card.w || p.x + p.w <= card.x,
        `scrap ${id} at ${p.x},${p.y} clear of the drawing's card at ${width} px`,
      );
    }
  }
});

test("an arrow from the board's drawing onto the scrap beside it is the scrap's, and moves no scrap", async () => {
  const { view } = await pageOf(11),
    { page } = view,
    [word, next] = [placeOf(page, 1100), placeOf(page, 1101)],
    before = cards(page);
  assert.ok(next.x > word.x + word.w, 'the scrap beside the drawing');
  draw(view, [
    [
      [word.x + 100, word.y + 20],
      [next.x + 60, next.y + 30],
    ],
  ]);
  assert.equal(page.ink.at(-1).g, 1101, 'the arrow is the scrap’s');
  assert.deepEqual(cards(page), before, 'every scrap where it was');
});

// "QUAK" as the board writes it, a letter a stroke, its top-left at x, y on the page
const quak = (x, y) =>
  [0, 1, 2, 3].map(k => [
    [x + 24 * k, y],
    [x + 24 * k + 16, y + 24],
    [x + 24 * k, y + 30],
  ]);

test("a word written in the empty frame of the board's drawing stays apart from it; by its ink, it joins it", async () => {
  const id = 12,
    shown = await pageOf(id),
    { view } = shown,
    { page } = view,
    duck = placeOf(page, id * 100),
    [cx, cy] = [duck.x + 150, duck.y + 130];
  // (in the middle of the outline, over 64 px from every line of it, the frame's box all round it)
  draw(view, quak(cx - 48, cy - 15));
  const word = page.ink.slice(-4).map(el => el.g);
  assert.ok(
    word.every(g => g !== id * 100),
    `QUAK isn't the duck's: ${word}`,
  );
  assert.equal(new Set(word).size, 1, 'its letters are one drawing of their own');
  // (a word inside the outline by its left side, within 64 px of its ink)
  draw(view, quak(duck.x + 22, duck.y + 115));
  assert.ok(
    page.ink.slice(-4).every(el => el.g === id * 100),
    'written by the outline, it is the duck’s',
  );
  await save(shown);
  const kept = page.ink.filter(el => el.g === page.ink.at(-8).g);
  assert.equal(kept.length, 4, 'saved and read again, QUAK is still a unit of its own');
});

// A unit's card on the grid, given what's on it (scrap px): one drawing of the board's, its ink in lines
const PAPER = 16, // (the paper a card keeps round its ink: bookunits.js CARD_PAD)
  reach = boxOf(line([[0, 0]])).x1; // (how far a line's pen reaches past its points)
const cardFor = lines => {
  const page = {
    groups: new Map([[1, { id: 1, kind: 'drawing' }]]),
    ink: lines.map(points => ({ ...line(points), g: 1 })),
    scraps: [],
    texts: [],
  };
  return { card: cardOf(page, 1), page };
};

test("a scrap's card on the grid: as drawn while what's on it fits, the least tall when there's little", () => {
  const { card, page } = cardFor([
    [
      [40, 40],
      [200, 90],
    ],
  ]);
  assert.deepEqual(card, { h: 120, k: 1, x0: 0, y0: 0, plain: true }, 'a short drawing: the least card');
  assert.equal(heightOf(page, 1), 120, 'and the grid lays it that tall');
  const tall = cardFor([
    [
      [40, 40],
      [200, 300],
    ],
  ]).card;
  assert.deepEqual(
    tall,
    { h: 300 + reach + PAPER, k: 1, x0: 0, y0: 0, plain: true },
    'as tall as its ink and the paper round it',
  );
});

test("a scrap's card fitted: what's too tall shown smaller, centred across; what reaches up or left of its corner shown whole", () => {
  const tall = cardFor([
    [
      [40, 40],
      [200, 1200],
    ],
  ]).card;
  const h = 1200 + reach + PAPER;
  assert.ok(Math.abs(tall.k - (1.4 * UNIT_W) / h) < 1e-9, 'no taller than its most');
  assert.ok(Math.abs(tall.h - Math.ceil(1.4 * UNIT_W)) <= 1);
  assert.ok(tall.x0 < 0 && Math.abs(tall.x0 + (UNIT_W - UNIT_W * tall.k) / 2 / tall.k) < 1e-9, 'centred across');
  assert.equal(tall.plain, false);
  const out = cardFor([
    [
      [-60, -30],
      [100, 60],
    ],
  ]).card;
  assert.deepEqual(
    [out.x0, out.y0],
    [-60 - reach - PAPER, -30 - reach - PAPER],
    'from the ink above and left of its corner',
  );
  assert.ok(out.k < 1 && Math.abs((UNIT_W - out.x0) * out.k - UNIT_W) < 1e-9, 'shown as wide as the column');
});
