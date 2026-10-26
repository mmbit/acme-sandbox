// book-check.mjs's film stories that no build thread's story walks, on HQ's
// mock book, held like an iPad mini:
// A morning: the book open on today beside HQ's page, its head offering yesterday; turned back, yesterday's sheet for
// Moss, sent at its time, its note with Moss's answer clipped on under its name, a box to tick it; and on to today again.
// HQ's page never under the book, at any width it keeps a page at: half an iPad mini's split screen, a split laptop
// window, an iPad Air upright, a 10-inch iPad, a 13-inch, a big desktop. Open there, or folded and pulled open, the
// book sits beside the page and none of HQ's buttons is cut by its edge, in Brownstone and in Wire (Wire's narrow
// status row). (A phone's book is a page of its own, over HQ: book-check's
// phone story.)
import assert from 'node:assert/strict';

// c: book-check's { hq, inBook, shot, noErrorsIn, viewport, settle }
export async function morningStory(browser, c) {
  const { page, errors, done } = await c.hq(browser, c.viewport);
  try {
    const when = page.locator('#book .bk-when');
    assert.equal(await when.textContent(), 'Today');
    const back = page.locator('#book').getByRole('button', { name: /^‹ / }),
      yesterday = (await back.textContent()).slice(2);
    await back.click();
    const sheet = page.getByRole('region', { name: 'For Moss' }),
      note = sheet.getByRole('group', { name: 'Note 1' });
    await note.waitFor({ timeout: 5000 });
    await page.waitForTimeout(c.settle);
    assert.equal((await when.textContent()).toLowerCase(), yesterday.toLowerCase(), 'the book on yesterday');
    assert.match(await sheet.textContent(), /Sent \d+ \w+ \d\d:\d\d/, 'the sheet marked sent, with its time');
    assert.match(await note.textContent(), /The tear line is too dark/);
    const answer = note.getByText('Lighter now, half the old ink');
    assert.ok(await c.inBook(page, answer), "the answer clipped on, on the book's paper");
    assert.equal(await note.getByText('Moss', { exact: true }).isVisible(), true, 'under its name');
    assert.equal(await note.getByRole('button', { name: 'Tick it: done' }).isVisible(), true, 'a box to tick');
    assert.equal(await note.getByRole('textbox', { name: 'Reply to Moss' }).isVisible(), true, 'a line to reply on');
    await c.shot('book-morning', page);
    await page.locator('#book').getByRole('button', { name: 'Today ›' }).click();
    await page.waitForTimeout(c.settle);
    assert.equal(await when.textContent(), 'Today', 'and on to today');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// The screens HQ is opened on besides book-check's own (an iPad mini either way round, a 1440 desktop, a phone)
const SCREENS = [
  { width: 560, height: 744 }, // (half an iPad mini's split screen beside Safari)
  { width: 700, height: 1000 }, // (a 342 px page, where Wire's three pills on one row would run under the book)
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1366, height: 1024 },
  { width: 1920, height: 1080 },
];
// (Wire in Chromium only: Linux's headless WebKit can't start it, book-check's Wire stories say why)
const LOOKS = browser => (browser.browserType().name() === 'chromium' ? ['', '&renderer=wire'] : ['']);
// c: book-check's { hq, sight, beside, hqWhole, settled, shot, noErrorsIn }
export async function everyWidthStory(browser, c) {
  for (const look of LOOKS(browser)) for (const screen of SCREENS) await atWidth(browser, c, screen, look);
}
async function atWidth(browser, c, screen, look) {
  const { page, errors, done } = await c.hq(browser, screen, {}, look),
    at = `at ${screen.width} × ${screen.height}${look && ' in Wire'}`;
  try {
    const brownstone = await page.evaluate(() => document.body.classList.contains('brownstone'));
    assert.equal(brownstone, !look, `${at}: the look`);
    if ((await c.sight(page)).mode === 'folded') {
      await page.click('#book .bk-lip');
      // (a narrow page lays HQ's world out again as the book comes: seconds in headless WebKit)
      await page.waitForFunction(() => document.documentElement.dataset.book === 'open', null, { timeout: 15_000 });
      await c.settled(page, 'open');
    }
    const seen = await c.sight(page);
    assert.equal(seen.mode, 'open', at);
    try {
      c.beside(seen);
      c.hqWhole(seen);
    } catch (e) {
      e.message = `${at}: ${e.message}`;
      throw e;
    }
    assert.deepEqual(await cut(page), [], `${at}, HQ's buttons cut by the book`);
    await c.shot(`book-width-${screen.width}${look && '-wire'}`, page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// HQ's buttons and links cut by its page's right edge, half under the book (HQ's page clips what's past it: a closed
// panel waiting off the page's edge is out of sight, not under the book)
const cut = page =>
  page.evaluate(() => {
    const edge = document.body.getBoundingClientRect().right,
      across = r => r.width > 0 && r.left < edge && r.right > edge + 0.5 && r.bottom > 0 && r.top < innerHeight;
    return [...document.body.querySelectorAll('button, a[href], [role=button]')]
      .filter(e => getComputedStyle(e).visibility !== 'hidden' && across(e.getBoundingClientRect()))
      .map(e => (e.getAttribute('aria-label') || e.title || e.textContent).trim().slice(0, 40));
  });
