#!/usr/bin/env node
// A page given to a guest, on the real coordinator (notebookgive.ts, bookgive.js): on the board's iPad, a call's notes
// page with a prototype on it goes to someone new by Give a copy… in the dots menu, a second page to her from the list,
// and she signs in by her one link to find both in her own notebook, the prototype's frame on the first, hers to write
// on. Screenshots of each step.
//   node platform/hq/give-check.mjs [--shots dir]
// The coordinator takes the prototype's picture in its own Chromium: CHROMIUM_PATH names one where `chromium` isn't on
// PATH.
import assert from 'node:assert/strict';
import { launched } from '../../shared/browser/browser.mjs';
import { devices, said } from './book/devicecheck.mjs';
import { coordinator } from './book/guestserver.mjs';

const LANDSCAPE = { width: 1180, height: 820 },
  PORTRAIT = { width: 820, height: 1180 };
const PROTOTYPE = `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;
background:#f6efe4;font:600 28px system-ui"><p>Reis A</p></body></html>`;

const state = await coordinator();
const { h, mail, origin } = state;
const browser = await launched();
assert.ok(browser, 'no Chromium for Playwright');
const check = devices(browser, state),
  { shot } = check;

// The board's book open at a page, on HQ once its screens are wired
async function openAt(board, page) {
  await board.evaluate(at => import('/shell/ink/book.js').then(m => m.openAt(at)), {
    page: page.id,
    notebook: page.notebook,
  });
  await board.locator('#book .bk-paper').waitFor({ state: 'attached', timeout: 60_000 });
  await board.waitForTimeout(1500);
}
// Give a copy… from the dots menu: its card, and the copy given by pick(card) → the store's answer
async function giveFrom(board, pick, name) {
  await board.locator('.bk-more').click();
  await board.getByRole('menuitem', { name: 'Give a copy…' }).click();
  const card = board.locator('.bk-give');
  await card.waitFor();
  const answer = board.waitForResponse(r => new URL(r.url()).pathname === '/api/notebooks/pages/give');
  await pick(card);
  const given = await (await answer).json();
  await card.getByText(`${name} has it in their own notebook.`).waitFor();
  return { card, given };
}

try {
  const { call } = await h.liveCall('juno');
  const callPage = said(await h.board('/api/notebooks/call', { call })).page;
  said(await h.voice('prototype', { call, name: 'Reis', html: PROTOTYPE }));
  const sketch = said(await h.board('/api/notebooks/pages/create', { notebook: callPage.notebook }));
  said(await h.board('/api/notebooks/pages/title', { id: sketch.id, title: 'Fotoboek, sessie 2' }));
  said(
    await h.board('/api/notebooks/groups/create', {
      page: sketch.id,
      texts: [{ x: 40, y: 40, w: 500, text: 'Thema voor het hele boek', color: '#292722' }],
    }),
  );

  const board = (await check.open(LANDSCAPE, h.boardCookie)).page;
  const listening = board.waitForRequest(r => new URL(r.url()).pathname === '/api/events', { timeout: 60_000 });
  await board.goto(`${origin}/`);
  await listening;
  await openAt(board, callPage);
  const first = await giveFrom(
    board,
    async card => {
      await shot('1-give-card', board);
      await card.getByPlaceholder('Name').fill('Esmee');
      await card.getByPlaceholder('Email address').fill('esmee@example.org');
      await card.getByRole('button', { name: 'Give', exact: true }).click();
    },
    'Esmee',
  );
  await shot('2-given', board);
  await first.card.getByRole('button', { name: 'Done' }).click();
  await openAt(board, sketch);
  const second = await giveFrom(board, card => card.getByRole('button', { name: 'Esmee' }).click(), 'Esmee');
  assert.equal(second.given.link, first.given.link, 'one link for her');

  // She signs in by her link: both pages in her own notebook, the prototype's frame on the first
  const { g } = await h.guestIn(first.given.link, mail.code);
  const guest = (await check.open(PORTRAIT, g)).page;
  const read = async path => (await fetch(`${h.base}/guest/notebooks/api${path}`, { headers: { cookie: g } })).json();
  const shelf = await read('/shelf');
  const pages = (await read(`/pages?notebook=${shelf.journal.notebook}`)).pages;
  assert.deepEqual(
    pages.slice(-2).map(p => p.id),
    [first.given.page.id, second.given.page.id],
    'both pages in her notebook, in order',
  );
  const groups = (await read(`/pages/groups?page=${first.given.page.id}`)).groups;
  assert.ok(
    groups.some(gr => gr.children.some(c => c.style === 'version' && c.picture)),
    "the prototype's frame",
  );
  await guest.goto(`${origin}/guest/notebooks/?notebook=${shelf.journal.notebook}`);
  await guest.locator('#book .bk-paper').waitFor({ state: 'attached', timeout: 60_000 });
  await guest.waitForTimeout(2000);
  await shot('3-her-notebook', guest);
  check.clean();
  console.log("PASS give: a call's page to someone new, a second page to her from the list, both in her own notebook");
} finally {
  await check.close();
}
