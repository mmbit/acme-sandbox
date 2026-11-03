// book-check.mjs's story of the Notebook's pages row (shell/ink/bookcontrols.js, bookstrip.css) on the played Notebook
// seeded as dev mode's (notebook.mjs open): in the middle of the bar along the foot.
import assert from 'node:assert/strict';
import { open } from './notebook.mjs';
import { MINI, UPRIGHT } from './kit.mjs';

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots
export function notebookRowStories(c) {
  return {
    "the Notebook's pages row on an iPad mini on its side and upright: inside the bar, its count whole": browser =>
      pagesRow(browser, c),
  };
}

// The pages row (the page before, where it is, the page after) inside its island in the bar's middle, the bar on the
// screen, and its count ("2 / 3") whole, on an iPad mini both ways (upright, the book folded first)
async function pagesRow(browser, c) {
  for (const [viewport, folded] of [
    [MINI, false],
    [UPRIGHT, true],
  ]) {
    const { page, errors, done } = await open(browser, c, viewport, { hasTouch: true, folded });
    try {
      const row = await page.evaluate(() => {
        const box = el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          },
          inside = (a, b) =>
            a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5,
          island = document.querySelector("#book .bk-bar-middle .bk-island[data-island='pages']"),
          bar = document.querySelector('#book .bk-bar'),
          count = island.querySelector('.bk-where');
        return {
          keys: [...island.children].filter(el => el.offsetWidth).map(el => el.getAttribute('aria-label')),
          out: [...island.children].filter(el => el.offsetWidth && !inside(box(el), box(island))).length,
          onScreen: inside(box(bar), { left: 0, top: 0, right: innerWidth, bottom: innerHeight }),
          count: count.textContent,
          whole: count.scrollWidth <= count.clientWidth,
        };
      });
      assert.equal(row.keys.length, 3, `the page before, where it is and the page after: ${JSON.stringify(row)}`);
      assert.equal(row.out, 0, `the pages row inside its island: ${JSON.stringify(row)}`);
      assert.ok(row.onScreen, `the bar on the screen: ${JSON.stringify(row)}`);
      assert.match(row.count, /^\d+ \/ \d+$/, `the count reads "2 / 3": ${JSON.stringify(row)}`);
      assert.ok(row.whole, `the count whole: ${JSON.stringify(row)}`);
      await c.shot(`notebook-row-${viewport.width}`, page);
      c.noErrorsIn(errors);
    } finally {
      await done();
    }
  }
}
