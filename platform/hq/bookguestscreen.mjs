// Shared Ink controls for the real-coordinator guest browser journeys in bookguests.mjs.
import assert from 'node:assert/strict';
import { until } from '../../shared/browser/browser.mjs';
import { pen, until as waitFor } from './booknotebookscreen.mjs';
import { shell } from './shell/ink/notebookshellwords.js';

// A control of the book by its English name, as the guest's page says it (notebookshellwords.js)
export const named = async (page, en) => shell[await page.locator('html').getAttribute('lang')]?.[en] ?? en;

export async function readyNotebook(page) {
  await page.locator('#book .bk-desk').waitFor({ state: 'attached' });
  if ((await page.locator('html').getAttribute('data-book')) === 'folded') await page.locator('#book .bk-lip').click();
  await page.waitForFunction(() => ['open', 'spread'].includes(document.documentElement.dataset.book));
  await page.locator('#book .bk-page:not([hidden])').first().waitFor();
  assert.equal(await page.locator('#book [data-go=shelf], #book [data-invite]').count(), 0);
  assert.equal(await page.locator('a[href*="/guest/sketchbook/"]').count(), 0);
}

export async function addNote(page, words) {
  await page
    .locator('#book')
    .getByRole('button', { name: await named(page, 'Type'), exact: true })
    .click();
  const [x, y] = await pointOnPaper(page, 0.3, 0.3);
  await page.mouse.click(x, y);
  const field = page.locator('#book .bk-typed-words[contenteditable]');
  await field.fill(words);
  await field.press('Escape');
  await until(page, '#book .bk-typed', new RegExp(RegExp.escape(words)));
}

export async function sendPage(page) {
  const response = page.waitForResponse(
    response => response.url().endsWith('/guest/notebooks/api/pages/send') && response.request().method() === 'POST',
  );
  await page.locator('#book .bk-island button.bk-send').click();
  const sent = await response;
  assert.equal(sent.status(), 200, 'the page is sent');
}
export const undoPage = page => page.locator('#book .bk-undo').click();
export const reopenPage = page => page.locator('[data-notebook-undo]').click();
export const snapshot = async (state, name, page) =>
  state.shots && page.screenshot({ path: `${state.shots}/${name}.png` });

export async function firstPage(page) {
  await page.locator('#book .bk-where').click();
  await page.locator('#book .bk-pages-menu [data-i="0"]').click();
  await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture'));
}

export async function drawNote(state, page, pageId) {
  await page
    .locator('#book')
    .getByRole('button', { name: await named(page, 'Pen'), exact: true })
    .click();
  for (const height of [0.45, 0.48]) {
    const left = await pointOnPaper(page, 0.3, height);
    const right = await pointOnPaper(page, 0.7, height);
    await pen(page, [left, right], page.mouse);
  }
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
}

export async function pointOnPaper(page, across, down) {
  return page.evaluate(
    ({ across, down }) => {
      const paper = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden).getBoundingClientRect();
      const desk = document.querySelector('#book .bk-desk').getBoundingClientRect();
      const left = Math.max(paper.left, desk.left) + 50;
      const right = Math.min(paper.right, desk.right, innerWidth) - 50;
      const top = Math.max(paper.top, desk.top) + 60;
      const bottom = Math.min(paper.bottom, desk.bottom, innerHeight) - 100;
      return [left + (right - left) * across, top + (bottom - top) * down];
    },
    { across, down },
  );
}

// The select tool's bar round the lassoed note and lines, their group's clip and menu once Group joins them, and the
// cog's card, in the guest's words
export async function selectionAndPrefs(page) {
  const book = page.locator('#book');
  await book.getByRole('button', { name: await named(page, 'Select'), exact: true }).click();
  const [from, to] = [await pointOnPaper(page, 0.05, 0.1), await pointOnPaper(page, 0.95, 0.5)];
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 12 });
  await page.mouse.up();
  const bar = page.getByRole('toolbar', { name: await named(page, 'Selection'), exact: true });
  await bar.waitFor();
  const acts = await Promise.all(['Cut', 'Copy', 'Duplicate', 'Delete', 'Group'].map(en => named(page, en)));
  assert.deepEqual(await bar.locator('button:not([hidden])').allInnerTexts(), acts);
  await bar.getByRole('button', { name: acts[4], exact: true }).click();
  await page.keyboard.press('Escape');
  const clip = book.getByRole('button', { name: await named(page, 'A group: its menu'), exact: true });
  await clip.click({ position: { x: 10, y: 6 } }); // (its top: the note under the group's corner covers its foot)
  const menu = page.getByRole('menu');
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(), [await named(page, 'Delete')]);
  await page.keyboard.press('Escape');
  const cog = await named(page, 'Preferences on this device');
  await book.getByRole('button', { name: cog, exact: true }).click();
  const card = await page.getByRole('dialog', { name: cog, exact: true }).innerText();
  for (const en of ['On this device', 'When pen is active, touch always pans', 'Voice note hold time', 'Short', 'Long'])
    assert.ok(card.includes(await named(page, en)), `${en} in ${card}`);
  await page.keyboard.press('Escape');
}

// The new page after a send, untitled: its name in the bar and the pages menu, and the title form, in the guest's words
export async function untitledPage(page) {
  const untitled = await named(page, 'Untitled page');
  await until(page, '#book .bk-where', new RegExp(RegExp.escape(untitled)));
  await page.locator('#book .bk-where').click();
  const field = page.getByRole('textbox', { name: await named(page, 'Page title'), exact: true });
  assert.equal(await field.getAttribute('placeholder'), untitled);
  await page.getByRole('button', { name: await named(page, 'Save title'), exact: true }).waitFor();
  assert.ok((await page.locator('#book .bk-pages-menu').innerText()).includes(untitled));
  await field.press('Escape');
}
