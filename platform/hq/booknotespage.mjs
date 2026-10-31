// book-check.mjs's story of a call's notes page (shell/ink/calldraw.js; the store's ink/callnotes.ts), its voice line played and the store's events as the feed hands them to the book: the call
// picked up with the book shut makes the call's notes page in My journal and leaves the book shut, and the agent's
// notes land on it one by one. On a screen wider than it is tall the first opens the book there, beside HQ's page, and
// the next lands with it open; shut by the board, it stays shut as the last lands. On one taller than it is wide (an
// upright phone or iPad) it stays shut (shell/ink/booklayout.js initial.). Hung
// up, nothing asks about the page (the store sends it). One the store can't be reached for is asked for
// twice and told on a card, and the call's page a notebook has since asks nothing. (opens)
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';

// c: book-check's { hqIn, base, shot, settled, noErrorsIn }, and its viewports
export const notesPageStories = c => ({
  "a call's notes page: made at pickup, the agent's first note opening the book there, beside HQ's page (desktop)":
    browser => scrapsLand(browser, c, c.DESKTOP, 'desktop'),
  "a call's notes page: the first note opens it beside HQ's page (iPad mini landscape)": browser =>
    scrapsLand(browser, c, c.MINI, 'ipad'),
  "a call's notes page: on a phone the book stays shut as the notes land": browser =>
    scrapsLand(browser, c, c.PHONE, 'phone'),
  "a call's notes page that can't be opened: asked twice, a card says so, and the page a notebook has asks nothing":
    browser => notOpened(browser, c),
  //
  'a call-sized notes page: a dozen scraps and five promises as post-its, none over another (desktop)': browser =>
    callSized(browser, c, c.DESKTOP, 'desktop'),
  'a call-sized notes page: post-its, none over another (iPad mini landscape)': browser =>
    callSized(browser, c, c.MINI, 'ipad'),
});

