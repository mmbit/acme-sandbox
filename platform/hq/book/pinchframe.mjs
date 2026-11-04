// book-check.mjs's story of the pinch on the book's frame (README, The book's frame): only the page pinch-zooms. On
// journal.mjs's My journal on a phone by finger (390 × 844, a home-screen app's blur at the top) and on an iPad mini
// on its side, at every point of the screen over the book, the islands, the gaps in and round them and each card they
// open (the pen's colours, the dots menu, the preferences and the pages' list), the touch-action the browser goes by
// leaves the screen's own zoom out: a pinch there can't zoom the controls off the screen. Beside the book on the iPad,
// HQ's own page still pinch-zooms as it did.
import assert from 'node:assert/strict';
import { MINI, PREFERENCES, until } from './kit.mjs';
import { CALLS, landed, onJournal } from './journal.mjs';
import { PHONE, sat } from './titletap.mjs';

// the points looked at, this many px apart across the screen
const STEP_PX = 3;

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function pinchFrameStories(c) {
  const finger = { hasTouch: true, isMobile: true, pen: false };
  return {
    'a pinch on the islands or their cards never zooms the screen, on a phone': browser =>
      onJournal(
        browser,
        c,
        { viewport: PHONE, name: 'phone', options: finger, story: 'pinch', init: sat },
        (p, { press }) => walk(p, c, 'phone', press),
      ),
    'a pinch on the islands or their cards never zooms the screen, HQ beside the book still does, on an iPad mini':
      browser =>
        onJournal(browser, c, { viewport: MINI, name: 'mini', options: finger, story: 'pinch' }, (p, { press }) =>
          walk(p, c, 'mini', press, true),
        ),
  };
}

async function walk(p, c, name, press, beside = false) {
  const keys = p.locator('#book .bk-controls');
  await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
  await noPinch(p, `${name}: the book at rest`);
  if (beside) assert.ok((await pinched(p)).hq > 0, `${name}: HQ's page beside the book still pinch-zooms`);
  // the pen's colours (the pen picked, then pressed again)
  const pen = keys.getByRole('button', { name: 'Pen', exact: true });
  await until(async () => (await p.locator('#book .bk-palette').count()) || (await press(pen), false), 'the colours');
  await noPinch(p, `${name}: the pen's colours open`);
  await c.shot(`pinch-${name}-colours`, p);
  await p.keyboard.press('Escape');
  await p.locator('#book .bk-palette').waitFor({ state: 'detached' });
  // the dots menu, then the preferences from it
  await press(p.locator('#book .bk-more'));
  await p.locator('#book .bk-more-card').waitFor();
  await noPinch(p, `${name}: the dots menu open`);
  await c.shot(`pinch-${name}-menu`, p);
  await press(p.locator('#book .bk-more-card').getByRole('menuitem', { name: PREFERENCES, exact: true }));
  await p.locator('#book .bk-prefs').waitFor();
  await noPinch(p, `${name}: the preferences open`);
  await p.keyboard.press('Escape');
  await p.locator('#book .bk-prefs').waitFor({ state: 'detached' });
  // the pages' list, from the page count
  await press(p.locator('#book .bk-where'));
  await p.locator('#book .bk-pages-menu').waitFor();
  await noPinch(p, `${name}: the pages' list open`);
  await c.shot(`pinch-${name}-pages`, p);
}

// Nothing of the book's under any point lets the browser pinch-zoom the screen
async function noPinch(p, what) {
  const { book, zooms } = await pinched(p);
  assert.ok(book > 1000, `${what}: the book under the points (${book})`);
  assert.deepEqual(zooms, [], `${what}: a pinch here zooms the screen`);
}

// Every point of the screen, STEP_PX apart: how many are the book's (book) and HQ's own page's that a pinch zooms (hq),
// and the book's parts a pinch zooms the screen on (zooms: each one's classes and a point on it)
const pinched = p =>
  p.evaluate(step => {
    // The touch-action WebKit goes by at an element, as its style resolver works it out (StyleAdjuster's
    // computeEffectiveTouchActions): its own, met with its parent's, back to auto at an element that scrolls. Stricter
    // than Chromium, which meets a pinch's with every parent's up to the page.
    const memo = new Map();
    const effective = el => {
      if (!el) return new Set(['auto']);
      if (memo.has(el)) return memo.get(el);
      const style = getComputedStyle(el),
        scrolls = [style.overflowX, style.overflowY].some(o => o === 'auto' || o === 'scroll'),
        from = scrolls ? new Set(['auto']) : effective(el.parentElement),
        own = new Set(style.touchAction.split(' ')),
        loose = s => s.has('auto') || s.has('manipulation');
      let is;
      if (own.has('auto')) is = from;
      else if (from.has('none')) is = new Set(['none']);
      else if (loose(from)) is = own;
      else if (loose(own)) is = from;
      else is = new Set([...from].filter(a => own.has(a)));
      if (!is.size) is = new Set(['none']);
      memo.set(el, is);
      return is;
    };
    const zoomsAt = el => ['auto', 'manipulation', 'pinch-zoom'].some(a => effective(el).has(a));
    const book = document.getElementById('book'),
      zooms = new Map();
    let mine = 0,
      hq = 0;
    for (let y = 1; y < innerHeight; y += step)
      for (let x = 1; x < innerWidth; x += step) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (!book.contains(el)) {
          hq += zoomsAt(el);
          continue;
        }
        mine++;
        if (zoomsAt(el) && !zooms.has(el))
          zooms.set(el, `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} at ${x},${y}`);
      }
    return { book: mine, hq, zooms: [...zooms.values()] };
  }, STEP_PX);
