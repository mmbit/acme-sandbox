// book-check.mjs's story of each page's zoom (shell/ink/bookpages.js keepZoom), on the played store with a mouse on a
// desktop: a page zoomed out is kept at it on the store, a new page opens at 100%, and the first opens at its zoom
// again after a turn and in a browser that remembers nothing, as on another desktop; its % back to 100% kept too. (the
// board's call 160)
import assert from 'node:assert/strict';
import { freePage, onDesk } from './bookmouse.mjs';
import { button } from './bookchrome.mjs';
import { until } from './bookkit.mjs';

// c: book-check.mjs's helpers: { hqIn, base, notebook (the played store) and pages (its mirror), settled }
export function zoomKeptStories(c) {
  return {
    'each page opens at the zoom it was left at, after a turn and in another browser; a new page at 100%': browser =>
      kept(browser, c),
  };
}

async function kept(browser, c) {
  const first = freePage(c);
  let { page, errors, done } = await onDesk(browser, c);
  try {
    const paper = await page.locator('#book .bk-desk').boundingBox();
    await page.mouse.move(paper.x + paper.width / 3, paper.y + paper.height / 2);
    await page.keyboard.press('Control+Minus');
    const left = await shows(page, p => parseInt(p) < 100, 'zoomed out');
    await keptAs(c, first.id, parseInt(left) / 100);
    const pages = await button(page, /^The notebook's pages/).getAttribute('aria-label');
    await button(page, 'New page', true).click();
    await page.waitForFunction(
      was => document.querySelector('#book .bk-where')?.getAttribute('aria-label') !== was,
      pages,
      { timeout: 30_000 },
    );
    await shows(page, p => p === '100%', 'a new page at 100%');
    await button(page, 'The page before').click();
    await shows(page, p => p === left, 'the first at its zoom after a turn');
    assert.deepEqual(errors, []);
    // (a browser with nothing of this one's: the book opens on the newest page, the new one)
    await done();
    ({ page, errors, done } = await onDesk(browser, c));
    await shows(page, p => p === '100%', 'the new page still at 100%');
    await button(page, 'The page before').click();
    await shows(page, p => p === left, 'the first at its zoom in another browser');
    await button(page, 'Back to 100%').click();
    await keptAs(c, first.id, 1);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// (the % at the foot shows only while the zoom is off 100%)
async function percent(page) {
  const chip = button(page, 'Back to 100%');
  return (await chip.isVisible()) ? (await chip.textContent()).trim() : '100%';
}
// The % shown once it's what's wanted, waited for (a loaded machine's frames come late): the % itself
function shows(page, wanted, what) {
  let shown;
  return until(
    async () => wanted((shown = await percent(page))) && shown,
    () => `${what}: ${shown}`,
  );
}
// The page's zooms on the played store, one per screen shape
const zoomsOf = (c, id) =>
  Object.values(c.notebook.route('/api/notebooks/pages', { notebook: 1 }).pages.find(p => p.id === id).zooms);
// The page's zoom on the played store, within a % of zoom, waited for (it's kept as the view rests)
function keptAs(c, id, zoom) {
  let zooms;
  return until(
    () => (zooms = zoomsOf(c, id)).some(z => Math.abs(z - zoom) < 0.01),
    () => `kept at ${zoom}: ${JSON.stringify(zooms)}`,
  );
}
