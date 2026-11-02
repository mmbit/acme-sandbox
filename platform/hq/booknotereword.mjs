// book-check.mjs's story of a call's agent rewording its own notes while the board's caret sits in one of them, as a
// click on a note leaves it (the store's ink/callpage.ts change, played: shell/ink/notebookplay.js `by`). Each
// rewording shows on the board's screen, and its screen never saves its older copy over it.
import assert from 'node:assert/strict';
import { callSeed, mode } from './booknotespage.mjs';

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
const NEW = [
  'MODEL 1/4 · Project: HQ, Rocketlings, Carrel. Milestones replace deliverables',
  'MODEL 2/4 · Milestone: ongoing, rounded off. Replaces deliverables',
];
const AGAIN = 'MODEL 2/4 · Milestone: ongoing, rounded off. Replaces deliverables and chores';

async function reworded(browser, c) {
  const context = await c.hqIn(browser, c.DESKTOP, { notebooks: callSeed(new Date().toISOString()) });
  const play = context.notebook,
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const group = id => play.route('/api/notebooks/pages/groups', { page: PAGE }).groups.find(g => g.id === id);
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
    // (the board clicks into the first note's words, pointing at it: its caret there)
    await page.locator('#book .bk-typed', { hasText: 'MODEL 1/3' }).first().click();
    assert.ok(await page.evaluate(() => !!document.querySelector('#book .bk-typed[data-editing]')), 'a caret in it');
    for (const [i, words] of NEW.entries()) {
      play.by('lyra', '/api/voice/change', { id: notes[i].id, words });
      await shows(page, words);
    }
    // (the note the caret was in was reworded first: the caret is back in it, at its end.)
    await caretIn(page, 'MODEL 1/4');
    await caretBack(page, play, notes[1].id);
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
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot('book-notes-reword-failed', page).catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}
// A caret in a note nobody rewords comes back to it after the read of another's new words, even past a space the board
// put at its end: the board's keys still type there
async function caretBack(page, play, other) {
  await page.locator('#book .bk-typed', { hasText: 'MODEL 3/3' }).first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Space');
  play.by('lyra', '/api/voice/change', { id: other, words: AGAIN });
  await shows(page, AGAIN);
  await caretIn(page, 'MODEL 3/3');
}
const caretIn = async (page, words) =>
  assert.ok(
    await page.evaluate(
      words => document.activeElement?.closest('#book .bk-typed[data-editing]')?.textContent.includes(words),
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
// The words on the board's page, seen (not held off it, nor hidden)
const shows = (page, words) =>
  page.waitForFunction(
    words =>
      [...document.querySelectorAll('#book .bk-typed')].some(
        b => b.textContent.replace(/\s+/g, ' ').includes(words) && b.checkVisibility({ opacityProperty: true }),
      ),
    words,
    { timeout: 60_000 },
  );
