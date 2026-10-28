// book-check.mjs's story of the Notebook's pages row (shell/ink/bookcontrols.js, bookdesk.css) on the played Notebook
// seeded as dev mode's (booknotebook.mjs open).
import assert from 'node:assert/strict';
import { open } from './booknotebook.mjs';

const MINI = { width: 1133, height: 744 };

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function notebookRowStories(c) {
  return {
    "the Notebook's pages row on an iPad mini on its side and upright: inside its island, the page's name showing":
      browser => pagesRow(browser, c),
  };
}

// The pages row (overview, before, the page's name, after, New page, Send) inside its island, with the page's name
// showing, on an iPad mini both ways (upright, the book folded first)
async function pagesRow(browser, c) {
  for (const [viewport, folded] of [
    [MINI, false],
    [{ width: MINI.height, height: MINI.width }, true],
  ]) {
    const { page, errors, done } = await open(browser, c, viewport, { hasTouch: true, folded });
    try {
      const row = await page.evaluate(() => {
        const island = document.querySelector("#book .bk-island[data-island='pages']"),
          r = island.getBoundingClientRect(),
          name = island.querySelector('.bk-where span').getBoundingClientRect();
        const out = [...island.children]
          .filter(el => el.offsetWidth)
          .map(el => el.getBoundingClientRect())
          .filter(b => b.left < r.left - 0.5 || b.right > r.right + 0.5);
        return { width: Math.round(r.width), name: Math.round(name.width), out: out.length };
      });
      assert.equal(row.out, 0, `the pages row inside its island: ${JSON.stringify(row)}`);
      // (upright, the book is 318 px: the name keeps a few letters and its ellipsis, never squeezed to nothing)
      assert.ok(row.name >= 24, `the page's name shows: ${JSON.stringify(row)}`);
      await c.shot(`notebook-row-${viewport.width}`, page);
      c.noErrorsIn(errors);
    } finally {
      await done();
    }
  }
}