async function scrapsLand(browser, c, viewport, device) {
  // (a store of its own, My journal made at its first read: the call's page starts empty, whichever story ran before)
  const context = await c.hqIn(browser, viewport, { notebooks: {} });
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
    const answered = page.waitForResponse(r => r.url().endsWith('/api/notebooks/call'), { timeout: 30_000 });
    await page.locator('#call').dispatchEvent('click');
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled, null, {
      timeout: 30_000, // (picked up: slow on a loaded machine)
    });
    for (let i = 0; i < 100 && !asked.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(asked, [{ call: 9 }], "the call's notes page asked for as it's picked up");
    assert.ok(line.ws, 'the line picked up');
    await page.waitForTimeout(800);
    assert.equal(await mode(page), 'folded', "the book doesn't open by itself at pickup, its page made and titled");

    await landed(page, c, { context, line, device, notes: (await (await answered).json()).page.id });
    await page.locator('#call-end').dispatchEvent('click');
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#call-cards [data-card="page"]').count(), 0, 'hung up, nothing asks');
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}
// The network drops the notes page's ask twice. The board's mark makes the call's page, which the agent's first scrap
// makes the notes page in My journal (the store's pageFor): hung up, HQ neither asks about it nor throws it away.
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
  // (today's book as the store lists it at hang-up: the call's page, in My journal)
  const mark = { id: 9001, day: '2026-10-26', kind: 'call', call: 9, notebook: 1, strokes: 0, pictures: 0 };
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
// The agent's notes land on the page, one by one: each a group of its own on the store's page, its 'book' event as
// HQ's feed tells the book (events.js)
async function landed(page, c, { context, line, device, notes }) {
  for (let n = 1; n <= 3; n++) {
    const before = await cover(page);
    const text = { x: 80, y: 80 + n * 60, w: 320, color: '#2b2230', text: `The mugs in teal (${n})` };
    context.notebook.note(notes, line.hello.agent, { texts: [text] });
    if (device === 'phone' || n === 3) {
      // (its mode turns only once a swing has ended, and a headless swing starts a second or so after: the cover hasn't
      // started to move in seconds)
      for (let i = 0; i < 16 && (await cover(page)) === before; i++) await page.waitForTimeout(250);
      const why = device === 'phone' ? "the phone's book stays shut" : 'the book the board shut stays shut';
      assert.equal(await mode(page), 'folded', `note ${n}: ${why}`);
      assert.equal(await cover(page), before, `note ${n}: the shut book's cover never moves`);
    } else {
      // (the swing's frames come slowly in a headless browser on a loaded machine: seconds, where an iPad takes 0.4)
      for (let i = 0; i < 60 && (await mode(page)) === 'folded'; i++) await page.waitForTimeout(250);
      await c.settled(page, 'open');
      assert.equal(await mode(page), 'open', `note ${n}: the book is open beside HQ's page`);
      for (let i = 0; i < 40 && !/: Call with Lyra/.test(await where(page)); i++) await page.waitForTimeout(250);
      assert.match(
        await where(page),
        /^The notebook's pages: Call with Lyra, 15:34(,|$)/, // (counted in Calls)
        `note ${n}: on the call's notes page`,
      );
    }
    if (n === 2) await c.shot(`book-notes-page-${device}`, page);
    // (the board shuts it: the book opens by itself once a call)
    if (n === 2 && device !== 'phone') {
      await page.focus('#book .bk-lip');
      await page.keyboard.press('Enter');
      for (let i = 0; i < 60 && (await mode(page)) !== 'folded'; i++) await page.waitForTimeout(250);
      await c.settled(page, 'folded');
      assert.equal(await mode(page), 'folded', 'the board shut the book');
    }
  }
}
export const mode = page => page.evaluate(() => document.documentElement.dataset.book);
const cover = page => page.evaluate(() => getComputedStyle(document.querySelector('#book .bk-edge')).transform);
const where = page =>
  page
    .locator('#book')
    .getByRole('button', { name: /^The notebook's pages/ })
    .getAttribute('aria-label');

// A call's page as a long call leaves it: a dozen scraps, each with its words, and five promises, put on it by the
// store's own stacking (the play's, notebookplaygroups.js: notebookstack.js). Each scrap's words sit under its own
// picture, a clear gap before the next; the promises are post-its; nothing lies over anything else, and the notes go
// in two columns.
const CAPTIONS = [
  'Smaller',
  'Move the basket next to the price, where the eye already is',
  'Drop this banner',
  'The teal here, as on the mugs',
  'This headline wraps badly on the iPad: one line, a little smaller, and the subtitle under it in grey',
  'Same gap as above',
  'Bigger tap target',
  'Make the footer slim again',
  'Tooltips: the hover states the board reported, all of them',
  'Send goes elsewhere, which makes room for the title on one line',
  'This',
  'Keep the zoom per page',
];
const PROMISES = [
  'Promise for Juno: Send the board the new shop page',
  'Promise for Juno: Fix the tooltips by tonight, and tell the board when they are live on HQ',
  'Promise for Juno: Move the send button',
  'Promise for Juno: Put the title on one line',
  'Promise for you: try it on the iPad',
];
// My journal with the call's page alone, empty
export const callSeed = T => ({
  notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: T, updated: T }],
  pages: [
    {
      id: 9101,
      notebook: 1,
      pos: 0,
      kind: 'call',
      label: 'Call with Lyra, 15:34',
      created: T,
      updated: T,
      w: 1200,
      h: 1600,
    },
  ],
});
async function callSized(browser, c, viewport, device) {
  const context = await c.hqIn(browser, viewport, { notebooks: callSeed(new Date().toISOString()) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom`);
    await page.waitForSelector('#loading.gone');
    await fillCall(page, context.notebook, viewport);
    if ((await mode(page)) !== 'open') {
      await page.focus('#book .bk-lip');
      await page.keyboard.press('Enter');
      await c.settled(page, 'open');
    }
    // (a scrap's words in its body: .bk-words.)
    await page.waitForFunction(() => document.querySelectorAll('[data-page="9101"] .bk-words').length === 12, null, {
      timeout: 30_000,
    });
    await page.waitForFunction(() => document.querySelectorAll('.bk-typed[data-note]').length === 5);
    const groups = context.notebook.route('/api/notebooks/pages/groups', { page: 9101 }).groups;
    assert.equal(groups.filter(g => g.kind === 'note').length, 5, 'the promises, notes of their own kind');
    noneOver(await laidOut(page), groups.length);
    // (seen as the board reads it, the scraps' pictures drawn)
    await page.waitForTimeout(1500);
    await c.shot(`book-notes-call-sized-${device}`, page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}
// Scraps cut from HQ's own page, each its own size and words, a promise after every third, as a call puts them on
async function fillCall(page, play, viewport) {
  const view = { x: 0, y: 0, w: viewport.width, h: viewport.height, dpr: 1 },
    anchor = { v: 1, url: '/', el: null, view, ink: [] },
    put = more => play.route('/api/notebooks/groups/scrap', {}, { anchor, said: 'typed', ...more });
  for (const [i, words] of CAPTIONS.entries()) {
    const clip = { x: 20 + i * 15, y: 40 + i * 10, width: 160 + ((i * 97) % 260), height: 70 + ((i * 53) % 190) };
    put({
      words,
      owner: 'juno',
      snip: `data:image/png;base64,${(await page.screenshot({ clip })).toString('base64')}`,
    });
    if (i % 3 === 2) put({ words: PROMISES[(i - 2) / 3], owner: 'juno' });
  }
  put({ words: PROMISES[4] });
}
// The page's units (each scrap and promise, as its masonry lays them), the scraps' words and the promises' post-its,
// in CSS px, each with its group.
const laidOut = page =>
  page.evaluate(() => {
    const view = document.querySelector('#book .bk-groups[data-page="9101"]').parentElement,
      box = (el, pad = 0) => {
        const r = el.getBoundingClientRect();
        // (whose: a unit's group, a scrap's words' (data-g) or a post-it's typed words' (booktexts.js))
        const g = el.dataset.unit ?? el.dataset.g ?? el.typed?.g;
        return { x: r.left - pad, y: r.top - pad, w: r.width + 2 * pad, h: r.height + 2 * pad, g: String(g) };
      };
    return {
      units: [...view.querySelectorAll('.bk-unit')].map(el => box(el)),
      words: [...view.querySelectorAll('.bk-words')].map(el => box(el)),
      // (the post-it's paper reaches 6 px round its words: booktools.css)
      notes: [...view.querySelectorAll('.bk-typed[data-note]')].map(el => box(el, 6)),
    };
  });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// Every group a unit of its own, no two over each other, and each scrap's words and promise's post-it on its own unit
// and no other's
function noneOver({ units, words, notes }, groups) {
  assert.equal(units.length, groups, 'each scrap and promise a unit of its own');
  for (const [i, a] of units.entries())
    for (const b of units.slice(i + 1))
      assert.ok(!overlap(a, b), `units #${a.g} and #${b.g} don't overlap: ${JSON.stringify([a, b])}`);
  for (const [kind, all] of [
    ['words', words],
    ['promise', notes],
  ])
    for (const x of all) {
      const on = units.filter(u => overlap(x, u));
      assert.deepEqual(
        on.map(u => u.g),
        [x.g],
        `a ${kind} on its own unit only: ${JSON.stringify([x, ...on])}`,
      );
    }
}
