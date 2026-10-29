// Guest notebooks on the real coordinator, from the board's invitation through sign-in, answers and closure.
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { coordinator, openVisitor } from './bookguestserver.mjs';
import { createNotebook, inviteScreens, createReviewRound, knownInvitation, readyHQ } from './bookinvitechecks.mjs';
import { artifactScrap } from './bookguestartifact.mjs';
import { until as waitFor } from './bookkit.mjs';
import { refusalStory } from './bookguestrefusals.mjs';
import {
  readyNotebook,
  addNote,
  drawNote,
  sendPage,
  named,
  undoPage,
  reopenPage,
  firstPage,
  snapshot,
  selectionAndPrefs,
  untitledPage,
} from './bookguestscreen.mjs';
import { playwright, until } from '../../shared/browser/browser.mjs';
import { words } from './shell/ink/notebookwords.js';

export async function guestNotebookStories({ shots = null, webkit = true } = {}) {
  if (shots) await mkdir(shots, { recursive: true });
  const { h, mail, origin, preview } = await coordinator();
  const browser = await playwright().chromium.launch({
    args: ['--disable-dev-shm-usage'],
  });
  const state = { h, mail, origin, preview, browser, shots, opened: [] };
  try {
    const board = await openVisitor(state, { width: 1440, height: 960 }, h.boardCookie);
    await board.page.goto(`${origin}/?intro=0`);
    await readyHQ(board.page);
    await board.page.evaluate(async () => (await import('/shell/ink/bookinvites.js')).showGuestNotebooks());
    await until(board.page, 'form.invite');
    await roundStory(state, board.page);
    console.log('Guest browser: review round complete');
    const invited = await invitedStory(state, board.page);
    console.log('Guest browser: invited notebook complete');
    await pairingStory(state);
    console.log('Guest browser: device sign-in complete');
    if (webkit) {
      await tabletStory(state, invited);
      console.log('Guest browser: iPad WebKit complete');
    }
    await languageStories(state);
    console.log('Guest browser: languages and refusals complete');
    for (const visitor of state.opened) assert.deepEqual(visitor.errors, []);
    console.log(
      'PASS guest notebooks: two private guest pages, un-send, final undo, automatic archive and deck task; email-code and passkey sign-in, sent page and live agent answer; device sign-in shortcut',
    );
  } catch (error) {
    for (const [index, visitor] of state.opened.entries()) {
      console.log('Guest browser failure:', index, visitor.page.url(), visitor.diagnostics);
      await snapshot(state, `guest-failed-${index}`, visitor.page);
    }
    throw error;
  } finally {
    for (const visitor of state.opened) if (visitor.errors.length) console.log('Browser errors:', visitor.errors);
    await Promise.all(state.opened.map(visitor => visitor.context.close()));
    if (state.recording) await rename(await state.recording.path(), `${state.shots}/invited-notebook-phone.webm`);
    await browser.close();
    h.server.closeAllConnections();
    h.server.close();
  }
}

async function emailSignIn(state, visitor, link) {
  const path = new URL(link).pathname;
  await visitor.page.goto(state.origin + path);
  await visitor.page.locator(`form[action="${path}/send"] button`).click();
  await visitor.page.locator('#code').waitFor();
  const code = /: (\d{6})/.exec(state.mail.taken.at(-1)?.text)?.[1];
  assert.ok(code, 'the email service received a sign-in code');
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
  await readyNotebook(visitor.page);
}
async function dismissPasskey(state, page) {
  await page.locator('[data-guest-passkey-prompt]').waitFor({ state: 'visible' });
  await snapshot(state, 'reviewer-passkey-desktop', page);
  await page.locator('[data-guest-passkey-dismiss]').click();
  await page.reload();
  await readyNotebook(page);
  assert.equal(
    await page.locator('[data-guest-passkey-prompt]').isVisible(),
    false,
    'a dismissed passkey prompt stays dismissed after reload',
  );
}
const reopenManager = async board => {
  await board.locator('[data-close]').click();
  await board.evaluate(async () => (await import('/shell/ink/bookinvites.js')).showGuestNotebooks());
  await until(board, 'form.invite');
};
async function watch(board, notebook) {
  if (notebook.kind === 'round') {
    await board.locator('[data-close]').click();
    await board.evaluate(async id => (await import('/shell/ink/bookinvites.js')).showGuestNotebooks(id), notebook.id);
  } else await board.locator(`[data-watch="${notebook.id}"]`).click();
  await board.waitForFunction(name => document.querySelector('.bi-watch h1')?.textContent === name, notebook.name);
  assert.equal(await board.locator('.bi-watch .ng-compose').isVisible(), false);
}

