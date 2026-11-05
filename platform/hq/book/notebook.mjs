// book-check.mjs's stories of the Notebook's page (shell/ink/bookgroups.js, booksave.js, bookpagesend.js,
// bookscrapopen.js, bookscrapkeys.js), on the played Notebook seeded as dev mode's (mock/notebook.json: My journal's
// three pages, the first sent with an answer under its scrap):
//   - an iPad mini, the Pencil and a finger: every group a scrap's card; one thrown away from its opened sheet's ⋯,
//     crumpling, with Undo; two lines in a new scrap made by a tap on a blank page, one group, kept as it's put back;
//     torn to Submit, sent at once and stamped where it is, no page made, nothing written in its scraps kept. Recorded
//     with --shots.
//   - a desktop, a mouse: Move to page… from Select's bar in an opened scrap, and Undo; a group made on another screen
//     drawn here as the store tells of it; a line added to a scrap another screen changed meanwhile, refused (409),
//     kept and saved anew once the page is read again; a save the store refuses (503) said, Submit sending nothing
//     while it still refuses, and the page saved and sent once it's back.
// (No drawing on the grid itself and no joining of lines by nearness: every line is drawn in an opened scrap.
// (No scratch-out: a scrap is deleted from its sheet's ⋯, as the iPad's story throws one away.
// The phone story: notebookphone.mjs.
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { clipped, onPaper, pen, stamp, tool, turnTo, where } from './notebookscreen.mjs';
import { DESKTOP, MINI, closeScrap, crumpled, fellAway, middleOf, openScrap, until } from './kit.mjs';
import { press } from './bar.mjs';
import { dragTo } from './tearing.mjs';
import { hands } from './hands.mjs';
import { watchedPage } from './start.mjs';

const SEED = JSON.parse(await readFile(new URL('../mock/notebook.json', import.meta.url), 'utf8'));
// the seed's pages, and its groups on the newest (mock/notebook.json)
const SENT = 1,
  SECOND = 2,
  NEWEST = 3;
