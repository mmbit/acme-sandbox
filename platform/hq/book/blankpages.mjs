// book-check.mjs's story of the blank pages left behind (shell/ink/booktidy.js), on the played Notebook seeded as dev
// mode's (mock/notebook.json): on an iPad mini with touch, on its side and upright, and on a desktop, New page tapped
// twice leaves the book one page longer, and that page, left blank for the page before, goes: the notebook is as it
// was, no blank page in it, and nothing archived, as the bar's count reads it.
import assert from 'node:assert/strict';
import { open } from './notebook.mjs';
import { pageAt } from './notebookscreen.mjs';
import { DESKTOP, MINI, UPRIGHT, until } from './kit.mjs';

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
    await until(async () => (await at(page))[1] === twice.pages.length, 'the bar counting it');
    await c.shot(`blank-${name}-new`, page);
    await page.locator('#book').getByRole('button', { name: 'The page before' }).dispatchEvent('click');
    await until(() => stored(play).pages.length === before.pages.length, 'the blank page gone once it is left');
    const after = stored(play);
    assert.deepEqual(ids(after.pages), ids(before.pages), "the notebook's pages as they were");
    assert.deepEqual(ids(after.archived), ids(before.archived), 'nothing archived');
    await until(async () => (await at(page)).join('/') === `${after.pages.length}/${after.pages.length}`, 'the bar');
    await c.shot(`blank-${name}-left`, page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// New page, by a click dispatched on the bar's key: on a narrow page the dots menu has it (the bar's own stories press
// it there)
const newPage = page => page.locator('#book .bk-bar .bk-btn[aria-label="New page"]').dispatchEvent('click');
// My journal's pages as the played store has them
const stored = play => play.route('/api/notebooks/pages', { notebook: 1 });
const blanks = read => read.pages.filter(p => p.kind === 'free' && !p.title && !p.groups);
const ids = pages => pages.map(p => p.id);
// The page shown and its chapter's page count, as the bar reads them ("2 / 3": [2, 3])
const at = page => until(() => pageAt(page), "the bar's page");
