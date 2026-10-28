// Guest notebooks on the real coordinator, from the board's invitation through sign-in, answers and closure.
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { createServer, request as forwardRequest } from 'node:http';
import { refusalStory } from './bookguestrefusals.mjs';
import { harness } from '../coordinator/src/harness.ts';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

export async function guestNotebookStories({ shots = null, webkit = true } = {}) {
  if (shots) await mkdir(shots, { recursive: true });
  const { h, proxy, origin } = await coordinator();
  const browser = await playwright().chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const state = { h, origin, browser, shots, opened: [] };
  try {
    const board = await openVisitor(state, { width: 1440, height: 960 }, h.boardCookie);
    await board.page.goto(`${origin}/__notebook-story`);
    await until(board.page, '.bi-create');
    await roundStory(state, board.page);
    const invited = await invitedStory(state, board.page);
    await pairingStory(state);
    if (webkit) await tabletStory(state, invited);
    await languageStories(state);
    for (const visitor of state.opened) assert.deepEqual(visitor.errors, []);
    console.log(
      'PASS guest notebooks: two private guest pages, un-send, final undo, automatic archive and deck task; email-code and passkey sign-in, sent page and live agent answer; device sign-in shortcut',
    );
  } finally {
    await Promise.all(state.opened.map(visitor => visitor.context.close()));
    if (state.recording) await rename(await state.recording.path(), `${state.shots}/invited-notebook-phone.webm`);
    await browser.close();
    h.server.closeAllConnections();
    h.server.close();
    proxy.closeAllConnections();
    proxy.close();
  }
}

// A real configured origin keeps redirects, cookies and WebAuthn native to the browser.
async function coordinator() {
  let target = '';
  const proxy = createServer((request, response) => {
    const forwarded = forwardRequest(
      new URL(request.url, target),
      { method: request.method, headers: request.headers },
      incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      },
    );
    forwarded.on('error', error => response.destroy(error));
    request.pipe(forwarded);
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const port = proxy.address().port;
  const h = await harness('guest-notebook-browser', { env: { PUBLIC_HOST: 'localhost', PORT: String(port) } });
  target = h.base;
  const { ORIGIN } = await import('../coordinator/src/config.ts');
  return { h, proxy, origin: ORIGIN };
}

async function openVisitor(state, viewport, cookie = '', browser = state.browser, video = false) {
  const opened = await openPage(browser, {
    viewport,
    hasTouch: true,
    ...(video && state.shots ? { recordVideo: { dir: state.shots, size: viewport } } : {}),
  });
  if (cookie) {
    const [name, value] = cookie.split('=');
    await opened.context.addCookies([{ name, value, url: state.origin }]);
  }
  await opened.context.route(`${state.origin}/__notebook-story`, route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module">import {showGuestNotebooks} from "/shell/ink/bookinvites.js";showGuestNotebooks();</script></html>',
    }),
  );
  state.opened.push(opened);
  return opened;
}

async function createNotebook(state, board, kind, name, names) {
  await board.locator('[name=name]').fill(name);
  await board.locator('[name=kind]').selectOption(kind);
  while ((await board.locator('.bi-person').count()) < names.length) await board.locator('[data-add]').click();
  for (const [i, person] of names.entries()) {
    await board.locator('.bi-person').nth(i).locator('[name=person]').fill(person);
    await board.locator('.bi-person').nth(i).locator('[name=email]').fill(`${person.toLowerCase()}@example.org`);
  }
  const held = Promise.withResolvers();
  await board.route(
    '**/api/notebooks/guests',
    async route => {
      await held.promise;
      await route.continue();
    },
    { times: 1 },
  );
  await board.locator('.bi-create > button').click();
  try {
    assert.equal(await board.locator('.bi-create > button').isDisabled(), true);
    assert.equal(await board.locator('[data-add]').isDisabled(), false);
  } finally {
    held.resolve();
  }
  await until(board, '.bi-list', new RegExp(name));
  const listed = await state.h.board('/api/notebooks/guests/list');
  const notebook = listed.body.notebooks.find(book => book.name === name);
  assert.ok(notebook);
  return notebook;
}

