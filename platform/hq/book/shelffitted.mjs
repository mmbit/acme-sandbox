// book-check.mjs's story of My shelf in each HQ look (shell/ink/bookshelf.js, bookshelfbooks.js, bookshelfwindow.css
// and the renderers' skin.css), on the board's own shelf (My journal, one notebook archived):
// - whole from its first frame: opened again on a slow store, its window stands at its full height in its first frame,
//   its boards there, and its things arrive on them;
// - arranged by hand: the plant on the Archive's box's board, after it; the Archive has no plant;
// - straight on: every thing standing on its board, clear of the others;
// Pictures at the iPad mini both ways and a phone, in Slate light and dark, Holo and Brownstone, for the eye: the wood's
// tint, the lettering, My journal's black cover and Brownstone's pixel shelf.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../../shared/browser/browser.mjs';
import { MINI, UPRIGHT, openShelf, shelfAtRest, shelfKey } from './kit.mjs';
import { shelfSeen, standing } from './myshelf.mjs';

const PHONE = { width: 390, height: 844 };
// the store's answer held back this long on the slow open
const SLOW_MS = 4000;
// the looks: their renderer and colour scheme
const LOOKS = [
  { label: 'slate', renderer: 'wire', scheme: 'light' },
  { label: 'slate-dark', renderer: 'wire', scheme: 'dark' },
  { label: 'holo', renderer: 'holo', scheme: 'dark' },
  { label: 'brownstone', renderer: 'brownstone', scheme: 'light' },
];
const SIZES = [
  ['mini-sideways', MINI],
  ['mini-upright', UPRIGHT],
  ['phone', PHONE],
];

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport, more), shot, settle }
export function shelfFittedStories(c) {
  return {
    "My shelf fitted: whole from its first frame on a slow store, the plant after the Archive's box and not in the Archive, things standing on their boards in every look at the iPad mini both ways and a phone":
      async browser => {
        for (const look of LOOKS)
          for (const [size, viewport] of SIZES) await fittedAt(browser, c, look, size, viewport);
        await wholeAtOnce(browser, c);
      },
  };
}

async function fittedAt(browser, c, look, size, viewport) {
  const label = `${look.label} ${size}`,
    touch = viewport.width < 800;
  const context = await c.hqIn(browser, viewport, {
    notebooks: boardsShelf(),
    hasTouch: touch,
    isMobile: touch,
    colorScheme: look.scheme,
  });
  const page = await context.newPage(),
    errors = errorsOf(page);
  try {
    const shelf = await openShelf(page, c, look.renderer);
    const seen = await shelfSeen(page);
    standing(seen, label);
    const [journal, box, plant] = seen.things;
    assert.deepEqual(
      seen.things.map(t => t.what),
      ['book 1', "the Archive's box", 'the plant'],
      `${label}: My journal, the box and the plant`,
    );
    assert.equal(plant.row, box.row, `${label}: the plant on the box's board`);
    assert.ok(box.right <= plant.left, `${label}: the plant after the box ${JSON.stringify(seen)}`);
    assert.ok(journal.right <= box.left, `${label}: the box after My journal`);
    await c.shot(`fitted-${look.label}-${size}`, page);
    // (the Archive: its box opened, no plant there)
    await shelf.getByRole('button', { name: /^The Archive:/ }).click();
    await until(page, '#book .bk-shelf-window .bk-far-up[data-tab=shelf]');
    await shelfAtRest(page);
    assert.equal(await shelf.locator('.bk-shelf-plant').count(), 0, `${label}: no plant in the Archive`);
    standing(await shelfSeen(page), `${label} Archive`);
    if (size === 'mini-sideways') await c.shot(`fitted-${look.label}-${size}-archive`, page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// Opened once and put away, then HQ again with the store's answer held back: the Shelf's first frame is the bookcase at
// its full height, its boards there and empty, and the books arrive on them with the window's height unchanged
async function wholeAtOnce(browser, c) {
  const context = await c.hqIn(browser, MINI, { notebooks: boardsShelf() });
  const page = await context.newPage(),
    errors = errorsOf(page);
  try {
    const shelf = await openShelf(page, c);
    const whole = await sizeOf(page);
    await shelf.getByRole('button', { name: 'Close the Shelf' }).click();
    await shelf.waitFor({ state: 'hidden' });
    let slow = true;
    await context.route('**/api/notebooks', async r => {
      if (slow) await new Promise(res => setTimeout(res, SLOW_MS));
      return r.fallback();
    });
    await page.reload();
    await until(page, '#loading.gone');
    const key = await shelfKey(page);
    // (frames watched before the tap, so the window is measured in the first one it's open in)
    const firstFrame = sizeOf(page);
    await key.click();
    const atFirst = await firstFrame;
    await c.shot('fitted-first-frame', page);
    assert.equal(atFirst.books, 0, 'the store not answered yet: no books on the boards');
    assert.deepEqual(
      { height: atFirst.height, rows: atFirst.rows },
      { height: whole.height, rows: whole.rows },
      'the Shelf at its full height, its boards there, from its first frame',
    );
    slow = false;
    await page.waitForFunction(() => document.querySelectorAll('#book .bk-shelf-window .bk-book').length > 0);
    assert.equal((await sizeOf(page)).height, whole.height, 'the books arrive in place, the window not growing');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// The Shelf's window as it stands in the first frame it's open (now, if it is): its height, boards and books
const sizeOf = page =>
  page.evaluate(
    () =>
      new Promise(res => {
        const frame = () => {
          const d = document.querySelector('#book .bk-shelf-window');
          if (!d?.open) return requestAnimationFrame(frame);
          res({
            height: d.offsetHeight, // (its own, not its rise's scale)
            rows: d.querySelectorAll('.bk-shelf-row').length,
            books: d.querySelectorAll('.bk-book').length,
          });
        };
        frame();
      }),
  );

// The board's own shelf on its call: My journal (its own lighthouse cover, all read) and one notebook archived
function boardsShelf() {
  const now = Date.now(),
    at = ms => new Date(ms).toISOString(),
    book = (id, kind, name, more) => ({ id, kind, name, created: at(now - 9e8), updated: at(now - 4e6), ...more });
  return {
    notebooks: [
      book(1, 'mine', 'My journal', { asks: { open: 0, all: 1 } }),
      book(2, 'project', 'Ink vision', { archived: true }),
    ],
    pages: [{ id: 1, notebook: 1, pos: 0, created: at(now - 9e8), updated: at(now - 4e6), w: 1200, h: 1600 }],
  };
}
