// book-check.mjs's story of a call's agent rewording its own notes while the board's caret sits in one of them, as a
// click on a note's scrap opened leaves it (the store's ink/callpage.ts change, played: shell/ink/notebookplay.js `by`).
// Each rewording shows on the board's screen, on the scrap opened and on the grid under it, and its screen never saves
// its older copy over it.
import assert from 'node:assert/strict';
import { callSeed, mode } from './notespage.mjs';
import { watchedPage } from './start.mjs';
import { closeScrap, openScrap, until } from './kit.mjs';
import { mouseOf } from './hands.mjs';

// c: book-check's { hqIn, base, shot, settled, noErrorsIn, DESKTOP }
export const noteRewordStories = c => ({
  "a call's agent rewords its notes as the board clicks into one: each shows, none is lost": browser =>
    reworded(browser, c),
});

const PAGE = 9101;
const anchor = { v: 1, url: '/', el: null, view: { x: 0, y: 0, w: 1280, h: 800, dpr: 1 }, ink: [] };
const NOTES = [
  'MODEL 1/3 · Project: Ink, HQ, Rocketlings. One list, read the same everywhere',
  'MODEL 2/3 · Milestone: ongoing, rounded off (Ink 1.2, HQ week 45)',
  'MODEL 3/3 · Task: one job, one number. No codes, no chore deliverables',
];
// A note's group as the store keeps it
const groupOf = (play, id) => play.route('/api/notebooks/pages/groups', { page: PAGE }).groups.find(g => g.id === id);
const NEW = [
  'MODEL 1/4 · Project: HQ, Rocketlings, Carrel. Milestones replace deliverables',
  'MODEL 2/4 · Milestone: ongoing, rounded off. Replaces deliverables',
];
const AGAIN = 'MODEL 2/4 · Milestone: ongoing, rounded off. Replaces deliverables and chores';

async function reworded(browser, c) {
  const context = await c.hqIn(browser, c.DESKTOP, { notebooks: callSeed(new Date().toISOString()) });
  const play = context.notebook;
  const { page, errors } = await watchedPage(context);
  const group = id => groupOf(play, id);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom`);
    await page.waitForSelector('#loading.gone', { state: 'attached' });
    const notes = NOTES.map(words => play.by('lyra', '/api/notebooks/groups/scrap', { anchor, said: 'typed', words }));
    if ((await mode(page)) !== 'open') {
      await page.focus('#book .bk-lip');
      await page.keyboard.press('Enter');
      await c.settled(page, 'open');
    }
    for (const words of NOTES) await shows(page, words);
    await rewordedOpened(page, play, notes);
    await caretBack(page, play, notes);
    await c.shot('book-notes-reworded', page);
    // (time for a save the board's screen would make: none comes, so nothing of the agent's is put back or deleted)
    await page.waitForTimeout(2000);
    assert.deepEqual(
      notes.map(n =>
        group(n.id)
          ?.texts.map(t => t.text)
          .join(' '),
      ),
      [NEW[0], AGAIN, NOTES[2]],
      "the store keeps the agent's words",
    );
    assert.equal(group(notes[2].id).updated, notes[2].updated, "the note nobody changed isn't saved again");
    await typedOn(page, () => group(notes[2].id));
    // (put back, the grid shows the agent's last words on the other note)
    await closeScrap(page, mouseOf(page));
    await shows(page, AGAIN);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot('book-notes-reword-failed', page).catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}
// The board opens the first note's scrap and clicks into its words, pointing at it: its caret there. The agent rewords
// it, and a note on the grid under it: the one shows on the scrap opened, the caret back in it at its end; the grid's
// is read in as the scrap is put back.
async function rewordedOpened(page, play, notes) {
  await typeIn(page, notes[0].id, 'MODEL 1/3');
  assert.ok(
    await page.evaluate(opened => !!document.querySelector(`${opened}[data-editing]`), OPENED),
    'a caret in it',
  );
  play.by('lyra', '/api/voice/change', { id: notes[0].id, words: NEW[0] });
  await shows(page, NEW[0], OPENED);
  await caretIn(page, 'MODEL 1/4');
  play.by('lyra', '/api/voice/change', { id: notes[1].id, words: NEW[1] });
  await closeScrap(page, mouseOf(page));
  for (const words of NEW) await shows(page, words);
}
// A caret in a note nobody rewords, its scrap opened, past a space the board put at its end, stays there as the agent
// rewords another note on the grid: the board's keys still type there
async function caretBack(page, play, notes) {
  await typeIn(page, notes[2].id, 'MODEL 3/3');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Space');
  play.by('lyra', '/api/voice/change', { id: notes[1].id, words: AGAIN });
  await until(() => groupOf(play, notes[1].id)?.texts.some(t => t.text === AGAIN), "the store's change made");
  await caretIn(page, 'MODEL 3/3');
}
// A note on its scrap opened: its typed words (booktexts.js's .bk-typed)
const OPENED = '#book .bk-page[data-focus] .bk-typed';
// A note's scrap opened by a click on its card, and a click into its words there
async function typeIn(page, id, words) {
  const { gid } = await openScrap(page, mouseOf(page), id);
  assert.equal(gid, id, `${words}'s scrap opened`);
  await page.locator(OPENED, { hasText: words }).first().click();
}
const caretIn = async (page, words) =>
  assert.ok(
    await page.evaluate(
      words =>
        document.activeElement
          ?.closest('#book .bk-page[data-focus] .bk-typed[data-editing]')
          ?.textContent.includes(words),
      words,
    ),
    `the caret back in ${words}`,
  );
// The board's keys type on where its caret came back, after the space it typed before the read, and leaving the box
// keeps what they typed: note() reads the store's group.
async function typedOn(page, note) {
  await page.keyboard.type('too');
  await page.keyboard.press('Escape');
  const said = () =>
    note()
      .texts.map(t => t.text)
      .join(' ');
  for (let i = 0; i < 50 && said() !== `${NOTES[2]} too`; i++) await page.waitForTimeout(200);
  assert.equal(said(), `${NOTES[2]} too`, "the board's words typed after the caret came back are kept");
}
// The words on the board's page, or on the scrap opened (on: OPENED), seen (not held off it, nor hidden)
const shows = (page, words, on = '#book .bk-page:not([hidden]) .bk-typed') =>
  page.waitForFunction(
    ([words, on]) =>
      [...document.querySelectorAll(on)].some(
        b => b.textContent.replace(/\s+/g, ' ').includes(words) && b.checkVisibility({ opacityProperty: true }),
      ),
    [words, on],
    { timeout: 60_000 },
  );
