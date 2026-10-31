// book-check.mjs's stories of the Notebook's page (shell/ink/bookgroups.js, booksave.js, bookpagesend.js), on the played
// Notebook seeded as dev mode's (mock/notebook.json: My journal's three pages, the first sent with an answer under its
// scrap):
//   - an iPad mini, the Pencil and a finger: every group a scrap unit; Delete (Select's bar)
//     crumpling it with Undo; a line a group of its own, the next near it joining it; a scratch-out deleting it; torn
//     to Submit, sent at once and stamped where it is, no page made, nothing written on it kept. Recorded with
//     --shots.
//   - a desktop, a mouse: Move to page… and Undo; a group made on another screen drawn here as the store tells of it; a line added to a
//     group another screen changed meanwhile, refused (409), kept and saved anew once the page is read again; a save
//     the store refuses (503) said, Submit sending nothing while it still refuses, and the page saved and sent once
//     it's back.
// The phone story: booknotebookphone.mjs.
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import {
  clearPlace,
  clipped,
  fromBar,
  inSight,
  onPaper,
  pen,
  stamp,
  tool,
  turnTo,
  where,
} from './booknotebookscreen.mjs';
import { DESKTOP, MINI, crumpled, until } from './bookkit.mjs';
import { press } from './bookbar.mjs';
import { dragTo } from './bookshare.mjs';

const SEED = JSON.parse(await readFile(new URL('./mock/notebook.json', import.meta.url), 'utf8'));
// the seed's pages, and its groups on the newest (mock/notebook.json)
const SENT = 1,
  SECOND = 2,
  NEWEST = 3;
