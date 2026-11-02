// book-check.mjs's story of a page archived from the overview (shell/ink/bookshelf.js), on bookjournal.mjs's My
// journal (two sketch pages, its Asks page, twenty calls' notes pages), the book open on Calls' page 20: on an iPad
// mini with touch, on its side and upright, and on a desktop, the page's archive box crumples its tile up and drops
// it off as a deleted thing does (bookpaper.js), the tile gone from the grid at once and the page archived in the
// store; Undo brings it back. Archived again, the book behind shows Calls' page 19, not the notebook's first page;
// Sketch's last page archived, Sketch's page before it, not Asks.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, OVERVIEW, UPRIGHT, crumpled, until } from './bookkit.mjs';
import { CALLS, LOADED_MS, landed, onJournal } from './bookjournal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function archivePageStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    'a page archived crumples away, on an iPad mini on its side: gone at once, back with Undo, the book on the page before':
      browser => archived(browser, c, MINI, 'mini', touch),
    'a page archived crumples away, on an iPad mini upright: gone at once, back with Undo, the book on the page before':
      browser => archived(browser, c, UPRIGHT, 'mini-upright', touch),
    'a page archived crumples away, on a desktop: gone at once, back with Undo, the book on the page before': browser =>
      archived(browser, c, DESKTOP, 'desktop', mouse),
  };
}

// (Calls' last page, the one the book opens on; Sketch's last, Shop page)
const CALLS_LAST = 3 + CALLS,
  SKETCH_LAST = 2;

const archived = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'archive' }, async (p, { press, play }) => {
    const far = p.getByRole('list', { name: 'The overview' }),
      tileOf = id => far.locator(`.bk-far-chapter .bk-tile[data-id="${id}"]`),
      last = tileOf(CALLS_LAST),
      overview = () => p.locator(`#book .bk-column .bk-btn[aria-label="${OVERVIEW}"]`).dispatchEvent('click');
    // the page's archive box pressed: its tile crumples and drops off, gone from the grid at once (undo: Undo pressed
    // as it's offered)
    const archive = async (what, { undo = false, tile = last } = {}) => {
      const dropped = crumpled(p),
        undone = undo && undoneAsTold(p);
      dropped.catch(() => {}); // (a failure below shows first; awaiting it later still throws)
      await press(tile.locator('.bk-tile-act'));
      const told = undo ? await undone : { gone: !(await tile.count()) };
      assert.ok(told.gone, `${name}: ${what}: its tile gone from the grid at once`);
      if (undo) assert.deepEqual(told, { gone: true, words: 'Page archived.', over: null }, `${name}: Undo, uncovered`);
      const { picture, down, aside, shown } = await dropped;
      assert.ok(
        picture && down > 40 && aside < 2,
        `${name}: ${what}: crumpled and dropped (${down} down, ${aside} aside)`,
      );
      assert.ok(shown > 0.4, `${name}: ${what}: still shown as it drops (${shown})`);
    };
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS}/${CALLS}`, `${name}: the book opens on Calls' last page`);
    await overview();
    await last.waitFor({ timeout: LOADED_MS });
    await until(async () => (await p.locator('#book .bk-turn-leaf').count()) === 0, `${name}: the leaf landed`);
    await archive('archived', { undo: true });
    await until(async () => !isArchived(play) && (await last.count()) === 1, `${name}: Undo brings it back`);
    await archive('archived again');
    await until(() => isArchived(play), `${name}: archived in the store`);
    await c.shot(`archive-${name}`, p);
    await overview();
    await landed(p, 'calls', `Call ${CALLS - 1}`, `${CALLS - 1}/${CALLS - 1}`, `${name}: the book on the page before`);
    // (Sketch's last page archived: the book stays in Sketch, on the page before, not on Asks after it.)
    await press(p.locator('#book .bk-marks [data-chapter=sketch]'));
    await press(p.locator('#book .bk-btn[aria-label="The page after"]'));
    await landed(p, 'sketch', 'Shop page', '2/2', `${name}: Sketch's last page`);
    await overview();
    await tileOf(SKETCH_LAST).waitFor({ timeout: LOADED_MS });
    await until(async () => (await p.locator('#book .bk-turn-leaf').count()) === 0, `${name}: the leaf landed again`);
    await archive("Sketch's last archived", { tile: tileOf(SKETCH_LAST) });
    await overview();
    await landed(p, 'sketch', 'Ideas', '1/1', `${name}: the book still in Sketch, on the page before`);
  });
// The overview's Undo pressed in the page once it's offered: whether the page's tile was gone then, Undo's words, and
// what's over it (null: nothing). It lasts six seconds, which a busy browser's round trips can outlast.
const undoneAsTold = p =>
  p.evaluate(
    last =>
      new Promise(done => {
        const told = document.querySelector('#book .bk-told');
        new MutationObserver((_, watching) => {
          if (told.hidden) return;
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
        }).observe(told, { attributes: true, attributeFilter: ['hidden'] });
      }),
    CALLS_LAST,
  );
// Whether Calls' last page is archived, as the played store has it
const isArchived = play =>
  play.route('/api/notebooks/pages', { notebook: 1 }).archived.some(page => page.id === CALLS_LAST);
