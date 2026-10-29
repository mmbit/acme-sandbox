// Guest and Reviews invitations through their shared controls, on desktop and phone.
import assert from 'node:assert/strict';
import { until } from '../../shared/browser/browser.mjs';
export async function createNotebook(state, board, name, person) {
  await board.locator('form.invite [name=name]').fill(person);
  await board.locator('form.invite [name=email]').fill(`${person.toLowerCase()}@example.org`);
  await board.locator('[name=notebookName]').fill(name);
  const held = Promise.withResolvers();
  state.invitationReady = held.promise;
  await board.locator('form.invite [type=submit]').click();
  try {
    assert.equal(await board.locator('form.invite [type=submit]').isDisabled(), true);
    for (const button of await board.locator('form.invite [data-again]').all())
      assert.equal(await button.isDisabled(), true);
  } finally {
    held.resolve();
    state.invitationReady = null;
  }
  await until(board, '.bi-list', new RegExp(name));
  const listed = await state.h.board('/api/notebooks/guests/list');
  const notebook = listed.body.notebooks.find(book => book.name === name);
  assert.ok(notebook);
  return notebook;
}

export async function inviteScreens(state, board) {
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await board.setViewportSize(viewport);
    await board.goto(`${state.origin}/?intro=0`);
    await readyHQ(board);
    await board.evaluate(async () => {
      (await import('/shell/ink/book.js')).foldBook();
      (await import('/shell/desk.js')).openComputer('notes', { shown: 'shared' });
    });
    await settledBook(board, 'folded');
    await board.locator('.notes.share details > summary').first().click();
    await board.locator('.notes.share form.invite').first().waitFor();
    await snapshot(state, `reviews-invite-${viewport.width}`, board);
    await board.evaluate(async () => {
      (await import('/shell/desk.js')).closeTool();
      (await import('/shell/ink/book.js')).openBook();
    });
    await settledBook(board, 'open');
    await board.getByRole('button', { name: "The overview: the notebook's pages, and the Shelf", exact: true }).click();
    await settledTurn(board);
    await board.locator('[data-go=shelf]').click();
    await settledTurn(board);
    await board.locator('[data-invite]').click();
    await board.locator('form.invite').waitFor();
    assert.equal(await board.locator('[name=kind], [name=days], [name=colleagues], [data-add]').count(), 0);
    assert.equal(await board.evaluate(() => document.querySelector('dialog').scrollWidth > innerWidth), false);
    await board
      .locator('dialog.bi-dialog')
      .evaluate(dialog => Promise.all(dialog.getAnimations().map(animation => animation.finished)));
    await snapshot(state, `notebook-invite-${viewport.width}`, board);
  }
  await board.setViewportSize({ width: 1440, height: 960 });
}

const snapshot = async (state, name, page) => state.shots && page.screenshot({ path: `${state.shots}/${name}.png` });

export async function reviewInvite(state, board) {
  await board.evaluate(async preview => {
    document.querySelector('dialog')?.close();
    const { shareHtml, wireShare, loadRecent } = await import('/shell/desk.js');
    await loadRecent();
    const host = document.createElement('dialog');
    host.className = 'device';
    host.style.margin = 'auto';
    host.style.padding = '0';
    host.style.background = 'var(--deep)';
    document.body.append(host);
    host.showModal();
    let share = null;
    const draw = next => {
      share = next;
      host.innerHTML =
        '<header><b>Outside notes</b></header><div class="crt"><div class="screen"><section class="notes">' +
        shareHtml(share) +
        '</section></div></div>';
      wireShare(host, share, { page: `https://hello${preview}/`, kind: 'notes', days: () => 3, redraw: draw });
    };
    draw(null);
  }, state.preview);
}
export async function knownInvitation(state, board) {
  await board.locator('[data-again="Ada"]').click();
  await until(board, '.bi-list', /Ada/);
  const book = (await state.h.board('/api/notebooks/guests/list')).body.notebooks.find(
    book => book.kind === 'invited' && book.name === 'Ada',
  );
  assert.ok(book, 'a known name creates its permanent notebook without retyping the email');
  assert.equal(book.ends, null);
}

export async function createReviewRound(state, board) {
  await reviewInvite(state, board);
  for (const person of ['Ada', 'Bela']) {
    await board.locator('form.invite [name=name]').fill(person);
    await board.locator('form.invite [name=email]').fill(`${person.toLowerCase()}@example.org`);
    await board.locator('form.invite [type=submit]').click();
    await until(board, '.invites ul', new RegExp(person));
  }
  const round = (await state.h.board('/api/notebooks/guests/list')).body.notebooks.find(book => book.kind === 'round');
  assert.ok((await state.h.board('/api/notebooks')).body.shelf.some(book => book.id === round.id));
  await board.evaluate(() => document.querySelector('dialog[open]').remove());
  await board.evaluate(async () => (await import('/shell/ink/bookinvites.js')).showGuestNotebooks());
  return round;
}

function settledBook(page, mode) {
  return page.waitForFunction(
    mode =>
      (document.documentElement.dataset.book === mode ||
        (mode === 'open' && document.documentElement.dataset.book === 'spread')) &&
      getComputedStyle(document.body).filter === 'none' &&
      getComputedStyle(document.body).opacity === '1',
    mode,
  );
}
function settledTurn(page) {
  return page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture'));
}

export async function readyHQ(page) {
  await until(page, '#book');
  await page.waitForFunction(async () => Boolean((await import('/shell/stage.js')).look));
}
