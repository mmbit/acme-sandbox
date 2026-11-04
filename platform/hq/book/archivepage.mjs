// book-check.mjs's story of a page archived from its own dots menu (shell/ink/bookui.js, bookshelf.js), on
// journal.mjs's My journal (two sketch pages, its Asks page, twenty calls' notes pages), the book open on Calls'
// page 20: on an iPad mini with touch, on its side and upright, and on a desktop, the dots menu's Archive this page
// opens All pages at once and crumples the page's tile up there, dropping it as a deleted thing does (bookpaper.js),
// the tile gone from the grid and the page archived in the store; Undo brings it back. Archived again, the overview's
// key goes back to Calls' page 19, not the notebook's first page; Sketch's last page archived, to Sketch's page before
// it, not Asks. Sketch is picked by its bookmark, two taps upright.
import assert from 'node:assert/strict';
import { DESKTOP, LOADED_MS, MINI, OVERVIEW, UPRIGHT, crumpled, fellAway, until } from './kit.mjs';
import { CALLS, landed, onJournal } from './journal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function archivePageStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    'a page archived from its dots menu crumples away in All pages, on an iPad mini on its side: back with Undo, the book on the page before':
      browser => archived(browser, c, MINI, 'mini', touch),
    'a page archived from its dots menu crumples away in All pages, on an iPad mini upright: back with Undo, the book on the page before':
      browser => archived(browser, c, UPRIGHT, 'mini-upright', touch),
    'a page archived from its dots menu crumples away in All pages, on a desktop: back with Undo, the book on the page before':
      browser => archived(browser, c, DESKTOP, 'desktop', mouse),
  };
}

// (Calls' last page, the one the book opens on; Sketch's last, Shop page)
const CALLS_LAST = 3 + CALLS,
  SKETCH_LAST = 2;

const archived = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'archive' }, async (p, { press, play, tab }) => {
    const far = p.getByRole('list', { name: 'The overview' }),
      tileOf = id => far.locator(`.bk-far-chapter .bk-tile[data-id="${id}"]`),
      last = tileOf(CALLS_LAST),
      overview = () => p.locator(`#book .bk-bar .bk-btn[aria-label="${OVERVIEW}"]`).dispatchEvent('click');
    // the page shown archived from the dots menu: All pages opens, and its tile there crumples and falls away, gone
    // from the grid (undo: Undo pressed as it's offered)
    const archive = async (what, { undo = false, tile = last } = {}) => {
      const fall = crumpled(p),
        undone = undo && undoneAsTold(p);
      fall.catch(() => {}); // (a failure below shows first; awaiting it later still throws)
      await press(p.locator('#book .bk-more'));
      await press(p.locator('#book .bk-more-card').getByRole('menuitem', { name: 'Archive this page', exact: true }));
      await far.waitFor({ timeout: LOADED_MS });
      const gone = `${name}: ${what}: its tile gone from the grid`;
      if (undo)
        assert.deepEqual(await undone, { gone: true, words: 'Page archived.', over: null }, `${gone}, Undo uncovered`);
      else await until(async () => !(await tile.count()), gone, LOADED_MS);
      fellAway(await fall, `${name}: ${what}`);
    };
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
    await archive('archived', { undo: true });
    await until(async () => !isArchived(play) && (await last.count()) === 1, `${name}: Undo brings it back`);
    // (its tile tapped: the page again)
    await until(async () => (await p.locator('#book .bk-turn-leaf').count()) === 0, `${name}: the leaf landed`);
    await press(last.locator('.bk-tile-open'));
    await far.waitFor({ state: 'hidden', timeout: LOADED_MS });
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: Calls' last page again`);
    await archive('archived again');
    await until(() => isArchived(play), `${name}: archived in the store`);
    await c.shot(`archive-${name}`, p);
    await overview();
    const before = `${CALLS - 1} / ${CALLS - 1}`;
    await landed(p, 'calls', `Call ${CALLS - 1}`, before, `${name}: the book on the page before`);
    // (Sketch's last page archived: the book stays in Sketch, on the page before, not on Asks after it)
    await tab('sketch');
    await press(p.locator('#book .bk-btn[aria-label="The page after"]'));
    await landed(p, 'sketch', 'Shop page', '2 / 2', `${name}: Sketch's last page`);
    await archive("Sketch's last archived", { tile: tileOf(SKETCH_LAST) });
    await overview();
    await landed(p, 'sketch', 'Ideas', '1 / 1', `${name}: the book still in Sketch, on the page before`);
  });
// The overview's Undo pressed in the page once it's offered: whether the page's tile was gone then, Undo's words, and
// what's over it (null: nothing), watched for from before All pages opens. It lasts six seconds, which a busy
// browser's round trips can outlast.
const undoneAsTold = p =>
  p.evaluate(
    last =>
      new Promise(done => {
        new MutationObserver((_, watching) => {
          const told = document.querySelector('#book .bk-told:not([hidden])');
          if (!told) return;
          watching.disconnect();
          const undo = told.querySelector('button'),
            r = undo.getBoundingClientRect(),
            at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
            seen = {
              gone: !document.querySelector(`#book .bk-far-chapter .bk-tile[data-id="${last}"]`),
              words: told.querySelector('span').textContent,
              over: undo.contains(at) ? null : (at?.outerHTML.slice(0, 80) ?? 'nothing'),
            };
          // (after the crumple, as a hand would: the archive's own request out first)
          setTimeout(() => (undo.click(), done(seen)), 400);
        }).observe(document.querySelector('#book'), { subtree: true, childList: true, attributeFilter: ['hidden'] });
      }),
    CALLS_LAST,
  );
// Whether Calls' last page is archived, as the played store has it
const isArchived = play =>
  play.route('/api/notebooks/pages', { notebook: 1 }).archived.some(page => page.id === CALLS_LAST);