async function roundStory(state, board) {
  const round = await createReviewRound(state, board);
  const shares = (await state.h.board('/api/review/shares')).body;
  for (const person of round.people)
    person.reviewLink = shares.flatMap(share => share.people).find(invited => invited.name === person.name).link;
  await inviteScreens(state, board);
  const ada = await openVisitor(state, { width: 1280, height: 850 });
  const bela = await openVisitor(state, { width: 390, height: 844 });
  await emailSignIn(state, ada, round.people[0].reviewLink);
  await dismissPasskey(state, ada.page);
  await emailSignIn(state, bela, round.people[1].reviewLink);
  assert.equal(await ada.page.locator('#book .bk-page').count(), 1);
  assert.equal(await bela.page.locator('#book .bk-page').count(), 1);
  await addNote(ada.page, 'Give the page title more room');
  await addNote(bela.page, 'The small-screen menu needs a clearer label');
  await drawNote(state, ada.page, round.people[0].page);
  await drawNote(state, bela.page, round.people[1].page);
  await artifactScrap(state, ada, round.people[0].reviewLink, round.people[0].page, 'desktop');
  await artifactScrap(state, bela, round.people[1].reviewLink, round.people[1].page, 'phone');
  console.log('Guest browser: both artifact scraps saved');
  await watch(board, round);
  await board.locator(`[data-page="${round.people[0].page}"]`).click();
  await until(board, '.ng-groups', /Give the page title/);
  await board.locator(`[data-page="${round.people[1].page}"]`).click();
  await until(board, '.ng-groups', /small-screen menu/);
  assert.doesNotMatch(await ada.page.locator('#book').innerText(), /small-screen/);
  assert.doesNotMatch(await bela.page.locator('#book').innerText(), /page title/);
  await snapshot(state, 'round-board-desktop', board);
  console.log('Guest browser: watcher verified');
  await completeRound(state, board, round, ada, bela);
}

async function completeRound(state, board, round, ada, bela) {
  await sendPage(ada.page);
  await undoPage(ada.page);
  await ada.page.locator('#book .bk-island button.bk-send').waitFor({ state: 'visible' });
  await answerDuringRound(state, ada, round.people[0].page, 'desktop');
  await answerDuringRound(state, bela, round.people[1].page, 'phone');
  console.log('Guest browser: both reviewer answers received');
  await sendPage(ada.page);
  await sendPage(bela.page);
  await bela.page.locator('#book .bk-undo').waitFor({ state: 'visible' });
  const closing = (await state.h.board(`/api/notebooks/guests/list?notebook=${round.id}`)).body.notebooks[0];
  assert.equal(closing.state, 'closing');
  await undoPage(bela.page);
  await until(bela.page, '[data-notebook-status]', /round open/);
  await sendPage(bela.page);
  await until(bela.page, '[data-notebook-status]', /Round complete/, 20_000);
  const closed = (await state.h.board(`/api/notebooks/guests/list?notebook=${round.id}`)).body.notebooks[0];
  assert.equal(closed.archived, true);
  assert.ok(closed.deck, 'a completed round queues the deck task');
  assert.equal(closed.pages.length, 2);
  await snapshot(state, 'round-closed-phone', bela.page);
  await reopenManager(board);
}

async function answerDuringRound(state, visitor, page, screen) {
  await sendPage(visitor.page);
  await waitFor(
    async () => {
      const read = (await state.h.board(`/api/notebooks/guests/groups?page=${page}`)).body;
      return read.groups.some(group => group.note);
    },
    'the sent page reaches an agent',
    20_000,
  );
  const group = (await state.h.board(`/api/notebooks/guests/groups?page=${page}`)).body.groups[0];
  await answerNote(state, group.id, 'I will give the heading more room.');
  await until(visitor.page, '#book .bk-answer', /heading more room/);
  await snapshot(state, `round-answer-${screen}`, visitor.page);
  await reopenPage(visitor.page);
  await visitor.page.locator('#book .bk-island button.bk-send').waitFor({ state: 'visible' });
  await until(visitor.page, '#book .bk-answer', /heading more room/);
}

async function invitedStory(state, board) {
  await knownInvitation(state, board);
  const book = await createNotebook(state, board, 'Design notebook', 'Cora');
  assert.equal(book.ends, null);
  const guest = await openVisitor(state, { width: 390, height: 844 }, '', state.browser, true);
  state.recording = guest.page.video();
  await passkeyStory(state, guest, book);
  await addNote(guest.page, 'Could the menu be easier to find');
  await drawNote(state, guest.page, book.pages[0].id);
  await watch(board, book);
  await until(board, '.ng-groups', /menu be easier/);
  await board.locator('.ng-ink').first().waitFor({ state: 'visible' });
  await sendPage(guest.page);
  await guest.page.waitForFunction(() => document.querySelectorAll('#book .bk-page').length === 2);
  const groups = (await state.h.board(`/api/notebooks/guests/groups?page=${book.pages[0].id}`)).body.groups;
  await answerNote(state, groups[0].id, 'I will make the menu label clearer.');
  await firstPage(guest.page);
  await until(guest.page, '#book .bk-answer', /make the menu label clearer/);
  await until(board, '.ng-answer', /make the menu label clearer/);
  await snapshot(state, 'invited-answer-phone', guest.page);
  await snapshot(state, 'invited-watching-desktop', board);
  const overflow = await guest.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'the phone page stays inside its viewport');
  return { book, cookies: await guest.context.cookies() };
}