const WAVE = 9,
  ROWS = 10;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots (the stills' folder, or null)
export function notebookStories(c) {
  return {
    "the Notebook on an iPad mini: each group a unit, Delete from Select's bar and Undo, a line its own group, a scratch-out, torn to Submit, the sent page stamped and kept":
      browser => onMini(browser, c),
    "the Notebook on a desktop: Move to page… and Undo, another screen's group drawn, a refused edit kept, a failed save tried again by Submit":
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
    await deleteAndUndo(page, play, c);
    await linesAndScratch(page, play, c);
    await torn(page, play, c);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

async function deleteAndUndo(page, play, c) {
  // Delete from Select's bar: gone at once, gone from the store, back with Undo
  const dropped = crumpled(page);
  dropped.catch(() => {}); // a failure below shows first; awaiting it later still throws
  await fromBar(page, WAVE, 'Delete', 'tap');
  await c.shot('notebook-mini-menu', page);
  const { picture, down, aside, shown } = await dropped;
  assert.ok(!(await clipped(page)).includes(WAVE), 'the unit goes with its group at once');
  assert.ok(picture && down > 40 && aside < 2, `crumpled and dropped straight down (${down} down, ${aside} aside)`);
  assert.ok(shown > 0.4, `still shown as it drops (${shown})`);
  await page.locator('#toasts .toast', { hasText: 'Deleted' }).waitFor();
  await until(() => !ids(play, NEWEST).includes(WAVE), 'the group deleted in the store');
  await c.shot('notebook-mini-deleted', page);
  await page.locator('#book').getByRole('button', { name: 'Undo' }).first().tap();
  await until(() => ids(play, NEWEST).includes(WAVE), 'Undo restores it in the store');
  await until(async () => (await clipped(page)).includes(WAVE), 'and its unit is back');
}

async function linesAndScratch(page, play, c) {
  // a line on a blank page (New page's): a group of its own; the next, near it and soon after, joins it. (the seed's
  // newest page is the board's drawings, one column on an iPad mini, and a line that near one is part of it:
  // bookunits.js nearDrawing. Drawn one after the other: a loaded worker's save timers fire late, past the join's 4 s.)
  // Then a scratch-out over it, from its middle (its clip at its left is its own button): deleted, no ink kept.
  await press(page, 'New page');
  await until(async () => !(await clipped(page)).length, 'a blank page shown');
  await tool(page, 'Pen');
  const line = await onPaper(page, [
    [180, 425],
    [210, 432],
    [235, 428],
  ]);
  const next = await onPaper(page, [
    [252, 426],
    [280, 430],
    [305, 427],
  ]);
  await pen(page, line);
  await pen(page, next);
  const blank = await until(() => pagesOf(play).find(p => p.id > NEWEST)?.id, 'the blank page kept with its line'),
    made = await until(() => {
      const [only, ...more] = ids(play, blank);
      return !more.length && group(play, only)?.ink.length === 2 && only;
    }, 'one group for the line, the next line joining it');
  await until(async () => (await clipped(page)).includes(made), 'the new group has its clip');
  await c.shot('notebook-mini-lines', page);
  const zig = [];
  for (let i = 0; i < 7; i++) zig.push([260, 419 + i * 3], [i % 2 ? 198 : 320, 418 + i * 3]);
  await pen(page, await onPaper(page, zig));
  await until(() => !ids(play, blank).length, 'the scratch-out deletes the group, and leaves no ink of its own');
  await turnTo(page, NEWEST);
}

// Torn to Submit with a finger: sent at once, the page stays shown and stamped, no page made; nothing written on it is
// kept
async function torn(page, play, c) {
  const n = pagesOf(play).length,
    at = await where(page);
  await dragTo(page, 'touch', 'submit');
  await until(() => pageOf(play, NEWEST).sent, 'sent at once');
  await until(async () => /^Sent /.test(await stamp(page)), 'the page stamped where it is');
  assert.equal(await where(page), at, 'the page stays shown');
  assert.equal(pagesOf(play).length, n, 'no page made');
  await c.shot('notebook-mini-sending', page);
  const kept = ids(play, NEWEST);
  await pen(
    page,
    await besideClear(page, [
      [0, 0],
      [100, 5],
    ]),
  );
  await page.waitForTimeout(1200);
  assert.deepEqual(ids(play, NEWEST), kept, 'nothing written on a sent page is kept');
  await c.shot('notebook-mini-sent', page);
}

async function onDesktop(browser, c) {
  const { page, play, errors, done } = await open(browser, c, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 });
  try {
    await moveAndUndo(page, play);
    await otherScreen(page, play);
    await refusedEdit(page, play, c);
    await failedSave(page, play);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

async function moveAndUndo(page, play) {
  // Move to page… on Select's bar: the wave onto the page before, its unit gone here; Undo brings it back
  await fromBar(page, WAVE, 'Move to page…');
  await page.locator(`#book [role=menu] [data-page="${SECOND}"]`).click();
  await until(() => group(play, WAVE)?.page === SECOND, 'the group moved in the store');
  await until(async () => !(await clipped(page)).includes(WAVE), 'and off this page');
  await page.mouse.move(DESKTOP.width - 200, DESKTOP.height / 2);
  await page.keyboard.press('Control+z');
  await until(() => group(play, WAVE)?.page === NEWEST, 'Undo moves it back');
  await until(async () => (await clipped(page)).includes(WAVE), 'its unit back here');
}

async function otherScreen(page, play) {
  // another screen makes a group of two lines (a clip holds them): drawn here once the store tells of it
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

async function refusedEdit(page, play, c) {
  // a line added to the rows (clear of the tool strip) while another screen changes them: refused, read again, the
  // line kept and saved anew
  const refused = [];
  page.on('response', r => r.status() === 409 && refused.push(r.url()));
  // (with the pen: Move to page… left Select on, whose press on the rows draws nothing. On the rows' own unit, slid
  // into view: its px as the store keeps them.)
  await tool(page, 'Pen');
  const rows = group(play, ROWS),
    drawn = await inSight(page, NEWEST, ROWS, [
      [110, 70],
      [160, 74],
      [210, 71],
    ]);
  await pen(page, drawn, page.mouse);
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
  await until(() => inkFrom(page, play, drawn[0]), 'the line saved anew once the page is read again');
  assert.ok(
    rows.ink.slice(0, -1).every(s => group(play, ROWS).ink.some(t => near(t.points[0], s.points[0], 0.01))) &&
      !group(play, ROWS).ink.some(t => near(t.points[0], rows.ink.at(-1).points[0], 0.01)),
    "the other screen's change kept",
  );
  await c.shot('notebook-desktop-synced', page);
}

// A line drawn while the store refuses: its save fails, said on the page, and Submit, trying it again, sends nothing
// while the store still refuses (the store's older groups would go in its place); once the store answers, Submit saves
// the line and sends the page.
async function failedSave(page, play) {
  const down = r => r.fulfill({ status: 503, json: { error: 'The store is busy' } });
  await page.route('**/api/notebooks/groups/*', down);
  const drawn = await besideClear(page, [
    [0, 0],
    [50, 4],
    [100, 1],
  ]);
  await pen(page, drawn, page.mouse);
  await page.locator('#book .bk-refusal:not([hidden])').first().waitFor();
  await dragTo(page, 'mouse', 'submit');
  await page.waitForTimeout(1500);
  assert.ok(!pageOf(play, NEWEST).sent, 'a page whose save failed again is not sent');
  await page.unroute('**/api/notebooks/groups/*', down);
  await dragTo(page, 'mouse', 'submit');
  await until(() => pageOf(play, NEWEST).sent, 'the page sent once the store answers');
  assert.ok(await inkFrom(page, play, drawn[0]), 'with the line its failed save held');
}

// ---- HQ, the book open on the seeded Notebook's newest page

// HQ at a size on the played Notebook seeded as dev mode's, the groups drawn (folded: tapped open from its tab). (also
// booknotebookasks.mjs's and booknotebookrow.mjs's)
export async function open(browser, c, viewport, { record, folded, ...more }) {
  const video = record && c.shots ? { recordVideo: { dir: c.shots, size: viewport } } : {};
  const context = await c.hqIn(browser, viewport, { notebooks: structuredClone(SEED), ...more, ...video });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
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
// (also booknotebookselect.mjs's)
export const ids = (play, page) => groupsOn(play, page).map(g => g.id);
export const group = (play, id) =>
  [SENT, SECOND, NEWEST, ...pagesOf(play).map(p => p.id)].flatMap(p => groupsOn(play, p)).find(g => g.id === id);
const pagesOf = play => play.route('/api/notebooks/pages', { notebook: 1 }).pages;
const pageOf = (play, id) => pagesOf(play).find(p => p.id === id);
const near = ([x, y], [x1, y1], px = 4) => Math.abs(x - x1) <= px && Math.abs(y - y1) <= px;
// Points about a clear place on the newest page (clearPlace), in screen px, slid into view with the unit above it and
// on bare paper
async function besideClear(page, points) {
  const [x, y, unit] = await clearPlace(page),
    [[x0, y0], [x1, y1]] = await onPaper(
      page,
      [0, 1].map(d => [d, d]),
      unit,
    ),
    at = [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)];
  return inSight(
    page,
    NEWEST,
    unit,
    points.map(([dx, dy]) => [at[0] + dx, at[1] + dy]),
  );
}
// Whether a line the store keeps on the newest page starts at a point of the screen: each stroke's first point, in its
// unit's own px, where the page shows it
async function inkFrom(page, play, [x, y]) {
  for (const g of groupsOn(play, NEWEST)) {
    if (!g.ink.length || !(await clipped(page)).includes(g.id)) continue;
    const starts = await onPaper(
      page,
      g.ink.map(s => s.points[0]),
      g.id,
    );
    if (starts.some(p => near(p, [x, y]))) return true;
  }
  return false;
}
