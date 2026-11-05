// book-check.mjs's story of the board's Undo on a call's notes page while the call's agent works it (the store's
// ink/callpage.ts, played: shell/ink/notebookplay.js `by`), by hand on its iPad at 1133 × 744 and 744 × 1133 with the
// Pencil and fingers in either engine (hands.mjs): the agent puts a note on, the board opens its scrap, draws on it
// and puts it back, the agent puts another on (read in as the scrap is put back), the board opens the scrap again and
// draws again. The Pencil's taps on the opened scrap's Undo take back the board's two lines, the last first, and
// nothing of the agent's: its notes stay on the page and in the store, a third Undo has nothing to take, and a finger
// on Redo puts only the board's line back (shell/ink/bookedit.js: someone else's change is no step). The board draws
// in an opened scrap: the grid takes no ink.
import assert from 'node:assert/strict';
import { MINI, QUIET_MS, UPRIGHT, closeScrap, middleOf, openScrap, until } from './kit.mjs';
import { mini } from './start.mjs';
import { callSeed } from './notespage.mjs';

// c: book-check's { hqIn, base, shot, settled, noErrorsIn }
export const agentPageStories = c => ({
  "the board's Undo on a call's page takes back only its own lines, never the agent's notes (landscape)": browser =>
    ownUndo(browser, c, MINI, 'landscape'),
  "the board's Undo on a call's page takes back only its own lines, never the agent's notes (portrait)": browser =>
    ownUndo(browser, c, UPRIGHT, 'portrait'),
});

const PAGE = 9101;
const anchor = { v: 1, url: '/', el: null, view: { x: 0, y: 0, w: 1133, h: 744, dpr: 1 }, ink: [] };

async function ownUndo(browser, c, viewport, held) {
  const s = await mini(browser, c, { viewport, notebooks: callSeed(new Date().toISOString()) });
  const play = s.page.context().notebook,
    groups = () => play.route('/api/notebooks/pages/groups', { page: PAGE }).groups,
    lines = () => groups().reduce((n, g) => n + g.ink.length, 0),
    notes = () => groups().filter(g => g.kind === 'note').length,
    // (on the grid's page: an opened scrap shows its note's words again on its sheet)
    shown = () =>
      s.page.evaluate(() => document.querySelectorAll('#book .bk-page:not([data-focus]) .bk-typed[data-note]').length);
  // (the agent's plain note, read on the board's screen)
  const note = async words => {
    const had = await shown();
    play.by('juno', '/api/notebooks/groups/scrap', { anchor, said: 'typed', words });
    await until(async () => (await shown()) > had, `the agent's note “${words}” on the board's page`);
  };
  const tap = (name, by) => historyKey(s, name, by);
  try {
    await note('The tabs read as tabs');
    const [first] = groups().filter(g => g.kind === 'note');
    let { sheet } = await openScrap(s.page, s.pen, first.id);
    await drawn(s, sheet, 0.3);
    await until(() => lines() === 1, "the board's first line saved");
    await closeScrap(s.page, s.pen);
    await note('One title on the page');
    ({ sheet } = await openScrap(s.page, s.pen, first.id));
    await drawn(s, sheet, 0.55);
    await until(() => lines() === 2, "the board's second line saved");
    await c.shot(`book-notes-own-undo-${held}-drawn`, s.page);
    await tap('Undo', 'pen');
    await until(() => lines() === 1, "the Pencil's Undo takes the board's last line back");
    assert.equal(notes(), 2, "the agent's notes stay in the store");
    await tap('Undo', 'pen');
    await until(() => lines() === 0, "and then the board's first");
    await tap('Undo', 'pen');
    await s.page.waitForTimeout(2 * QUIET_MS);
    assert.deepEqual([notes(), await shown()], [2, 2], "a third Undo takes nothing of the agent's");
    await tap('Redo', 'touch');
    await until(() => lines() === 1, "a finger's Redo puts the board's first line back");
    await s.page.waitForTimeout(2 * QUIET_MS);
    assert.deepEqual([notes(), await shown(), lines()], [2, 2, 1], 'and only that');
    await c.shot(`book-notes-own-undo-${held}`, s.page);
    c.noErrorsIn(s.errors);
  } catch (e) {
    await c.shot(`book-notes-own-undo-${held}-failed`, s.page).catch(() => {});
    throw e;
  } finally {
    await s.done();
  }
}
// The opened scrap's Undo or Redo (name) tapped by the Pencil or a finger (by): with the tools, the bar's put away
// while it's open
async function historyKey({ page, pen, touch }, name, by) {
  const at = middleOf(
    await page.locator('#book .bk-scrap-history').getByRole('button', { name, exact: true }).boundingBox(),
  );
  await (by === 'pen' ? pen.tap(at) : touch.stroke([at], [at]));
}
// A zigzag drawn with the Pencil low on the opened scrap's sheet, clear of the note at its top, from a fraction of its
// width across
async function drawn({ pen }, sheet, from) {
  const [x, y] = [sheet.x + sheet.width * from, sheet.y + sheet.height * 0.72];
  await pen.stroke(Array.from({ length: 9 }, (_, k) => [x + k * 12, y + (k % 2) * 24]));
}