const WAVE = 9,
  ROWS = 10;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots (the stills' folder, or null)
export function notebookStories(c) {
  return {
    "the Notebook on an iPad mini: each group a unit, thrown away from its opened scrap's ⋯ and Undo, lines in a new scrap, torn to Submit, the sent page stamped and kept":
      browser => onMini(browser, c),
    "the Notebook on a desktop: Move to page… in an opened scrap and Undo, another screen's group drawn, a refused edit kept, a failed save tried again by Submit":
      browser => onDesktop(browser, c),
  };
}

// ---- the stories

async function onMini(browser, c) {
  const { page, play, errors, done } = await open(browser, c, MINI, { hasTouch: true, record: 'notebook-ipad-mini' });
  try {
    assert.deepEqual(
      await clipped(page),
      groupsOn(play, NEWEST)
        .map(g => g.id)
        .sort((a, b) => a - b),
      'each group a unit on the page',
    );
    await c.shot('notebook-mini-open', page);
    const { pen: hand } = await hands(page);
    await throwAndUndo(page, play, c, hand);
    await linesInScrap(page, play, c, hand);
    await torn(page, play, c, hand);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot('notebook-mini-failed', page);
    throw e;
  } finally {
    await done();
  }
}

async function throwAndUndo(page, play, c, hand) {
  // Throw scrap away from the opened scrap's ⋯: the sheet put back, its card gone at once, crumpling, gone from the
  // store, back with Undo
  const { gid } = await openScrap(page, hand, WAVE);
  assert.equal(gid, WAVE, 'the scrap tapped is the one opened');
  await hand.tap(middleOf(await page.locator('#book .bk-sheet-keys .bk-scrap-more').boundingBox()));
  const menu = page.locator('#book > .bk-scrap-menu');
  await menu.waitFor();
  await c.shot('notebook-mini-menu', page);
  const fall = crumpled(page);
  fall.catch(() => {}); // a failure below shows first; awaiting it later still throws
  await hand.tap(middleOf(await menu.locator('[data-act="drop"]').boundingBox()));
  const answer = await fall;
  assert.ok(!(await clipped(page)).includes(WAVE), 'its card goes with its group at once');
  fellAway(answer, 'the group');
  assert.ok(answer.length <= 2000, `over within two seconds (${answer.length} ms)`);
  await page.locator('#toasts .toast', { hasText: 'Deleted' }).waitFor();
  await until(() => !ids(play, NEWEST).includes(WAVE), 'the group deleted in the store');
  await c.shot('notebook-mini-deleted', page);
  await page.locator('#book').getByRole('button', { name: 'Undo' }).filter({ visible: true }).first().tap();
  await until(() => ids(play, NEWEST).includes(WAVE), 'Undo restores it in the store');
  await until(async () => (await clipped(page)).includes(WAVE), 'and its card is back');
}

async function linesInScrap(page, play, c, hand) {
  // a tap on a blank page (New page's) makes a scrap and opens it: two lines in it, its one group, kept as it's put
  // back
  await press(page, 'New page');
  await until(async () => !(await clipped(page)).length, 'a blank page shown');
  const desk = await page.locator('#book .bk-desk').boundingBox(),
    { sheet } = await openScrap(page, hand, undefined, [desk.x + 120, desk.y + 200]),
    // (in the scrap's own px, as zoomed as it opens)
    [[x0], [x1]] = await onPaper(page, [
      [0, 0],
      [1, 0],
    ]),
    on = points => points.map(([x, y]) => [sheet.x + 40 + x * (x1 - x0), sheet.y + 80 + y * (x1 - x0)]);
  await tool(page, 'Pen');
  await pen(
    page,
    on([
      [20, 20],
      [50, 27],
      [75, 23],
    ]),
  );
  await pen(
    page,
    on([
      [92, 21],
      [120, 25],
      [145, 22],
    ]),
  );
  const blank = await until(() => pagesOf(play).find(p => p.id > NEWEST)?.id, 'the blank page kept with its lines'),
    made = await until(() => {
      const [only, ...more] = ids(play, blank);
      return !more.length && group(play, only)?.ink.length === 2 && only;
    }, 'one group for the two lines');
  await c.shot('notebook-mini-lines', page);
  await closeScrap(page, hand);
  await until(async () => (await clipped(page)).includes(made), 'its card on the grid as it is put back');
  assert.deepEqual(ids(play, blank), [made], 'the scrap kept, its lines in it');
  assert.equal(group(play, made).ink.length, 2, 'both lines kept');
  await turnTo(page, NEWEST);
}

// Torn to Submit with a finger: sent at once, the page stays shown and stamped, no page made; nothing written in a
// scrap opened on it is kept
async function torn(page, play, c, hand) {
  const n = pagesOf(play).length,
    at = await where(page);
  await dragTo(page, 'touch', 'submit');
  await until(() => pageOf(play, NEWEST).sent, 'sent at once');
  await until(async () => /^Sent /.test(await stamp(page)), 'the page stamped where it is');
  assert.equal(await where(page), at, 'the page stays shown');
  assert.equal(pagesOf(play).length, n, 'no page made');
  await c.shot('notebook-mini-sending', page);
  // (a scrap whose card shows whole on the iPad: ROWS's runs under the bar.)
  const kept = JSON.stringify(groupsOn(play, NEWEST)),
    { sheet } = await openScrap(page, hand, WAVE);
  await pen(page, [
    [sheet.x + 60, sheet.y + sheet.height / 2],
    [sheet.x + 160, sheet.y + sheet.height / 2 + 5],
  ]);
  await page.waitForTimeout(1200);
  await c.shot('notebook-mini-sent', page);
  await closeScrap(page, hand);
  await page.waitForTimeout(600);
  assert.equal(JSON.stringify(groupsOn(play, NEWEST)), kept, 'nothing written on a sent page is kept');
}

async function onDesktop(browser, c) {
  const { page, play, errors, done } = await open(browser, c, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 });
  const mouse = { tap: ([x, y]) => page.mouse.click(x, y) };
  try {
    await moveAndUndo(page, play, mouse);
    await otherScreen(page, play);
    await refusedEdit(page, play, c, mouse);
    await failedSave(page, play, mouse);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot('notebook-desktop-failed', page);
    throw e;
  } finally {
    await done();
  }
}

async function moveAndUndo(page, play, mouse) {
  // the wave opened, everything in it picked, Move to page… on Select's bar: onto the page before, its card gone here;
  // Undo brings it back
  const { gid, sheet } = await openScrap(page, mouse, WAVE);
  assert.equal(gid, WAVE, 'the scrap clicked is the one opened');
  await tool(page, 'Select');
  await page.mouse.move(sheet.x + sheet.width / 3, sheet.y + sheet.height / 2);
  await page.keyboard.press('Control+a');
  await page.locator('#book .bk-sel-bar').getByRole('button', { name: 'Move to page…', exact: true }).click();
  await page.locator(`#book [role=menu] [data-page="${SECOND}"]`).click();
  await until(() => group(play, WAVE)?.page === SECOND, 'the group moved in the store');
  // (Undo while it's open: the move is the opened scrap's step, as its lines are)
  await page.mouse.move(sheet.x + sheet.width / 3, sheet.y + sheet.height / 2);
  await page.keyboard.press('Control+z');
  await until(() => group(play, WAVE)?.page === NEWEST, 'Undo moves it back');
  await closeScrap(page, mouse);
  await until(async () => (await clipped(page)).includes(WAVE), 'its card back here');
}

async function otherScreen(page, play) {
  // another screen makes a group of two lines: its card drawn here once the store tells of it
  const line = {
    points: [
      [620, 200, 0.5, 0],
      [700, 240, 0.5, 40],
      [760, 210, 0.5, 80],
    ],
    size: 3,
    color: '#2f6bdc',
  };
  const under = { ...line, points: line.points.map(([x, y, ...more]) => [x, y + 60, ...more]) };
  const theirs = play.route('/api/notebooks/groups/create', {}, { page: NEWEST, ink: [line, under] });
  await until(async () => (await clipped(page)).includes(theirs.id), "another screen's group drawn here");
}

