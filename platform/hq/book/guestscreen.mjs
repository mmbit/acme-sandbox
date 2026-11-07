// Shared Ink controls for the real-coordinator guest browser journeys in guests.mjs.
import assert from 'node:assert/strict';
import { pen } from './notebookscreen.mjs';
import { until as waitFor, openScrap, closeScrap, middleOf } from './kit.mjs';
import { mouseOf } from './hands.mjs';
import { words } from '../shell/ink/notebookwords.js';

// A control of the book by its key in the guest words, as the guest's page says it
export const named = async (page, key) => words[await page.locator('html').getAttribute('lang')][key];

export async function readyNotebook(page) {
  await page.locator('#book .bk-desk').waitFor({ state: 'attached' });
  if ((await page.locator('html').getAttribute('data-book')) === 'folded') await page.locator('#book .bk-lip').click();
  await page.waitForFunction(() => ['open', 'spread'].includes(document.documentElement.dataset.book));
  await page.locator('#book .bk-page:not([hidden])').first().waitFor();
  assert.equal(await page.locator('#book [data-go=shelf], #book [data-invite]').count(), 0);
  assert.equal(await page.locator('a[href*="/guest/sketchbook/"]').count(), 0);
}

// The tools are an opened scrap's (Ink's README, The board's rules), so each step below opens one with the mouse and
// puts it back with Klaar: a typed note in a new scrap, made by a click on the bare grid under what's on the page. Its
// scrap's group id, for the steps after it.
export async function addNote(page, words) {
  // (on a bare page, the paper's middle, clear of its head. Otherwise 40 px under what's on it: the page is only as tall
  // as its content.)
  const desk = await page.locator('#book .bk-desk').boundingBox();
  const [x, y] = middleOf(desk);
  const at = [x, Math.max(y, (await underWords(page)) + 40)];
  const { gid, sheet } = await openScrap(page, mouseOf(page), undefined, at);
  await tool(page, 'toolText');
  await page.mouse.click(sheet.x + sheet.width * 0.3, sheet.y + 60);
  const field = page.locator('#book .bk-typed-words[contenteditable]');
  await field.fill(words);
  await field.press('Escape');
  await page.locator('#book .bk-typed').filter({ hasText: words }).first().waitFor();
  await closeScrap(page, mouseOf(page));
  return gid;
}

export async function sendPage(page) {
  const response = page.waitForResponse(
    response => response.url().endsWith('/guest/notebooks/api/pages/send') && response.request().method() === 'POST',
  );
  await page.locator('#book .bk-bar [data-island=send] .bk-send').click();
  const sent = await response;
  assert.equal(sent.status(), 200, 'the page is sent');
}
export const undoPage = page => page.locator('#book .bk-undo').click();
export const reopenPage = page => page.locator('[data-notebook-undo]').click();
export const snapshot = async (state, name, page) =>
  state.shots && page.screenshot({ path: `${state.shots}/${name}.png` });

// The page's arrows and where it is between them in the bar's middle, where they show (the screen's px), and whether
// Send shows (on the bar's right, before the dots); once the bar is laid out, the three in a row.
export async function arrowsOf(page) {
  await page.waitForFunction(() => {
    const tops = [...document.querySelectorAll('#book .bk-bar [data-island=pages] > *')].map(
      b => b.getBoundingClientRect().top,
    );
    return tops.length === 3 && tops.every(top => top === tops[0]);
  });
  return page.evaluate(() => ({
    send: !!document.querySelector('#book .bk-send')?.checkVisibility({ visibilityProperty: true }),
    arrows: [...document.querySelectorAll('#book .bk-bar [data-island=pages] > *')].map(b => {
      const r = b.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }),
  }));
}

export async function firstPage(page) {
  await page.locator('#book .bk-where').click();
  await page.locator('#book .bk-pages-menu [data-i="0"]').click();
  await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture'));
}