async function emailSignIn(state, visitor, link) {
  const path = new URL(link).pathname;
  await visitor.page.goto(state.origin + path);
  await visitor.page.locator(`form[action="${path}/send"] button`).click();
  const preview = await visitor.page.locator('pre').textContent();
  const code = /: (\d{6})/.exec(preview)?.[1];
  assert.ok(code, 'the local email preview contains a sign-in code');
  await visitor.page.locator('#code').fill(code);
  await visitor.page.locator(`form[action="${path}/verify"] button`).click();
  try {
    await visitor.page.locator('a[href*="/guest/notebooks/"]').first().click();
  } catch (failure) {
    console.log(
      'Guest sign-in state:',
      JSON.stringify({
        cookies: (await visitor.context.cookies()).map(c => c.name),
        visible: await visitor.page.evaluate(() => ({
          title: document.title,
          body: document.body?.innerText.slice(0, 200),
        })),
      }),
    );
    await snapshot(state, 'guest-sign-in-failed', visitor.page);
    throw failure;
  }
  await until(visitor.page, '.ng-state');
}
const addNote = async (page, words) => {
  await page.locator('.ng-compose textarea').fill(words);
  await page.locator('.ng-compose button').first().click();
  await until(page, '.ng-groups', new RegExp(words.replace(/[?]/g, '\\?')));
};
const snapshot = async (state, name, page) => state.shots && page.screenshot({ path: `${state.shots}/${name}.png` });
const reopenManager = async board => {
  await board.locator('[data-close]').click();
  await board.evaluate(async () => (await import('/shell/ink/bookinvites.js')).showGuestNotebooks());
  await until(board, '.bi-create');
};
async function watch(board, notebook) {
  await board.locator(`[data-watch="${notebook.id}"]`).click();
  await until(board, '.bi-watch h1', new RegExp(notebook.name));
  assert.equal(await board.locator('.bi-watch .ng-compose').isVisible(), false);
}

async function roundStory(state, board) {
  const round = await createNotebook(state, board, 'round', 'Landing page review', ['Ada', 'Bela']);
  const ada = await openVisitor(state, { width: 1280, height: 850 });
  const bela = await openVisitor(state, { width: 390, height: 844 });
  await emailSignIn(state, ada, round.people[0].link);
  await emailSignIn(state, bela, round.people[1].link);
  assert.equal(await ada.page.locator('.ng-pages button').count(), 1);
  assert.equal(await bela.page.locator('.ng-pages button').count(), 1);
  await addNote(ada.page, 'Give the page title more room');
  await addNote(bela.page, 'The small-screen menu needs a clearer label');
  await watch(board, round);
  await board.locator(`[data-page="${round.people[0].page}"]`).click();
  await until(board, '.ng-groups', /Give the page title/);
  await board.locator(`[data-page="${round.people[1].page}"]`).click();
  await until(board, '.ng-groups', /small-screen menu/);
  assert.doesNotMatch(await ada.page.locator('.ng-groups').innerText(), /small-screen/);
  assert.doesNotMatch(await bela.page.locator('.ng-groups').innerText(), /page title/);
  await snapshot(state, 'round-board-desktop', board);
  await ada.page.locator('[data-send]').click();
  await ada.page.locator('[data-undo]').waitFor({ state: 'visible' });
  await ada.page.locator('[data-undo]').click();
  await ada.page.locator('.ng-compose').waitFor({ state: 'visible' });
  await answerDuringRound(state, ada, round.people[0].page);
  await bela.page.locator('[data-send]').click();
  await bela.page.locator('[data-undo]').waitFor({ state: 'visible' });
  const closing = (await state.h.board(`/api/notebooks/guests/list?notebook=${round.id}`)).body.notebooks[0];
  assert.equal(closing.state, 'closing');
  await bela.page.locator('[data-undo]').click();
  await until(bela.page, '.ng-state', /round open/);
  await bela.page.locator('[data-send]').click();
  await until(bela.page, '.ng-state', /Round complete/, 20_000);
  const closed = (await state.h.board(`/api/notebooks/guests/list?notebook=${round.id}`)).body.notebooks[0];
  assert.equal(closed.archived, true);
  assert.ok(closed.deck, 'a completed round queues the deck task');
  assert.equal(closed.pages.length, 2);
  await snapshot(state, 'round-closed-phone', bela.page);
  await reopenManager(board);
}

