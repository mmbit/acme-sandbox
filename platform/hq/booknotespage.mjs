// book-check.mjs's story of a call's notes page (shell/ink/calldraw.js; the store's ink/callnotes.ts), its voice line played and the store's events as the feed hands them to the book: the call
// picked up with the book shut makes the call's notes page, and the book stays shut as the agent's scraps land on it
// (HQ's book doesn't draw them yet); hung up, nothing asks about the page (the store sends and archives it). One the
// store can't be reached for is asked for twice and told on a card, and the call's page a notebook has since asks nothing.
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';

// c: book-check's { hqIn, base, shot, settled, noErrorsIn }, and its viewports
export const notesPageStories = c => ({
  "a call's notes page: made at pickup, the book staying shut as the agent's scraps land (desktop)": browser =>
    scrapsLand(browser, c, c.DESKTOP, 'desktop'),
  "a call's notes page: the book stays shut as the scraps land (iPad mini landscape)": browser =>
    scrapsLand(browser, c, c.MINI, 'ipad'),
  "a call's notes page: the book stays shut as the scraps land (phone)": browser =>
    scrapsLand(browser, c, c.PHONE, 'phone'),
  "a call's notes page that can't be opened: asked twice, a card says so, and the page a notebook has asks nothing":
    browser => notOpened(browser, c),
});

async function scrapsLand(browser, c, viewport, device) {
  const context = await c.hqIn(browser, viewport);
  const line = await playLine(context);
  const page = await context.newPage(),
    asked = [];
  page.on('request', r => r.url().endsWith('/api/notebooks/call') && asked.push(r.postDataJSON()));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom`);
    await page.waitForSelector('#loading.gone');
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    // (the book shut, as the board left it)
    if ((await page.evaluate(() => document.documentElement.dataset.book)) !== 'folded') {
      await page.focus('#book .bk-lip');
      await page.keyboard.press('Enter');
      await c.settled(page, 'folded');
    }
    await page.locator('#call').dispatchEvent('click');
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled, null, {
      timeout: 30_000, // (picked up: slow on a loaded machine)
    });
    for (let i = 0; i < 100 && !asked.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(asked, [{ call: 9 }], "the call's notes page asked for as it's picked up");
    assert.ok(line.ws, 'the line picked up');
    await page.waitForTimeout(800);
    assert.equal(await mode(page), 'folded', "the book doesn't open by itself at pickup");

    await landed(page, c, device);
    await page.locator('#call-end').dispatchEvent('click');
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#call-cards [data-card="page"]').count(), 0, 'hung up, nothing asks');
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}
// The network drops the notes page's ask twice. The board's mark makes the call's page, which the agent's first scrap
// makes the notes page in the call's notebook (the store's pageFor): hung up, HQ neither asks about it nor throws it away.
async function notOpened(browser, c) {
  const context = await c.hqIn(browser, c.DESKTOP);
  const line = await playLine(context);
  const page = await context.newPage(),
    asked = [],
    deleted = [],
    unread = [],
    listed = [];
  await page.route(`${c.base}/api/notebooks/call`, r => {
    asked.push(r.request().postDataJSON());
    return r.abort('failed');
  });
  // (today's book as the store lists it at hang-up: the call's page, in the call's notebook)
  const mark = { id: 9001, day: '2026-10-26', kind: 'call', call: 9, notebook: 901, strokes: 0, pictures: 0 };
  await page.route(`${c.base}/api/book`, r => {
    listed.push(Date.now());
    return r.fulfill({ json: { day: mark.day, today: mark.day, days: [], pages: [mark] } });
  });
  page.on('request', r => r.url().endsWith('/api/book/page/delete') && deleted.push(r.postDataJSON()));
  page.on('console', m => m.type() === 'error' && /page wasn’t looked at/.test(m.text()) && unread.push(m.text()));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom`);
    await page.waitForSelector('#loading.gone');
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await page.locator('#call').dispatchEvent('click');
    const card = page.locator('#call-cards [data-card="notes"]');
    await card.waitFor({ timeout: 30_000 }); // (picked up: slow on a loaded machine)
    assert.deepEqual(asked, [{ call: 9 }, { call: 9 }], 'asked once more as the network dropped it');
    assert.match(await card.textContent(), /notes page couldn’t be opened/);
    assert.ok(line.ws, 'the call carries on');
    await c.shot('book-notes-page-not-opened', page);

    await page.evaluate(mark => {
      document.dispatchEvent(new CustomEvent('pencil:note', { detail: { call: 9, page: mark.id, id: 1 } }));
    }, mark);
    const before = listed.length;
    await page.locator('#call-end').dispatchEvent('click');
    for (let i = 0; i < 120 && listed.length === before; i++) await page.waitForTimeout(100);
    assert.ok(listed.length > before, "hung up, HQ reads the call's page");
    await page.waitForTimeout(2500); // (a card would follow the read at once: under a second on a loaded machine)
    assert.equal(await page.locator('#call-cards [data-card]').count(), 0, 'nothing asks or stays');
    assert.deepEqual([deleted, unread], [[], []], 'HQ looked at the page and threw nothing away');
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}
// The agent's scraps land on the page, one by one: the store's 'book' event for that page, each, as HQ's feed tells the
// book (events.js)
async function landed(page, c, device) {
  const id = await callPageId(page, c);
  const before = await cover(page);
  for (let n = 1; n <= 3; n++) {
    await page.evaluate(page => document.dispatchEvent(new CustomEvent('book:changed', { detail: { page } })), id);
    // (its mode turns only once a swing has ended, and a headless swing starts a second or so after: the cover hasn't
    // started to move in seconds)
    for (let i = 0; i < 16 && (await cover(page)) === before; i++) await page.waitForTimeout(250);
    assert.equal(await mode(page), 'folded', `scrap ${n}: the book stays shut`);
    assert.equal(await cover(page), before, `scrap ${n}: the shut book's cover never moves`);
  }
  await c.shot(`book-notes-page-${device}`, page);
}
const mode = page => page.evaluate(() => document.documentElement.dataset.book);
const cover = page => page.evaluate(() => getComputedStyle(document.querySelector('#book .bk-edge')).transform);
// The call's notes page as the store gave it (the mock's newest call page)
const callPageId = (page, c) =>
  page.evaluate(
    async base => (await (await fetch(`${base}/api/book`)).json()).pages.findLast(p => p.kind === 'call').id,
    c.base,
  );
