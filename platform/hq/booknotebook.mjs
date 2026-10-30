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
//   - a phone: the book a whole page, the sent page's scrap with its words, its answer under it (and an agent's card
//     under another group), a reply written under the answer, kept while another answer comes, and taken back with
//     its Undo; a new answer under it
//     within seconds of the store's event, with a picture of what was made and its link, and ticked.
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { clipped, fromBar, onPaper, pen, stamp, turnTo, where } from './booknotebookscreen.mjs';
import { DESKTOP, MINI, crumpled, until } from './bookkit.mjs';
import { dragTo } from './bookshare.mjs';

const SEED = JSON.parse(await readFile(new URL('./mock/notebook.json', import.meta.url), 'utf8'));
const PHONE = { width: 390, height: 844 };
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
    'the Notebook on a phone: the sent page whole, its answer under its scrap, a reply written (kept as another answer comes) and taken back, a new answer there within seconds, ticked':
      browser => onPhone(browser, c),
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
  await until(async () => !(await clipped(page)).includes(WAVE), 'the unit goes with its group at once', 2000);
  const { picture, down, aside, shown } = await dropped;
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
  // a line in a clear place, left of the controls over the paper's right edge: a group of its own; the next, near it
  // and soon after, joins it, as the words of a line do. (drawn one after the other: a wait on the store between them
  // can put more than the join's 4 s between their saves on a loaded worker, whose save timers fire late.)
  const before = ids(play, NEWEST);
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
  const made = await until(
    () => ids(play, NEWEST).find(id => !before.includes(id) && group(play, id).ink.length === 2),
    'a new group for the line, the next line joining it',
  );
  assert.equal(ids(play, NEWEST).length, before.length + 1, 'one group for both lines');
  await until(async () => (await clipped(page)).includes(made), 'the new group has its clip');
  await c.shot('notebook-mini-lines', page);
  // a scratch-out over it, from its middle (its clip at its left is a button of its own): deleted, no ink kept
  const zig = [];
  for (let i = 0; i < 7; i++) zig.push([260, 419 + i * 3], [i % 2 ? 198 : 320, 418 + i * 3]);
  await pen(page, await onPaper(page, zig));
  await until(() => !ids(play, NEWEST).includes(made), 'the scratch-out deletes the group');
  assert.deepEqual(ids(play, NEWEST), before, 'and leaves no ink of its own');
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
    await onPaper(page, [
      [180, 425],
      [280, 430],
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
  const rows = group(play, ROWS);
  await pen(
    page,
    await onPaper(page, [
      [150, 530],
      [200, 534],
      [250, 531],
    ]),
    page.mouse,
  );
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
  await until(
    () => groupsOn(play, NEWEST).some(g => g.ink.some(s => near(s.points[0], [150, 530]))),
    'the line saved anew once the page is read again',
  );
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
  await pen(
    page,
    await onPaper(page, [
      [150, 610],
      [200, 614],
      [250, 611],
    ]),
    page.mouse,
  );
  await page.locator('#book .bk-refusal:not([hidden])').first().waitFor();
  await dragTo(page, 'mouse', 'submit');
  await page.waitForTimeout(1500);
  assert.ok(!pageOf(play, NEWEST).sent, 'a page whose save failed again is not sent');
  await page.unroute('**/api/notebooks/groups/*', down);
  await dragTo(page, 'mouse', 'submit');
  await until(() => pageOf(play, NEWEST).sent, 'the page sent once the store answers');
  assert.ok(
    groupsOn(play, NEWEST).some(g => g.ink.some(s => near(s.points[0], [150, 610]))),
    'with the line its failed save held',
  );
}

async function onPhone(browser, c) {
  const { page, play, errors, done } = await open(browser, c, PHONE, { hasTouch: true, isMobile: true, folded: true });
  try {
    await turnTo(page, SENT);
    await until(async () => /^Sent /.test(await stamp(page)), 'the sent page stamped');
    const words = page.locator('#book .bk-scrap-words').first();
    await words.scrollIntoViewIfNeeded();
    assert.equal((await words.textContent()).trim(), group(play, 3).words, "the scrap's words under it");
    const slip = page.locator('#book .bk-under .answer-slip').first();
    await slip.scrollIntoViewIfNeeded();
    assert.match(await slip.textContent(), /Warmer it is/, 'the answer under its group');
    // (an agent's desk-phone card under its group, on a phone too: booknotebookasks.mjs.)
    const asked = page.locator('#book .bk-under[data-g="2"] .ask-slip').first();
    await asked.scrollIntoViewIfNeeded();
    assert.match(await asked.innerText(), /Moss asks[\s\S]*The wave/, "an agent's card under its group");
    await slip.scrollIntoViewIfNeeded();
    await c.shot('notebook-phone-answer', page);
    const replies = () => group(play, 3).children.filter(r => r.kind === 'reply').length;
    const had = replies();
    await slip.locator('.slip-reply').tap();
    await page.keyboard.type('Lovely: one more in the teal, please');
    // (another answer comes meanwhile: the reply being written stays, unsent, till it's sent.)
    const slips = page.locator('#book .bk-under[data-g="3"] .answer-slip'),
      shown = await slips.count();
    play.answer(3, { by: 'moss', text: 'Teal is on its way' });
    await page.waitForTimeout(1500);
    assert.equal(replies(), had, 'nothing sent while the reply is written');
    assert.equal(
      await slip.locator('.slip-reply').inputValue(),
      'Lovely: one more in the teal, please',
      'the reply being written kept',
    );
    await page.keyboard.press('Enter');
    await until(() => replies() === had + 1, 'the reply in the store');
    await until(async () => (await slips.count()) === shown + 1, 'the answer that came meanwhile drawn once it went');
    const undo = page.locator('#book .bk-unreply').first();
    await undo.waitFor();
    await c.shot('notebook-phone-replied', page);
    // (its own click, in its seconds: on a loaded machine a tap waits seconds for frames, and review mode's pin at the
    // foot may be over it till it steps off, dock.js)
    await undo.dispatchEvent('click');
    await until(() => replies() === had, 'the reply taken back');
    await answered(page, play, c);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A new answer from the store under its group within seconds (the store's event, not a read on a timer), with a
// picture of what was made and its link; its box ticks it
async function answered(page, play, c) {
  const ticks = [];
  await page.route('**/api/book/slip/tick', r => {
    ticks.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true } });
  });
  const slips = page.locator('#book .bk-under[data-g="3"] .answer-slip'),
    had = await slips.count();
  const made = play.answer(3, {
    ...{ by: 'moss', text: 'And one in teal: here it is' },
    ...{ picture: '/mock/book-snip-2.svg', link: 'https://teal.preview.example' },
  });
  await until(async () => (await slips.count()) === had + 1, 'the answer under its group within seconds', 4000);
  const slip = page.locator(`#book .answer-slip[data-slip="${made.id}"]`);
  await slip.scrollIntoViewIfNeeded();
  assert.equal(await slip.locator('.slip-pic').count(), 1, 'a picture of what was made');
  const link = slip.getByRole('link', { name: 'Open what Moss made' });
  assert.equal(await link.getAttribute('href'), 'https://teal.preview.example', 'and its link');
  await c.shot('notebook-phone-new-answer', page);
  await slip.locator('.slip-tick').tap();
  await until(() => ticks.length, 'the tick sent');
  assert.deepEqual(ticks, [{ id: made.id, ticked: true }]);
  assert.equal(await slip.getAttribute('data-ticked'), '', 'the slip ticked');
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