async function answerDuringRound(state, visitor, page) {
  await visitor.page.locator('[data-send]').click();
  await until(visitor.page, '.ng-agent', /Picked up by/, 20_000);
  const group = (await state.h.board(`/api/notebooks/guests/groups?page=${page}`)).body.groups[0];
  await answerNote(state, group.id, 'I will give the heading more room.');
  await until(visitor.page, '.ng-answer', /heading more room/);
  await snapshot(state, 'round-answer-desktop', visitor.page);
  await visitor.page.locator('[data-undo]').click();
  await visitor.page.locator('.ng-compose').waitFor({ state: 'visible' });
  await until(visitor.page, '.ng-answer', /heading more room/);
  await visitor.page.locator('[data-send]').click();
}

async function invitedStory(state, board) {
  const book = await createNotebook(state, board, 'invited', 'Design notebook', ['Cora']);
  assert.equal(book.ends, null);
  const guest = await openVisitor(state, { width: 390, height: 844 }, '', state.browser, true);
  state.recording = guest.page.video();
  const cdp = await guest.context.newCDPSession(guest.page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await emailSignIn(state, guest, book.people[0].link);
  await guest.page.locator('[data-guest-passkey="enroll"]').click();
  await until(guest.page, 'body > footer', /Passkey saved/);
  await guest.context.clearCookies();
  await guest.page.goto(state.origin + new URL(book.people[0].link).pathname);
  await guest.page.locator('[data-guest-passkey="login"]').click();
  await guest.page.locator('a[href*="/guest/notebooks/"]').first().waitFor();
  await guest.page.locator('a[href*="/guest/notebooks/"]').first().click();
  await until(guest.page, '.ng-state');
  assert.equal(
    (await guest.context.cookies()).some(cookie => cookie.name === 's'),
    false,
  );
  await addNote(guest.page, 'Could the menu be easier to find');
  await drawNote(state, guest.page, book.pages[0].id);
  await watch(board, book);
  await until(board, '.ng-groups', /menu be easier/);
  await board.locator('.ng-ink').waitFor({ state: 'visible' });
  await guest.page.locator('[data-send]').click();
  await guest.page.locator('.ng-pages button').nth(1).waitFor();
  const groups = (await state.h.board(`/api/notebooks/guests/groups?page=${book.pages[0].id}`)).body.groups;
  await answerNote(state, groups[0].id, 'I will make the menu label clearer.');
  await guest.page.locator(`[data-page="${book.pages[0].id}"]`).click();
  await until(guest.page, '.ng-answer', /make the menu label clearer/);
  await until(board, '.ng-answer', /make the menu label clearer/);
  await until(guest.page, '.ng-group', /Picked up by/);
  await snapshot(state, 'invited-answer-phone', guest.page);
  await snapshot(state, 'invited-watching-desktop', board);
  const overflow = await guest.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'the phone page stays inside its viewport');
  return { book, cookies: await guest.context.cookies() };
}

async function drawNote(state, page, pageId) {
  await page.locator('[data-draw]').click();
  const canvas = page.locator('.ng-drawing canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  for (const height of [0.25, 0.65]) {
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * height);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * height, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForFunction(async id => {
    const contents = await (await fetch(`/guest/notebooks/api/groups?page=${id}`)).json();
    return contents.groups.some(group => group.ink.length === 2);
  }, pageId);
  const groups = (await state.h.board(`/api/notebooks/guests/groups?page=${pageId}`)).body.groups;
  const drawn = groups.filter(group => group.ink.length);
  assert.equal(drawn.length, 1, 'two drawing strokes stay in one group');
  assert.equal(drawn[0].ink.length, 2);
  await page.locator('[data-draw]').click();
}

async function answerNote(state, group, text) {
  const { SEND_MS } = await import('../coordinator/src/ink/booknotes.ts');
  const sheets = await import('../coordinator/src/ink/booksheets.ts');
  sheets.deliverDue(Date.now() + SEND_MS);
  const note = state.h.db
    .prepare(
      `select n.review, s.job from notebook_groups g join book_notes n on n.id = g.note
    join book_sheets s on s.id = n.sheet where g.id = ?`,
    )
    .get(group);
  const job = await state.h.claimJob(note.job);
  assert.equal((await state.h.agent('answer', job.token, { note: note.review, text })).status, 200);
  await state.h.finish(job);
}

