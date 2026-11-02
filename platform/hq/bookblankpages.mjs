// book-check.mjs's story of the blank pages left behind (shell/ink/booktidy.js), on the played Notebook seeded as dev
// mode's (mock/notebook.json): on an iPad mini with touch, on its side and upright, and on a desktop, New page tapped
// twice leaves the book one page longer, and that page, left blank for the page before, goes: the notebook is as it
// was, no blank page in it, and nothing archived.
import assert from 'node:assert/strict';
import { open } from './booknotebook.mjs';
import { where } from './booknotebookscreen.mjs';
import { DESKTOP, MINI, UPRIGHT, until } from './bookkit.mjs';

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function blankPagesStories(c) {
  return {
    'no blank page left behind, on an iPad mini: New page twice makes one, and it goes once it is left, both ways':
      async browser => {
        await leftBlank(browser, c, MINI, 'mini', { hasTouch: true });
        await leftBlank(browser, c, UPRIGHT, 'mini-upright', { hasTouch: true, folded: true });
      },
    'no blank page left behind, on a desktop: New page twice makes one, and it goes once it is left': browser =>
      leftBlank(browser, c, DESKTOP, 'desktop', { deviceScaleFactor: 1 }),
  };
}

async function leftBlank(browser, c, viewport, name, options) {
  const { page, play, errors, done } = await open(browser, c, viewport, options);
  try {
    const before = stored(play);
    assert.equal(blanks(before).length, 0, 'the seed has no blank page');
    await newPage(page);
    await until(
      async () => (await at(page)).join('/') === `${before.pages.length + 1}/${before.pages.length + 1}`,
      'the new page',
    );
    const first = stored(play).pages.find(p => !ids(before.pages).includes(p.id)).id;
    await newPage(page);
    await until(() => !stored(play).pages.some(p => p.id === first), 'the first new page gone once the second shows');
    const twice = stored(play);
    assert.equal(twice.pages.length, before.pages.length + 1, 'New page twice: the book one page longer');
    assert.equal(blanks(twice).length, 1, 'the page shown its one blank page');
    await until(async () => (await at(page))[1] === twice.pages.length, 'the rail counting it');
    await c.shot(`blank-${name}-new`, page);
    await page.locator('#book').getByRole('button', { name: 'The page before' }).dispatchEvent('click');
    await until(() => stored(play).pages.length === before.pages.length, 'the blank page gone once it is left');
    const after = stored(play);
    assert.deepEqual(ids(after.pages), ids(before.pages), "the notebook's pages as they were");
    assert.deepEqual(ids(after.archived), ids(before.archived), 'nothing archived');
    await until(async () => (await at(page)).join('/') === `${after.pages.length}/${after.pages.length}`, 'the rail');
    await c.shot(`blank-${name}-left`, page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// New page, by a click dispatched on the rail's button: one More has folded away too, and the rail re-fits late on
// WebKit
const newPage = page => page.locator('#book .bk-column .bk-btn[aria-label="New page"]').dispatchEvent('click');
// My journal's pages as the played store has them
const stored = play => play.route('/api/notebooks/pages', { notebook: 1 });
const blanks = read => read.pages.filter(p => p.kind === 'free' && !p.title && !p.groups);
const ids = pages => pages.map(p => p.id);
// The page shown and the notebook's page count, as the rail reads them ("2/3")
const at = page =>
  until(async () => {
    const m = /(\d+)\/(\d+)$/.exec(await where(page));
    return m && [Number(m[1]), Number(m[2])];
  }, "the rail's page");
