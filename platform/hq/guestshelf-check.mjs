#!/usr/bin/env node
// Ink 1.1's guests on the real coordinator (the deck's Guests chapter): the board invites from the work, Share in HQ's
// viewer, a lasting guest and a week's review round; each signs in once by their one link and comes back to their shelf
// of project books; the book lit for them opens at its first page, the work lit there opens beside the book, and a
// scrap they write lands on that work's page. The board's ask waits in red on the cover, the work's card and the page.
// Phone, iPad mini both ways and a desktop, in Chromium and WebKit. Then the round's week passes and its work leaves
// the shelf.
//   node platform/hq/guestshelf-check.mjs [--shots dir] [--chromium-only]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { coordinator, openVisitor } from './book/guestserver.mjs';
import { readyNotebook } from './book/guestscreen.mjs';
import { serveWork, openShare, addPerson, signInByMail, typeNote, close } from './book/guestpath.mjs';
import { playwright, until } from '../../shared/browser/browser.mjs';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const shots = arg('--shots');
if (shots) await mkdir(shots, { recursive: true });
const SIZES = {
  phone: { width: 390, height: 844 },
  'mini-portrait': { width: 744, height: 1133 },
  'mini-landscape': { width: 1133, height: 744 },
  desktop: { width: 1440, height: 900 },
};
const SAM = 'Sam de Vries',
  KEES = 'Kees Bakker';
const { h, mail, origin, preview } = await coordinator();
const host = `hello${preview}`;
const engines = { chromium: await playwright().chromium.launch({ args: ['--disable-dev-shm-usage'] }) };
if (!process.argv.includes('--chromium-only')) engines.webkit = await playwright().webkit.launch();
const state = { h, mail, origin, preview, browser: engines.chromium, shots, opened: [] };
async function snap(name, page) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}
try {
  const links = await invite();
  await ask();
  for (const [engine, browser] of Object.entries(engines))
    for (const name of [SAM, KEES]) {
      const visitor = await signIn(links[name], browser);
      for (const [size, viewport] of Object.entries(SIZES)) await journey(visitor, engine, size, viewport, name);
      if (engine === Object.keys(engines).at(-1) && name === KEES) await weekPasses(visitor, engine);
      await close(state, visitor);
    }
  for (const visitor of state.opened) assert.deepEqual(visitor.errors, [], visitor.page.url());
  console.log(
    `PASS guest shelf: invited from the work as lasting and a week's round, one link each to a shelf of project books, the lit book and work, a scrap on the work's page, the red count; ${Object.keys(SIZES).join(', ')} in ${Object.keys(engines).join(' and ')}; the round's work gone after its week`,
  );
} catch (error) {
  for (const [index, visitor] of state.opened.entries()) {
    console.log('Guest shelf failure:', index, visitor.page.url(), visitor.diagnostics);
    await snap(`failed-${index}`, visitor.page).catch(() => {});
  }
  throw error;
} finally {
  for (const visitor of [...state.opened]) await close(state, visitor);
  await Promise.all(Object.values(engines).map(browser => browser.close()));
  h.server.closeAllConnections();
  h.server.close();
}

// The board on the work in HQ's viewer: Share, who has access, a lasting guest, then a week's round
async function invite() {
  const links = {};
  for (const [size, viewport] of [
    ['phone', SIZES.phone],
    ['desktop', SIZES.desktop],
  ]) {
    const board = await openVisitor(state, viewport, h.boardCookie);
    await serveWork(state, board.context, host);
    await openShare(state, board.page, host);
    assert.equal(await board.page.locator('#viewer .sharebox [data-days]').count(), 0, 'no days to choose');
    const kinds = await board.page.locator('#viewer .sharebox [data-kind]').allInnerTexts();
    assert.deepEqual(kinds.slice(0, 2), ['Lasting', 'A week’s round']);
    if (size === 'phone') {
      await addToShelf(board.page, SAM, 'sam@example.org', 'lasting');
      await snap(`1-invite-lasting-${size}`, board.page);
      await board.page.locator('#viewer .sharebox [data-kind=notes]').click();
      await addToShelf(board.page, KEES, 'kees@example.org', 'notes');
      await snap(`1-invite-round-${size}`, board.page);
    } else await snap(`1-invite-${size}`, board.page);
    await close(state, board);
  }
  for (const share of (await h.board('/api/review/shares')).body)
    for (const person of share.people) links[person.name] = person.shelf;
  assert.ok(links[SAM] && links[KEES], 'each has their one link');
  return links;
}
// a person added, told they're on the guest's shelf now, with their kind of access
async function addToShelf(page, name, email, kind) {
  await addPerson(page, name, email);
  await until(page, '#viewer .sharebox .invites ul', new RegExp(`${name}.*on ${name.split(' ')[0]}’s shelf now`));
  const share = (await h.board('/api/review/shares')).body.find(s => s.people.some(p => p.name === name));
  assert.equal(share.lasting, kind === 'lasting');
}

