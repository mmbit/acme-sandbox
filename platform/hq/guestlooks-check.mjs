#!/usr/bin/env node
// The guest path seen whole, on the real coordinator, for a designer's eye: the board's side (Share in HQ's viewer
// with a lasting guest and a week's round on it, Watching live, the device sign-in page) in each of HQ's looks, and the
// guest's side (their door with its email code and a wrong one, their shelf, a book, its work with a scrap written on
// it, a refusal) in the guest desk's company look, which no HQ look changes. Phone, iPad and desktop, in Chromium.
// Every shot is asserted to fit its width; the shots are for judging by eye.
//   node platform/hq/guestlooks-check.mjs --shots dir [--looks wire,brownstone,holo] [--sizes phone,ipad,desktop]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { coordinator, openVisitor } from './book/guestserver.mjs';
import { readyHQ, createNotebook } from './book/invitechecks.mjs';
import { readyNotebook, addNote, drawNote } from './book/guestscreen.mjs';
import { serveWork, openShare, addPerson, signInByMail, typeNote, close } from './book/guestpath.mjs';
import { playwright, until } from '../../shared/browser/browser.mjs';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const shots = arg('--shots') ?? 'shots';
await mkdir(shots, { recursive: true });
const ALL = {
  phone: { width: 390, height: 844 },
  ipad: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};
const SIZES = Object.fromEntries((arg('--sizes') ?? 'phone,ipad,desktop').split(',').map(s => [s, ALL[s]]));
const LOOKS = (arg('--looks') ?? 'wire,brownstone,holo').split(',');
const SAM = 'Sam de Vries',
  KEES = 'Kees Bakker';
const { h, mail, origin, preview } = await coordinator();
const host = `hello${preview}`;
const browser = await playwright().chromium.launch({ args: ['--disable-dev-shm-usage'] });
const state = { h, mail, origin, preview, browser, shots, opened: [] };
const taken = [];
async function snap(name, page) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${name}.png` });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(wide, false, `${name}: nothing wider than the screen`);
  taken.push(name);
}
try {
  const links = await invite();
  await ask();
  const watched = await coraWrites();
  for (const look of LOOKS)
    for (const [size, viewport] of Object.entries(SIZES)) await boardSide(look, size, viewport, watched);
  await guestSide(links[SAM]);
  await refusals();
  console.log(`PASS guest looks: ${taken.length} shots in ${shots}`);
} catch (error) {
  for (const [index, visitor] of state.opened.entries()) {
    console.log('Guest looks failure:', index, visitor.page.url(), visitor.diagnostics);
    await visitor.page.screenshot({ path: `${shots}/failed-${index}.png` }).catch(() => {});
  }
  throw error;
} finally {
  for (const visitor of [...state.opened]) await close(state, visitor);
  await browser.close();
  h.server.closeAllConnections();
  h.server.close();
}

// The board shares the work once, in the company's look: Sam lasting, Kees for a week's round
async function invite() {
  const board = await openVisitor(state, ALL.desktop, h.boardCookie);
  await serveWork(state, board.context, host);
  await shareSettled(board.page);
  await addPerson(board.page, SAM, 'sam@example.org');
  await board.page.locator('#viewer .sharebox [data-kind=notes]').click();
  await addPerson(board.page, KEES, 'kees@example.org');
  await close(state, board);
  const links = {};
  for (const share of (await h.board('/api/review/shares')).body)
    for (const person of share.people) links[person.name] = person.shelf;
  return links;
}
// Share open, the look's arrival over (a first visit eases in through a blur and a fade)
async function shareSettled(page) {
  await openShare(state, page, host);
  await page.waitForFunction(
    () =>
      ['none', ''].includes(getComputedStyle(document.body).filter) && getComputedStyle(document.body).opacity === '1',
  );
}

// The board hands Sam a scrap of its Asks page: an ask for them, on their work
async function ask() {
  const { mine } = await import('../coordinator/src/notebook.ts');
  const { asksPage } = await import('../coordinator/src/ink/askpages.ts');
  const made = await h.board('/api/notebooks/groups/create', {
    page: asksPage(mine().id).id,
    texts: [{ x: 40, y: 40, w: 500, text: 'Would you sign up here?', color: '#292722' }],
  });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const sam = (await h.board('/api/notebooks/people')).body.everyone.find(person => person.name === SAM);
  assert.equal((await h.board('/api/notebooks/groups/assign', { id: made.body.id, to: sam.to })).status, 200);
}

// Cora's invited notebook with a note and a drawing on it, for the board to watch
async function coraWrites() {
  const book = await createNotebook(state, 'Design notebook', 'Cora');
  const cora = await openVisitor(state, ALL.phone);
  await signInByMail(state, cora.page, book.people[0].link);
  await cora.page.locator('a[href*="/guest/notebooks/"]').first().click();
  await readyNotebook(cora.page);
  await addNote(cora.page, 'Could the menu be easier to find');
  await drawNote(state, cora.page, book.pages[0].id);
  await close(state, cora);
  return book;
}

// One look at one size: Share with both guests on it, Watching live, the device sign-in page
async function boardSide(look, size, viewport, watched) {
  const tag = `${look}-${size}`;
  const board = await openVisitor(state, viewport, h.boardCookie);
  await board.context.addInitScript(l => localStorage.setItem('hq.renderer', JSON.stringify(l)), look);
  await serveWork(state, board.context, host);
  const { page } = board;
  await shareSettled(page);
  await page.waitForFunction(async l => (await import('/shell/stage.js')).look === l, look);
  await until(page, '#viewer .sharebox .invites ul', new RegExp(SAM));
  await snap(`board-share-lasting-${tag}`, page);
  await page.locator('#viewer .sharebox [data-kind=notes]').click();
  await until(page, '#viewer .sharebox .invites ul', new RegExp(KEES));
  await snap(`board-share-round-${tag}`, page);
  await page.goto(`${origin}/?intro=0`);
  await readyHQ(page);
  await page.evaluate(async id => (await import('/shell/ink/bookinvites.js')).watchGuestBook(id), watched.id);
  await page.waitForFunction(name => document.querySelector('.bi-watch h1')?.textContent === name, watched.name);
  await until(page, '.ng-groups', /menu be easier/);
  await snap(`board-watching-${tag}`, page);
  const { code } = (await h.board('/api/notebooks/pair', {})).body;
  await page.goto(`${origin}/pair#code=${code}`);
  await page.locator('main h1 :is(img, svg):visible').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await snap(`board-sign-in-${tag}`, page);
  await close(state, board);
}