// Two lines drawn with the pen under the note in its scrap (gid: addNote's)
export async function drawNote(state, page, pageId, gid) {
  const { sheet } = await openScrap(page, mouseOf(page), gid);
  await tool(page, 'toolPen');
  const below = await page.evaluate(() =>
    Math.max(
      ...[...document.querySelectorAll('#book .bk-page[data-focus] .bk-typed')].map(
        t => t.getBoundingClientRect().bottom,
      ),
    ),
  );
  const [left, right] = [0.3, 0.7].map(across => sheet.x + sheet.width * across);
  for (const y of [below + 30, below + 60])
    await pen(
      page,
      [
        [left, y],
        [right, y],
      ],
      page.mouse,
    );
  await waitFor(async () => {
    const contents = (await state.h.board(`/api/notebooks/guests/groups?page=${pageId}`)).body;
    return contents.groups.reduce((total, group) => total + group.ink.length, 0) === 2;
  }, 'both drawing strokes saved');
  const groups = (await state.h.board(`/api/notebooks/guests/groups?page=${pageId}`)).body.groups;
  assert.equal(
    groups.reduce((total, group) => total + group.ink.length, 0),
    2,
    'both drawing strokes are saved',
  );
  await closeScrap(page, mouseOf(page));
}

// The bottom of the lowest thing written on the page, typed or drawn
const underWords = page =>
  page.evaluate(() => {
    const paper = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
    return Math.max(...[...paper.querySelectorAll('.bk-typed, .bk-unit')].map(el => el.getBoundingClientRect().bottom));
  });

// The select tool's bar round the note and lines in their scrap, all picked by the keys, and the preferences' card
// from the page bar's dots, in the guest's words (gid: addNote's)
export async function selectionAndPrefs(page, gid) {
  await openScrap(page, mouseOf(page), gid);
  await tool(page, 'toolSelect');
  await page.keyboard.press('ControlOrMeta+a');
  const bar = page.getByRole('toolbar', { name: await named(page, 'selection'), exact: true });
  await bar.waitFor();
  // (the lines have a place in the scrap's stack, so forward and backward show)
  const acts = await Promise.all(
    ['duplicate', 'forward', 'backward', 'moveToPage', 'delete'].map(key => named(page, key)),
  );
  const labels = await bar.locator('button:not([hidden])').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')));
  assert.deepEqual(labels, acts);
  await page.keyboard.press('Escape');
  await closeScrap(page, mouseOf(page));
  const cog = await named(page, 'preferences');
  await page.locator('#book .bk-bar .bk-more').click();
  await page.locator('#book .bk-more-card').getByRole('menuitem', { name: cog, exact: true }).click();
  const card = await page.getByRole('dialog', { name: cog, exact: true }).innerText();
  for (const key of ['onThisDevice', 'penPans']) assert.ok(card.includes(await named(page, key)), `${key} in ${card}`);
  await page.keyboard.press('Escape');
}
const tool = async (page, key) =>
  page
    .locator('#book')
    .getByRole('button', { name: await named(page, key), exact: true })
    .click();

// The new page after a send, untitled: its name in the bar and the pages menu, and the title field Rename page opens,
// in the guest's words
export async function untitledPage(page) {
  const untitled = await named(page, 'untitledPage');
  // (the bar's page button shows where it is, its name is in its label.)
  await page.waitForFunction(
    name => document.querySelector('#book .bk-where')?.getAttribute('aria-label').includes(name),
    untitled,
  );
  await page.locator('#book .bk-where').click();
  await page.getByRole('menu', { name: await named(page, 'pages'), exact: true }).waitFor();
  assert.ok((await page.locator('#book .bk-pages-menu').innerText()).includes(untitled));
  await page.keyboard.press('Escape');
  await page.locator('#book .bk-more').click();
  await page.getByRole('menuitem', { name: await named(page, 'renamePage'), exact: true }).click();
  const field = page.getByRole('textbox', { name: await named(page, 'pageTitle'), exact: true });
  assert.equal(await field.getAttribute('placeholder'), untitled);
  await field.press('Escape');
}

// A visitor's page let go, its routes first: a route still fetching when its context closes throws "Response has been
// disposed".
export async function closeVisitor(visitor) {
  await visitor.context.unrouteAll({ behavior: 'ignoreErrors' });
  await visitor.context.close();
}

// A guest signed in by the code mailed to them, their book open
export async function emailSignIn(state, visitor, link) {
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