// The board hands Sam a scrap of its Asks page: an ask for them, on their work
async function ask() {
  const { mine } = await import('../coordinator/src/notebook.ts');
  const { asksPage } = await import('../coordinator/src/ink/askpages.ts');
  const page = asksPage(mine().id).id;
  const made = await h.board('/api/notebooks/groups/create', {
    page,
    texts: [{ x: 40, y: 40, w: 500, text: 'Would you sign up here?', color: '#292722' }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const sam = (await h.board('/api/notebooks/people')).body.everyone.find(person => person.name === SAM);
  const given = await h.board('/api/notebooks/groups/assign', { id: made.body.id, to: sam.to });
  assert.equal(given.status, 200, JSON.stringify(given.body));
}

// Their one link, once on each engine: the email code, then their own session, and the door's Open to their shelf
async function signIn(link, browser) {
  const visitor = await openVisitor(state, SIZES.phone, '', browser);
  await serveWork(state, visitor.context, host);
  await signInByMail(state, visitor.page, link);
  const path = new URL(link).pathname;
  if (process.env.DEBUG_SHELF) {
    visitor.page.on('framenavigated', f => console.log('NAV', f.url()));
    visitor.page.on('response', r => console.log('RES', r.status(), r.url()));
  }
  await visitor.page.locator(`a[href="${path}/go"]`).click();
  await visitor.page.waitForURL('**/guest/notebooks/');
  await visitor.page.locator('.bk-guest-shelf').waitFor();
  return visitor;
}

// One guest at one size: shelf, the lit book, the lit work beside the book, and (once per engine) a scrap on it
async function journey(visitor, engine, size, viewport, name) {
  const tag = `${name.split(' ')[0].toLowerCase()}-${engine}-${size}`;
  const { page } = visitor;
  await page.setViewportSize(viewport);
  await page.goto(`${origin}/guest/notebooks/`);
  const lit = page.locator('.bk-guest-book[data-lit]');
  await lit.waitFor();
  assert.equal(await page.locator('.bk-guest-book').count(), 2, 'one project book and their journal');
  assert.equal(await lit.locator('.bk-guest-count').count(), name === SAM ? 1 : 0, 'the red count, only with an ask');
  if (name === SAM) assert.equal(await lit.locator('.bk-guest-count').innerText(), '1');
  await noSideScroll(page);
  await snap(`2-shelf-${tag}`, page);

  await lit.click();
  const work = page.locator('.bk-guest-work[data-lit]');
  await work.waitFor();
  assert.match(await work.innerText(), name === SAM ? /1 ask for you/ : /Open until|Open it, write on it/);
  await noSideScroll(page);
  await snap(`3-book-${tag}`, page);

  await work.locator('.bk-guest-open').click();
  await readyNotebook(page);
  const frame = page.frameLocator('.bk-guest-view iframe');
  await frame.locator('h1').filter({ hasText: 'Join the crew' }).waitFor();
  if (name === SAM) await page.locator('#book .bk-for-you').first().waitFor();
  await snap(`4-work-${tag}`, page);
  if (size === 'phone') {
    // (on a phone the book covers the work: its handle folds it away, and back)
    await page.locator('#book .bk-lip').click();
    await page.waitForFunction(() => document.documentElement.dataset.book === 'folded');
    await snap(`4-work-folded-${tag}`, page);
    await page.locator('#book .bk-lip').click();
    await page.waitForFunction(() => ['open', 'spread'].includes(document.documentElement.dataset.book));
  }

  if (size === 'mini-landscape') {
    const words = `Bigger button, ${engine}`;
    await typeNote(page, words);
    const shelf = await page.evaluate(() => fetch('/guest/notebooks/api/shelf').then(r => r.json()));
    const pageId = shelf.books[0].artifacts.find(
      a => a.notebook === Number(new URL(page.url()).searchParams.get('notebook')),
    ).page;
    // (saved by the book's own timer: read until it's there)
    const landed = async () =>
      (await h.board(`/api/notebooks/guests/groups?page=${pageId}`)).body.groups.some(g =>
        JSON.stringify(g).includes(words),
      );
    let found = false;
    for (let tries = 0; tries < 60 && !found; tries++) {
      found = await landed();
      if (!found) await new Promise(done => setTimeout(done, 500));
    }
    assert.ok(found, `${name}'s scrap lands on the work's page`);
    await snap(`5-scrap-${tag}`, page);
  }
}
async function noSideScroll(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'nothing wider');
}

// The round's week passes: its work leaves Kees's shelf, the lasting guest's stays
async function weekPasses(visitor, engine) {
  const { db } = await import('../coordinator/src/db.ts');
  const { endDue } = await import('../coordinator/src/feedback.ts');
  const round = (await h.board('/api/review/shares')).body.find(s => !s.lasting && s.people.some(p => p.name === KEES));
  db.prepare('update review_shares set ends = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), round.id);
  endDue();
  await visitor.page.setViewportSize(SIZES.phone);
  await visitor.page.goto(`${origin}/guest/notebooks/`);
  await visitor.page.locator('.bk-guest-shelf').waitFor();
  assert.equal(await visitor.page.locator('.bk-guest-book').count(), 1, 'only their journal is left');
  await snap(`6-round-ended-kees-${engine}-phone`, visitor.page);
}
