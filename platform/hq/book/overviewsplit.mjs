// book-check.mjs's story of the overview split as the book is (shell/ink/bookshelftiles.js), on journal.mjs's My
// journal (two sketch pages, its Asks page, twenty calls' notes pages): on a phone, on an iPad mini with touch, on its
// side and upright, and on a desktop, the overview shows Sketch, Asks and Calls in the book's order, each under a plain
// head with its count and each page under its own chapter, the page shown in Calls (the book opens on its page 20); a
// call's page opened from it lands on that page in Calls, and a sketch's in Sketch. Its options open from its title
// line and Esc shuts them.
// (company: job #19134 and job #19155, not upstream yet)
import assert from 'node:assert/strict';
import { DESKTOP, LOADED_MS, MINI, OVERVIEW, UPRIGHT, until } from './kit.mjs';
import { CALLS, landed, onJournal } from './journal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function overviewSplitStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    'the overview is split as the book is, on a phone: Sketch, Asks and Calls, a page opened in its tab': browser =>
      split(browser, c, PHONE, 'phone', { hasTouch: true, isMobile: true }),
    'the overview is split as the book is, on an iPad mini on its side: Sketch, Asks and Calls, a page opened in its tab':
      browser => split(browser, c, MINI, 'mini', touch),
    'the overview is split as the book is, on an iPad mini upright: Sketch, Asks and Calls, a page opened in its tab':
      browser => split(browser, c, UPRIGHT, 'mini-upright', touch),
    'the overview is split as the book is, on a desktop: Sketch, Asks and Calls, a page opened in its tab': browser =>
      split(browser, c, DESKTOP, 'desktop', mouse),
  };
}

const PHONE = { width: 390, height: 844 };
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
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
    await overview();
    assert.deepEqual(
      await chapters(p),
      [
        { head: 'Sketch', count: '2 pages', here: false, pages: ['Ideas', 'Shop page'] },
        { head: 'Asks', count: '1 page', here: false, pages: ['Asks'] },
        { head: 'Calls', count: `${CALLS} pages`, here: true, pages: CALL_TITLES },
      ],
      `${name}: the overview's chapters in the book's order, each page under its own, the page shown in Calls`,
    );
    assert.equal(await far.locator('[data-chapter=sketch] [data-new]').count(), 1, `${name}: New page ends Sketch`);
    await c.shot(`overview-${name}`, p);
    await optionsShut(p, press);
    await open('calls', 'Call 5');
    await landed(p, 'calls', 'Call 5', `5 / ${CALLS}`, `${name}: Call 5 opened from the overview, in Calls`);
    await overview();
    await open('sketch', 'Shop page');
    await landed(p, 'sketch', 'Shop page', '2 / 2', `${name}: Shop page opened from the overview, in Sketch`);
    await overview();
    const again = await chapters(p);
    assert.deepEqual(
      again.map(ch => ch.here),
      [true, false, false],
      `${name}: from Shop page, the page shown in Sketch in the overview`,
    );
  });

// The overview opened from its key (clicked where it is, on the bar or folded into the dots menu: the bar's own
// stories press it there), its chapters drawn and the leaf turned to it landed (while it turns, it carries a copy of
// the paper, the overview's too)
async function opensOverview(p, far, name) {
  await p.locator(`#book .bk-bar .bk-btn[aria-label="${OVERVIEW}"]`).dispatchEvent('click');
  await until(() => far.locator('.bk-far-chapter .bk-tile[data-id]').count(), `${name}: the overview's pages`);
  await until(async () => (await p.locator('#book .bk-turn-leaf').count()) === 0, `${name}: the leaf landed`);
  // (the turn's picture of the paper gone, the overview before it in it: WebKit's frames come late)
  await until(async () => (await p.locator('#book .bk-pages > .bk-far').count()) === 1, `${name}: one overview`);
}
// The overview's chapters as drawn: each head's name and count, whether the page shown is in it, and its pages' titles
// in order
const chapters = p =>
  p.evaluate(() =>
    [...document.querySelectorAll('#book .bk-pages > .bk-far .bk-far-chapter')].map(ch => {
      const head = ch.querySelector('h3.bk-far-mark');
      return {
        head: head.querySelector('span').textContent,
        count: head.querySelector('small').textContent,
        here: !!ch.querySelector('.bk-tile[aria-current=page]'),
        pages: [...ch.querySelectorAll('.bk-tile[data-id] .bk-tile-open')].map(b => b.getAttribute('aria-label')),
      };
    }),
  );
// The overview's options opened from its title line, and Esc shuts them
async function optionsShut(p, press) {
  const far = p.locator('#book .bk-pages > .bk-far'),
    menu = far.locator('.bk-far-menu[role=menu]');
  await press(far.locator('.bk-far-more'));
  await menu.waitFor({ timeout: LOADED_MS });
  await p.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: LOADED_MS });
}