async function passkeyStory(state, guest, book) {
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
  await guest.page.locator('#book .bk-lip').click();
  await guest.page.waitForFunction(() => document.documentElement.dataset.book === 'folded');
  await snapshot(state, 'invited-passkey-phone', guest.page);
  await guest.page.locator('[data-guest-passkey="enroll"]').click();
  await until(guest.page, '[data-guest-passkey-prompt]', /Passkey saved/);
  await guest.context.clearCookies();
  await guest.page.goto(state.origin + new URL(book.people[0].link).pathname);
  await guest.page.locator('[data-guest-passkey="login"]').click();
  await guest.page.locator('a[href*="/guest/notebooks/"]').first().waitFor();
  await guest.page.locator('a[href*="/guest/notebooks/"]').first().click();
  await readyNotebook(guest.page);
  assert.equal(
    (await guest.context.cookies()).some(cookie => cookie.name === 's'),
    false,
  );
}

async function answerNote(state, group, text) {
  const { SEND_MS } = await import('../coordinator/src/ink/booknotes.ts');
  const sheets = await import('../coordinator/src/ink/booksheets.ts');
  sheets.deliverDue(Date.now() + SEND_MS);
  const note = state.h.db
    .prepare(
      `select g.page, n.review, s.job from notebook_groups g join book_notes n on n.id = g.note
    join book_sheets s on s.id = n.sheet where g.id = ?`,
    )
    .get(group);
  console.log('Guest browser: answer job queued');
  const job = await state.h.claimJob(note.job);
  console.log('Guest browser: answer job claimed');
  assert.equal((await state.h.agent('answer', job.token, { note: note.review, text })).status, 200);
  await state.h.finish(job);
  const read = (await state.h.board(`/api/notebooks/guests/groups?page=${note.page}`)).body;
  assert.ok(
    read.groups.find(g => g.id === group).children.some(child => child.kind === 'answer' && child.text === text),
  );
  console.log('Guest browser: answer job finished');
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
    await readyNotebook(tablet.page);
    await firstPage(tablet.page);
    await until(tablet.page, '#book .bk-answer', /make the menu label clearer/);
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
  ['nl', 'Dora', 'Je eigen notitieboek', 'Notitieboek openen', 'Je notitieboeken'],
  ['de', 'Ella', 'Dein eigenes Notizbuch', 'Notizbuch öffnen', 'Deine Notizbücher'],
];
async function languageStories(state) {
  const job = await state.h.start({ agent: 'vera' });
  for (const check of languageChecks) await languageStory(state, job, check);
  await state.h.finish(job);
}

async function languageStory(state, job, [lang, name, intro, open, label]) {
  const book = await languageNotebook(state, job, lang, name, label);
  const visitor = await openVisitor(state, { width: 390, height: 844 });
  await emailSignIn(state, visitor, book.people[0].link);
  const page = visitor.page;
  assert.equal(await page.locator('html').getAttribute('lang'), lang);
  await addNote(page, 'A guest note');
  await drawNote(state, page, book.pages[0].id);
  await selectionAndPrefs(page);
  await sendPage(page);
  // the shell's own words in theirs: Send's toast, and below an agent's name marked as an AI's and the reply prompt
  const toastWords = await named(page, '<b>Sent.</b> It goes in 10 seconds: tap to undo');
  await until(page, '#toasts .toast', new RegExp(RegExp.escape(toastWords.replace(/<\/?b>/g, ''))));
  await page.waitForFunction(() => document.querySelectorAll('#book .bk-page').length === 2);
  await untitledPage(page);
  const groups = (await state.h.board(`/api/notebooks/guests/groups?page=${book.pages[0].id}`)).body.groups;
  await answerNote(state, groups[0].id, 'An answer for the guest');
  await firstPage(page);
  await until(page, '#book .bk-answer', /An answer for the guest/);
  const head = await page.locator('#book .bk-answer-name').first().innerText();
  assert.ok(head.endsWith(` · ${words[lang].aiAgent}`), head);
  const prompt = await page.locator('#book .bk-answer-reply').first().getAttribute('aria-label');
  assert.equal(prompt, (await named(page, 'Write your reply to {name} here')).replace('{name}', head.split(' · ')[0]));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await snapshot(state, `guest-language-${lang}-phone`, page);
  await page.goto(state.origin + new URL(book.people[0].link).pathname);
  await until(page, '.intro', new RegExp(intro));
  assert.equal(await page.locator('a[href$="/go"]').innerText(), open);
  assert.equal(await page.locator('a[href*="/guest/notebooks/"]').innerText(), label);
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
