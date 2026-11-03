// book-check.mjs's stories of the Notebook opening where the board left off (shell/ink/bookpages.js), on the played
// Notebook seeded as dev mode's (mock/notebook.json): on an iPad mini with touch, on its side, and on a desktop, a first
// open lands on the notebook's last page; turned back to its first page, put away and opened again, then HQ reloaded,
// it's still there, and on the iPad still there once it's turned upright and HQ reloaded again (one place a device).
import assert from 'node:assert/strict';
import { open } from './notebook.mjs';
import { pageAt } from './notebookscreen.mjs';
import { DESKTOP, MINI, UPRIGHT, until } from './kit.mjs';

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function placeStories(c) {
  return {
    'the Notebook opens where the board left off, on an iPad mini: the last page first, then the page last open, upright too':
      browser => leftOff(browser, c, MINI, 'mini', { hasTouch: true }),
    'the Notebook opens where the board left off, on a desktop: the last page first, then the page last open':
      browser => leftOff(browser, c, DESKTOP, 'desktop', { deviceScaleFactor: 1 }),
  };
}

async function leftOff(browser, c, viewport, name, options) {
  const { page, errors, done } = await open(browser, c, viewport, options);
  try {
    const [first, last] = await at(page);
    assert.equal(first, last, 'a first open lands on the last page');
    await turnTo(page, 1);
    await tapLip(page, 'folded');
    await tapLip(page, 'open');
    assert.equal((await at(page))[0], 1, 'opened again on the page last open');
    await reloaded(page, errors, 'open', 'HQ reloaded on the page last open');
    await c.shot(`place-${name}-reloaded`, page);
    if (options.hasTouch) {
      // (upright the book starts folded, and opens as the spread)
      await page.setViewportSize(UPRIGHT);
      await reloaded(page, errors, 'folded', 'turned upright and reloaded, on the page last open');
      await tapLip(page, 'spread');
      assert.equal((await at(page))[0], 1, 'upright, opened on the page last open');
      await c.shot(`place-${name}-upright`, page);
    }
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// HQ reloaded, the book at rest as it was left, on the page last open (what: what's awaited). Only the page showing
// counts its errors: WebKit can raise the loads a reload cancels as errors of the document it leaves, so what errors
// gains from the reload until the new document commits is that document's and is dropped.
async function reloaded(page, errors, mode, what) {
  const kept = errors.length;
  const committed = frame => {
    if (frame !== page.mainFrame()) return;
    errors.splice(kept);
    page.off('framenavigated', committed);
  };
  page.on('framenavigated', committed);
  await page.reload();
  await page.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  await atRest(page, mode);
  await until(async () => (await at(page))[0] === 1, what);
}
// The book's lip tapped, put away or brought back, at rest in mode
async function tapLip(page, mode) {
  await page.locator('#book .bk-lip').dispatchEvent('click');
  await atRest(page, mode);
}
// The page shown and its chapter's page count, as the bar reads them ("2 / 3": [2, 3]).
const at = page => until(() => pageAt(page), "the bar's page");
// Turned back to page n by the bar's arrow
async function turnTo(page, n) {
  for (let i = 0; i < 8 && (await at(page))[0] > n; i++) {
    const [was] = await at(page);
    await page.locator('#book').getByRole('button', { name: 'The page before' }).dispatchEvent('click');
    await until(async () => (await at(page))[0] !== was, 'the page turned', 30_000);
  }
  assert.equal((await at(page))[0], n, `turned to page ${n}`);
}
// The book at rest in a mode, its swing landed (a loaded machine's software HQ takes a swing many seconds)
const atRest = (page, mode) =>
  page.waitForFunction(
    mode => document.documentElement.dataset.book === mode && !document.querySelector('#book.bk-swinging'),
    mode,
    { timeout: 120_000 },
  );