async function pairingStory(state) {
  const code = (await state.h.board('/api/notebooks/pair', {})).body.code;
  const other = await openVisitor(state, { width: 390, height: 844 });
  await other.page.goto(`${state.origin}/pair#code=${code}`);
  await other.page.locator('form button').click();
  await other.page.waitForURL(state.origin + '/');
  const cookies = await other.context.cookies();
  const session = cookies.find(cookie => cookie.name === 's');
  assert.ok(session, 'the one-time shortcut signs the second device in');
  assert.equal((await state.h.send('/api/notebooks', { cookie: `s=${session.value}` })).status, 200);
}

async function tabletStory(state, invited) {
  const browser = await playwright().webkit.launch();
  try {
    const tablet = await openVisitor(state, { width: 744, height: 1133 }, '', browser);
    await tablet.context.addCookies(invited.cookies);
    await tablet.page.goto(`${state.origin}/guest/notebooks/?notebook=${invited.book.id}`);
    await tablet.page.locator(`[data-page="${invited.book.pages[0].id}"]`).click();
    await until(tablet.page, '.ng-answer', /make the menu label clearer/);
    await snapshot(state, 'invited-answer-ipad-webkit', tablet.page);
    assert.deepEqual(tablet.errors, []);
    await tablet.context.close();
    state.opened.splice(state.opened.indexOf(tablet), 1);
  } finally {
    await browser.close();
  }
}

// prettier-ignore
const languageChecks = [
  ['nl', 'Dora', 'Je eigen notitieboek', 'Notitieboek openen', 'Je notitieboeken', 'Notitie toevoegen', 'Notitie bewerken', 'Antwoorden', 'Pagina versturen'],
  ['de', 'Ella', 'Dein eigenes Notizbuch', 'Notizbuch öffnen', 'Deine Notizbücher', 'Notiz hinzufügen', 'Notiz bearbeiten', 'Antworten', 'Seite senden'],
];
async function languageStories(state) {
  const job = await state.h.start({ agent: 'vera' });
  for (const check of languageChecks) await languageStory(state, job, check);
  await state.h.finish(job);
}

async function languageStory(state, job, [lang, name, intro, open, label, add, edit, reply, send]) {
  const book = await languageNotebook(state, job, lang, name, label);
  const visitor = await openVisitor(state, { width: 390, height: 844 });
  await emailSignIn(state, visitor, book.people[0].link);
  const page = visitor.page;
  assert.equal(await page.locator('html').getAttribute('lang'), lang);
  assert.equal(await page.title(), label);
  assert.equal(await page.locator('.ng-compose button').first().innerText(), add);
  assert.equal(await page.locator('[data-send]').innerText(), send);
  await addNote(page, 'A guest note');
  assert.equal(await page.locator('[data-edit]').innerText(), edit);
  await page.locator('[data-edit]').click();
  assert.equal(await page.locator('[data-editing] label').innerText(), edit);
  await page.locator('[data-editing] button').click();
  await page.locator('[data-editing]').waitFor({ state: 'detached' });
  await page.locator('[data-send]').click();
  await page.locator('.ng-pages button').nth(1).waitFor();
  const groups = (await state.h.board(`/api/notebooks/guests/groups?page=${book.pages[0].id}`)).body.groups;
  await answerNote(state, groups[0].id, 'An answer for the guest');
  await page.locator(`[data-page="${book.pages[0].id}"]`).click();
  await until(page, '.ng-answer', /An answer for the guest/);
  assert.equal(await page.locator('[data-answer] button').innerText(), reply);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await snapshot(state, `guest-language-${lang}-phone`, page);
  await page.goto(state.origin + new URL(book.people[0].link).pathname);
  await until(page, '.intro', new RegExp(intro));
  assert.equal(await page.locator('a[href$="/go"]').innerText(), open);
  assert.equal(await page.locator('a[href="/guest/notebooks/"]').innerText(), label);
  await snapshot(state, `guest-door-${lang}-phone`, page);
  await refusalStory(state, visitor, lang, name);
}

async function languageNotebook(state, job, lang, name, label) {
  const guests = await import('../coordinator/src/guests.ts');
  const written = guests.write(job, name, 'Earlier checklist', {
    lang,
    sections: [{ items: [{ kind: 'info', title: 'Welcome' }] }],
  });
  assert.ok(!Array.isArray(written));
  const created = await state.h.board('/api/notebooks/guests', {
    kind: 'invited',
    name: label,
    people: [{ name, email: `${name.toLowerCase()}@example.org` }],
  });
  assert.equal(created.status, 200);
  return created.body.notebook;
}
