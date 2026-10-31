#!/usr/bin/env node
// The guest path seen whole, on the real coordinator, for a designer's eye: the board's side (Share in HQ's viewer
// with a lasting guest and a week's round on it, Watching live, the device sign-in page) in each of HQ's looks, and the
// guest's side (their door with its email code and a wrong one, their shelf, a book, its work with a scrap written on
// it, a refusal) in the guest desk's company look, which no HQ look changes. Phone, iPad and desktop, in Chromium.
// Every shot is asserted to fit its width; the shots are for judging by eye.
//   node platform/hq/guestlooks-check.mjs --shots dir [--looks wire,brownstone,holo] [--sizes phone,ipad,desktop]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { coordinator, openVisitor, fulfilResponse } from './bookguestserver.mjs';
import { readyHQ, createNotebook } from './bookinvitechecks.mjs';
import { readyNotebook, addNote, drawNote, named, pointOnPaper } from './bookguestscreen.mjs';
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
const artifactPage = `<!doctype html><meta name="viewport" content="width=device-width"><title>Join the crew</title>
<body style="margin:0;background:#fffaf0;color:#2a2352;font:18px system-ui,sans-serif">
<main style="padding:32px"><h1>Join the crew</h1><p>Sign up for the first launch.</p>
<label>Email<br><input style="font:inherit;width:80%;padding:10px"></label><p><button style="font:inherit;padding:14px 28px">Sign up</button></p>
</main><script src="/__review/review.js"></script>`;

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
  for (const visitor of [...state.opened]) await close(visitor);
  await browser.close();
  h.server.closeAllConnections();
  h.server.close();
}

// The board shares the work once, in the company's look: Sam lasting, Kees for a week's round
async function invite() {
  const board = await openVisitor(state, ALL.desktop, h.boardCookie);
  await serveArtifact(board.context);
  await openShare(board.page);
  await addPerson(board.page, SAM, 'sam@example.org');
  await board.page.locator('#viewer .sharebox [data-kind=notes]').click();
  await addPerson(board.page, KEES, 'kees@example.org');
  await close(board);
  const links = {};
  for (const share of (await h.board('/api/review/shares')).body)
    for (const person of share.people) links[person.name] = person.shelf;
  return links;
}
async function openShare(page) {
  await page.goto(`${origin}/?intro=0`);
  await readyHQ(page);
  await page.evaluate(async url => {
    (await import('/shell/ink/book.js')).foldBook();
    (await import('/shell/desk.js')).openLink(url);
  }, `https://${host}/`);
  await page.locator('#viewer .bar .share').click();
  await page.locator('#viewer .sharebox form.invite').waitFor();
  // (the look's arrival over: a first visit eases in through a blur and a fade)
  await page.waitForFunction(
    () =>
      ['none', ''].includes(getComputedStyle(document.body).filter) && getComputedStyle(document.body).opacity === '1',
  );
}
async function addPerson(page, name, email) {
  await page.locator('#viewer .sharebox form.invite [name=name]').fill(name);
  await page.locator('#viewer .sharebox form.invite [name=email]').fill(email);
  await page.locator('#viewer .sharebox form.invite [type=submit]').click();
  await until(page, '#viewer .sharebox .invites ul', new RegExp(name));
}