async function refusedEdit(page, play, c, mouse) {
  // a line added in the opened rows while another screen changes them: refused, read again, the line kept and saved
  // anew
  const refused = [];
  page.on('response', r => r.status() === 409 && refused.push(r.url()));
  const rows = group(play, ROWS),
    { gid, sheet } = await openScrap(page, mouse, ROWS);
  assert.equal(gid, ROWS, 'the scrap clicked is the one opened');
  await tool(page, 'Pen');
  await pen(page, lineIn(sheet), page.mouse);
  play.route(
    '/api/notebooks/groups/edit',
    {},
    {
      id: ROWS,
      since: rows.updated,
      ink: rows.ink.slice(0, -1),
      texts: rows.texts,
      pictures: rows.pictures,
    },
  );
  await until(() => refused.length, 'the edit refused');
  await until(() => added(play, ROWS, rows.ink), 'the line saved anew once the page is read again');
  assert.ok(
    rows.ink.slice(0, -1).every(s => group(play, ROWS).ink.some(t => near(t.points[0], s.points[0], 0.01))) &&
      !group(play, ROWS).ink.some(t => near(t.points[0], rows.ink.at(-1).points[0], 0.01)),
    "the other screen's change kept",
  );
  await c.shot('notebook-desktop-synced', page);
  await closeScrap(page, mouse);
}

// A line drawn in the opened wave while the store refuses: its save fails, said on the page, and Submit, trying it
// again, sends nothing while the store still refuses (the store's older groups would go in its place); once the store
// answers, Submit saves the line and sends the page.
async function failedSave(page, play, mouse) {
  const had = group(play, WAVE).ink,
    down = r => r.fulfill({ status: 503, json: { error: 'The store is busy' } });
  await page.route('**/api/notebooks/groups/*', down);
  const { sheet } = await openScrap(page, mouse, WAVE);
  await tool(page, 'Pen');
  await pen(page, lineIn(sheet), page.mouse);
  await page.locator('#book .bk-refusal:not([hidden])').first().waitFor();
  await closeScrap(page, mouse);
  await dragTo(page, 'mouse', 'submit');
  await page.waitForTimeout(1500);
  assert.ok(!pageOf(play, NEWEST).sent, 'a page whose save failed again is not sent');
  await page.unroute('**/api/notebooks/groups/*', down);
  await dragTo(page, 'mouse', 'submit');
  await until(() => pageOf(play, NEWEST).sent, 'the page sent once the store answers');
  assert.ok(added(play, WAVE, had), 'with the line its failed save held');
}

// ---- HQ, the book open on the seeded Notebook's newest page

// HQ at a size on the played Notebook seeded as dev mode's, the groups drawn (folded: tapped open from its tab). (also
// notebookasks.mjs's and notebookrow.mjs's)
// (look: HQ's look asked for, '&renderer=wire' or '&renderer=holo'; Brownstone with none.)
export async function open(browser, c, viewport, { record, folded, look = '', ...more }) {
  const video = record && c.shots ? { recordVideo: { dir: c.shots, size: viewport } } : {};
  const context = await c.hqIn(browser, viewport, { notebooks: structuredClone(SEED), ...more, ...video });
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0${look}`);
  await page.waitForSelector('#book .bk-desk', { state: 'attached', timeout: 30_000 });
  if (folded) {
    await c.settled(page, 'folded');
    await page.locator('#book .bk-lip').tap();
  }
  await c.settled(page, folded ? 'spread' : 'open');
  await until(async () => (await clipped(page)).length, 'the groups drawn');
  return {
    page,
    play: context.notebook,
    errors,
    done: async () => {
      const film = page.video();
      await context.close();
      if (film) await rename(await film.path(), `${c.shots}/${record}.webm`);
    },
  };
}

// ---- the played store

const groupsOn = (play, page) => play.route('/api/notebooks/pages/groups', { page }).groups;
// (also notebookselect.mjs's)
export const ids = (play, page) => groupsOn(play, page).map(g => g.id);
export const group = (play, id) =>
  [SENT, SECOND, NEWEST, ...pagesOf(play).map(p => p.id)].flatMap(p => groupsOn(play, p)).find(g => g.id === id);
const pagesOf = play => play.route('/api/notebooks/pages', { notebook: 1 }).pages;
const pageOf = (play, id) => pagesOf(play).find(p => p.id === id);
const near = ([x, y], [x1, y1], px = 4) => Math.abs(x - x1) <= px && Math.abs(y - y1) <= px;
// A line across an opened scrap's sheet (its box on the screen), low in it, clear of its keys and the tools at its right
const lineIn = sheet => [0, 1, 2].map(i => [sheet.x + 80 + i * 50, sheet.y + sheet.height * 0.7 + (i % 2) * 4]);
// Whether a group the store keeps has a line none of had (its lines before) starts at
const added = (play, id, had) => group(play, id)?.ink.some(s => !had.some(t => near(t.points[0], s.points[0], 0.01)));
