// book-check.mjs's story of each of the book's tabs keeping its page (shell/ink/bookmarks.js), on My journal seeded
// with two sketch pages, its Asks page and twenty calls' notes pages: on an iPad mini with touch, on its side and
// upright (where a pick is two taps: the folded bookmarks brought out, then one picked), and on a desktop, the book
// opens on Calls' page 20; Sketch turned on to its page 2, Asks, then Calls is page 20 again, and Sketch page 2.
import { DESKTOP, MINI, UPRIGHT } from './bookkit.mjs';
import { CALLS, landed, onJournal } from './bookjournal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function tabPagesStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    "each of the book's tabs keeps its page, on an iPad mini on its side: Calls on page 20, Sketch, Asks, then Calls on page 20 again":
      browser => kept(browser, c, MINI, 'mini', touch),
    "each of the book's tabs keeps its page, on an iPad mini upright: Calls on page 20, Sketch, Asks, then Calls on page 20 again":
      browser => kept(browser, c, UPRIGHT, 'mini-upright', touch),
    "each of the book's tabs keeps its page, on a desktop: Calls on page 20, Sketch, Asks, then Calls on page 20 again":
      browser => kept(browser, c, DESKTOP, 'desktop', mouse),
  };
}

const kept = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'tabpages' }, async (p, { press, tab: pick }) => {
    // a tab picked, and the page it lands on as the bar's count and the bookmarks read it
    const tab = async (chapter, title, where) => {
      await pick(chapter);
      await landed(p, chapter, title, where, `${name}: ${chapter} on ${title}`);
    };
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
    await tab('sketch', 'Ideas', '1 / 2');
    await press(p.locator('#book .bk-btn[aria-label="The page after"]'));
    await landed(p, 'sketch', 'Shop page', '2 / 2', `${name}: Sketch turned on to its page 2`);
    await tab('asks', 'Asks', '1 / 1');
    await tab('calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`);
    await c.shot(`tabpages-${name}-calls`, p);
    await tab('sketch', 'Shop page', '2 / 2');
    await tab('asks', 'Asks', '1 / 1');
  });