// The board hands Sam one of its scraps: an ask for them, on their work
async function ask() {
  const { currentPage, mine } = await import('../coordinator/src/notebook.ts');
  const made = await h.board('/api/notebooks/groups/create', {
    page: currentPage(mine().id),
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
  await signIn(cora.page, book.people[0].link);
  await cora.page.locator('a[href*="/guest/notebooks/"]').first().click();
  await readyNotebook(cora.page);
  await addNote(cora.page, 'Could the menu be easier to find');
  await drawNote(state, cora.page, book.pages[0].id);
  await close(cora);
  return book;
}

// One look at one size: Share with both guests on it, Watching live, the device sign-in page
async function boardSide(look, size, viewport, watched) {
  const tag = `${look}-${size}`;
  const board = await openVisitor(state, viewport, h.boardCookie);
  await board.context.addInitScript(l => localStorage.setItem('hq.renderer', JSON.stringify(l)), look);
  await serveArtifact(board.context);
  const { page } = board;
  await openShare(page);
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
  await page.locator('main h1 img:visible').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await snap(`board-sign-in-${tag}`, page);
  await close(board);
}

// The guest's side at each size: door, email code, a wrong code, signed in, shelf, book, work, a scrap written
async function guestSide(link) {
  const path = new URL(link).pathname;
  for (const [size, viewport] of Object.entries(SIZES)) {
    const sam = await openVisitor(state, viewport);
    await serveArtifact(sam.context);
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
    await close(sam);
  }
}
async function signIn(page, link) {
  const path = new URL(link).pathname;
  await page.goto(origin + path);
  await page.locator(`form[action="${path}/send"] button`).click();
  await page.locator('#code').waitFor();
  await page.locator('#code').fill(/: (\d{6})/.exec(mail.taken.at(-1)?.text)[1]);
  await page.locator(`form[action="${path}/verify"] button`).click();
}
async function typeNote(page, words) {
  await page
    .locator('#book')
    .getByRole('button', { name: await named(page, 'Text'), exact: true })
    .click();
  // (past the 64 px in which words join the ask above them)
  const [x] = await pointOnPaper(page, 0.3, 0.5);
  const y = await page.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll('#book .bk-page:not([hidden]) [data-g]')].map(
        el => el.getBoundingClientRect().bottom,
      ),
    ),
  );
  await page.mouse.click(x, y + 100);
  const field = page.locator('#book .bk-typed-words[contenteditable]');
  await field.fill(words);
  await field.press('Escape');
  await page.locator('#book .bk-typed').filter({ hasText: words }).first().waitFor();
}

// A round's guest asks a colleague with a public mail address, then their session ends
async function refusals() {
  const { createNotebook: roundBook } = await import('../coordinator/src/notebookguests.ts');
  for (const [size, viewport] of Object.entries(SIZES)) {
    const name = `Dina${size}`;
    const { notebook: made } = roundBook({
      kind: 'round',
      name: 'Colleague invitations',
      colleagues: true,
      people: [{ name, email: `${name.toLowerCase()}@example.org` }],
    });
    const dina = await openVisitor(state, viewport);
    const { page } = dina;
    await signIn(page, made.people[0].link);
    await page.locator('a[href*="/guest/notebooks/"]').first().click();
    await readyNotebook(page);
    await page.locator('#book .bk-island').getByRole('button', { name: 'Invite a colleague', exact: true }).click();
    await page.locator('.bk-guest-invite').waitFor({ state: 'visible' });
    await page.locator('.bk-guest-invite [name=name]').fill('Faye');
    await page.locator('.bk-guest-invite [name=email]').fill('faye@gmail.com');
    await page.locator('.bk-guest-invite button:not([data-close])').click();
    await until(page, '[data-invite-error]', /own company/);
    await page.locator('[data-invite-error]').scrollIntoViewIfNeeded();
    await snap(`guest-refusal-colleague-${size}`, page);
    await dina.context.clearCookies();
    await until(page, '[data-notebook-status]', /invitation link/);
    await snap(`guest-refusal-signed-out-${size}`, page);
    await close(dina);
  }
}

async function close(visitor) {
  await visitor.context.unrouteAll({ behavior: 'ignoreErrors' });
  await visitor.context.close();
  state.opened.splice(state.opened.indexOf(visitor), 1);
}
// The work: a stand-in page on the product's preview host, its review mode from the real coordinator
async function serveArtifact(context) {
  await context.route(`https://${host}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/__review/') && url.pathname !== '/__preview')
      return route.fulfill({ contentType: 'text/html', body: artifactPage });
    const response = await route.fetch({
      url: h.base + url.pathname + url.search,
      headers: { ...request.headers(), host },
      maxRedirects: 0,
      timeout: 30_000,
    });
    return fulfilResponse(route, response);
  });
}
// (the coordinator's timers outlive its server)
process.exit(0);
