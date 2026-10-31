// Shared Ink controls for the real-coordinator guest browser journeys in bookguests.mjs.
import assert from 'node:assert/strict';
import { until } from '../../shared/browser/browser.mjs';
import { pen } from './booknotebookscreen.mjs';
import { until as waitFor } from './bookkit.mjs';
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
    .getByRole('button', { name: await named(page, 'Text'), exact: true })
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

// The select tool's bar round the lassoed note and lines, and the cog's card, in the guest's words
export async function selectionAndPrefs(page) {
  const book = page.locator('#book');
  await book.getByRole('button', { name: await named(page, 'Select'), exact: true }).click();
  const [from, to] = await aroundUnits(page);
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 12 });
  await page.mouse.up();
  const bar = page.getByRole('toolbar', { name: await named(page, 'Selection'), exact: true });
  await bar.waitFor();
  const acts = await Promise.all(['Cut', 'Copy', 'Duplicate', 'Delete'].map(en => named(page, en)));
  assert.deepEqual(await bar.locator('button:not([hidden])').allInnerTexts(), acts);
  await page.keyboard.press('Escape');
  const cog = await named(page, 'Preferences on this device');
  await book.getByRole('button', { name: cog, exact: true }).click();
  const card = await page.getByRole('dialog', { name: cog, exact: true }).innerText();
  for (const en of ['On this device', 'When pen is active, touch always pans', 'Voice note hold time', 'Short', 'Long'])
    assert.ok(card.includes(await named(page, en)), `${en} in ${card}`);
  await page.keyboard.press('Escape');
}

// A box round everything on the page, just above its first unit and below its last (the page is as tall as what's on
// it), clear of the screen's edge, where a drag folds the book away
const aroundUnits = page =>
  page.evaluate(() => {
    const paper = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
    const units = [...paper.querySelectorAll('.bk-unit')].map(unit => unit.getBoundingClientRect());
    const edge = paper.getBoundingClientRect();
    return [
      [edge.left + 50, Math.min(...units.map(unit => unit.top)) - 10],
      [edge.right - 30, Math.max(...units.map(unit => unit.bottom)) + 10],
    ];
  });

// The new page after a send, untitled: its name in the bar and the pages menu, and the title field, in the guest's words
export async function untitledPage(page) {
  const untitled = await named(page, 'Untitled page');
  await until(page, '#book .bk-where', new RegExp(RegExp.escape(untitled)));
  await page.locator('#book .bk-where').click();
  const field = page.getByRole('textbox', { name: await named(page, 'Page title'), exact: true });
  assert.equal(await field.getAttribute('placeholder'), untitled);
  await page.getByRole('menu', { name: await named(page, 'Pages'), exact: true }).waitFor();
  assert.ok((await page.locator('#book .bk-pages-menu').innerText()).includes(untitled));
  await field.press('Escape');
}