// The guest's side at each size: door, email code, a wrong code, signed in, shelf, book, work, a scrap written
async function guestSide(link) {
  const path = new URL(link).pathname;
  for (const [size, viewport] of Object.entries(SIZES)) {
    const sam = await openVisitor(state, viewport);
    await serveWork(state, sam.context, host);
    const { page } = sam;
    await page.goto(origin + path);
    await snap(`guest-door-${size}`, page);
    await page.locator(`form[action="${path}/send"] button`).click();
    await page.locator('#code').waitFor();
    await snap(`guest-door-code-${size}`, page);
    await page.locator('#code').fill('000000');
    await page.locator(`form[action="${path}/verify"] button`).click();
    await page.locator('#code').waitFor();
    await snap(`guest-refusal-wrong-code-${size}`, page);
    const code = /: (\d{6})/.exec(mail.taken.at(-1)?.text)?.[1];
    await page.locator('#code').fill(code);
    await page.locator(`form[action="${path}/verify"] button`).click();
    await page.locator(`a[href="${path}/go"]`).waitFor();
    await snap(`guest-signed-in-${size}`, page);
    await page.locator(`a[href="${path}/go"]`).click();
    await page.locator('.bk-guest-shelf').waitFor();
    const lit = page.locator('.bk-guest-book[data-lit]');
    await lit.waitFor();
    await snap(`guest-shelf-${size}`, page);
    await lit.click();
    const work = page.locator('.bk-guest-work[data-lit]');
    await work.waitFor();
    await snap(`guest-book-${size}`, page);
    await work.locator('.bk-guest-open').click();
    await readyNotebook(page);
    await page.frameLocator('.bk-guest-view iframe').locator('h1').filter({ hasText: 'Join the crew' }).waitFor();
    await page.locator('#book .bk-for-you').first().waitFor();
    await snap(`guest-work-${size}`, page);
    await typeNote(page, `Bigger button, please (${size})`);
    await snap(`guest-writing-${size}`, page);
    await close(state, sam);
  }
}

// A guest's session ends while their notebook is open
async function refusals() {
  const { createInvitedNotebook } = await import('../coordinator/src/notebookguests.ts');
  for (const [size, viewport] of Object.entries(SIZES)) {
    const name = `Dina${size}`;
    const { notebook: made } = createInvitedNotebook({
      name: 'Session refusals',
      people: [{ name, email: `${name.toLowerCase()}@example.org` }],
    });
    const dina = await openVisitor(state, viewport);
    const { page } = dina;
    await signInByMail(state, page, made.people[0].link);
    await page.locator('a[href*="/guest/notebooks/"]').first().click();
    await readyNotebook(page);
    // (the book's tools load after it shows: signed out only once they're in)
    await page.waitForLoadState('networkidle');
    await dina.context.clearCookies();
    await until(page, '[data-notebook-status]', /invitation link/);
    await snap(`guest-refusal-signed-out-${size}`, page);
    await close(state, dina);
  }
}
