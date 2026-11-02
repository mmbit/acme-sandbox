// book-check.mjs's story of the overview split as the book is (shell/ink/bookshelftiles.js), on bookjournal.mjs's My
// journal (two sketch pages, its Asks page, twenty calls' notes pages): on an iPad mini with touch, on its side and
// upright, and on a desktop, the overview shows Sketch, Asks and Calls in the book's order, each page under its own
// chapter's tab and Calls' lit (the book opens on its page 20); a call's page opened from it lands on that page in
// Calls, and a sketch's in Sketch.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, OVERVIEW, UPRIGHT, until } from './bookkit.mjs';
import { CALLS, LOADED_MS, landed, onJournal } from './bookjournal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function overviewSplitStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    'the overview is split as the book is, on an iPad mini on its side: Sketch, Asks and Calls, a page opened in its tab':
      browser => split(browser, c, MINI, 'mini', touch),
    'the overview is split as the book is, on an iPad mini upright: Sketch, Asks and Calls, a page opened in its tab':
      browser => split(browser, c, UPRIGHT, 'mini-upright', touch),
    'the overview is split as the book is, on a desktop: Sketch, Asks and Calls, a page opened in its tab': browser =>
      split(browser, c, DESKTOP, 'desktop', mouse),
  };
}

const CALL_TITLES = Array.from({ length: CALLS }, (_, i) => `Call ${i + 1}`);

const split = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'overview' }, async (p, { press }) => {
    const far = p.getByRole('list', { name: 'The overview' }),
      overview = () => opensOverview(p, far, name);
    // a page's tile in a chapter tapped, the overview gone
    const open = async (chapter, title) => {
      await press(far.locator(`[data-chapter=${chapter}] .bk-tile-open[aria-label="${title}"]`));
      await far.waitFor({ state: 'hidden', timeout: LOADED_MS });
    };
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS}/${CALLS}`, `${name}: the book opens on Calls' last page`);
    await overview();
    assert.deepEqual(
      await chapters(p),
      [
        { tab: 'Sketch', lit: false, pages: ['Ideas', 'Shop page'] },
        { tab: 'Asks', lit: false, pages: ['Asks'] },
        { tab: 'Calls', lit: true, pages: CALL_TITLES },
      ],
      `${name}: the overview's chapters in the book's order, each page under its own, Calls lit`,
    );
    assert.equal(await far.locator('[data-chapter=sketch] [data-new]').count(), 1, `${name}: New page ends Sketch`);
    await c.shot(`overview-${name}`, p);
    await open('calls', 'Call 5');
    await landed(p, 'calls', 'Call 5', `5/${CALLS}`, `${name}: Call 5 opened from the overview, in Calls`);
    await overview();
    await open('sketch', 'Shop page');
    await landed(p, 'sketch', 'Shop page', '2/2', `${name}: Shop page opened from the overview, in Sketch`);
  });

// The overview opened from its button (clicked where it is, on the rail or folded into More: the rail's own stories
// press it there), its chapters drawn and the leaf turned to it landed (while it turns, it carries a copy of the
// paper, the overview's too)
async function opensOverview(p, far, name) {
  await p.locator(`#book .bk-column .bk-btn[aria-label="${OVERVIEW}"]`).dispatchEvent('click');
  await until(() => far.locator('.bk-far-chapter .bk-tile[data-id]').count(), `${name}: the overview's pages`);
  await until(async () => (await p.locator('#book .bk-turn-leaf').count()) === 0, `${name}: the leaf landed`);
}
// The overview's chapters as drawn: each tab's name, whether it's lit, and its pages' titles in order
const chapters = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-pages > .bk-far .bk-far-chapter')].map(ch => ({
      tab: ch.querySelector('.bk-mk-tab').textContent,
      lit: ch.querySelector('.bk-mk-tab').getAttribute('aria-current') === 'page',
      pages: [...ch.querySelectorAll('.bk-tile[data-id] .bk-tile-open')].map(b => b.getAttribute('aria-label')),
    })),
  );
