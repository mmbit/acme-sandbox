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
globalThis.document = { addEventListener: () => {}, dispatchEvent: () => {}, createElement: element };
globalThis.location = { hostname: '', search: '', pathname: '/' };
// (dev mode's store, notebookplay.js, seeded with the pages below: each test draws on one of its own)
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SEED });
const { inkUnit, layUnits } = await import('./bookunits.js');
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
const SEED = {
  notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: NOW, updated: NOW }],
  pages: Object.keys(PAGES).map((id, k) => ({ id: Number(id), notebook: 1, pos: k, created: NOW, updated: NOW })),
  groups: Object.entries(PAGES).flatMap(([page, drawings]) =>
    drawings.map((d, k) => ({
      id: Number(page) * 100 + k,
      page: Number(page),
      kind: 'drawing',
      ink: d.ink.map(line),
      pos: k,
      h: 0,
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
