// book-check.mjs's story of a call's agent working the open notes page as the board does (the store's ink/callpage.ts,
// played: shell/ink/notebookplay.js `by`), each change counted as its hand's (notebook.ts byHand): a plain note (words
// on a post-it, no picture), a rectangle round it, a highlight, its scrap's words changed and the scrap deleted. Each
// is one step on the board's screen (shell/ink/bookedit.js arrived): Undo takes it back in the store, Redo makes it
// again.
import assert from 'node:assert/strict';
import { callSeed, mode } from './booknotespage.mjs';

// c: book-check's { hqIn, base, shot, settled, noErrorsIn, DESKTOP }
export const agentPageStories = c => ({
  "a call's agent works the page: a plain note, a rectangle, a highlight, its scrap changed and deleted, each undone":
    browser => agentWorks(browser, c),
});

const PAGE = 9101;
const anchor = { v: 1, url: '/', el: null, view: { x: 0, y: 0, w: 1280, h: 800, dpr: 1 }, ink: [] };

async function agentWorks(browser, c) {
  const context = await c.hqIn(browser, c.DESKTOP, { notebooks: callSeed(new Date().toISOString()) });
  await context.addInitScript(keepReads);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const s = storyOf(page, context.notebook);
  try {
    await opened(page, c, context.notebook);
    const note = await plainNote(page, c, s);
    await marks(page, c, s, note);
    await scrapChanged(page, s);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot('book-notes-agent-failed', page).catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}
// (each read of the page's groups, kept once the book is done with it: the book's own read ends in the same task)
function keepReads() {
  const json = Response.prototype.json;
  Response.prototype.json = async function () {
    const read = await json.call(this);
    if (this.url.includes('/api/notebooks/pages/groups')) setTimeout(() => (window.groupsRead = read));
    return read;
  };
}
// What the story asks of the store and the page: its groups, one by id, a wait on the store, and the agent's change
// read on the board's screen (the book done with a read of the group as the store has it now) before the board's hand
// goes to Undo
function storyOf(page, play) {
  const group = id => play.route('/api/notebooks/pages/groups', { page: PAGE }).groups.find(g => g.id === id);
  const until = async (test, why) => {
    for (let i = 0; i < 80 && !test(); i++) await page.waitForTimeout(250);
    assert.ok(test(), why);
  };
  const byAgent = async (path, body) => {
    const made = play.by('juno', path, body),
      id = made.id ?? body.id;
    await page.waitForFunction(
      ([id, now]) => (window.groupsRead?.groups.find(g => g.id === id)?.updated ?? null) === now,
      [id, group(id)?.updated ?? null],
      { timeout: 60_000 },
    );
    return made;
  };
  const undo = () => page.keyboard.press('Control+z');
  return { group, until, byAgent, undo };
}
// The call's page open in the book, the board's own note on it
async function opened(page, c, play) {
  await page.goto(`${c.base}/?intro=0&open=intercom`);
  await page.waitForSelector('#loading.gone');
  play.route('/api/notebooks/groups/scrap', {}, { anchor, said: 'typed', words: 'Seen first' });
  if ((await mode(page)) !== 'open') {
    await page.focus('#book .bk-lip');
    await page.keyboard.press('Enter');
    await c.settled(page, 'open');
  }
  await page.waitForFunction(() => document.querySelectorAll('.bk-typed[data-note]').length === 1, null, {
    timeout: 60_000,
  });
}
async function plainNote(page, c, { group, until, byAgent, undo }) {
  const note = await byAgent('/api/notebooks/groups/scrap', {
    anchor,
    said: 'typed',
    words: 'Give the agent a plain note',
  });
  await page.waitForFunction(() => document.querySelectorAll('.bk-typed[data-note]').length === 2);
  assert.deepEqual([note.kind, note.pictures.length], ['note', 0], 'a plain note: words, no picture');
  await c.shot('book-notes-agent-note', page);
  await undo();
  await until(() => !group(note.id), "Undo takes the agent's note off the page");
  await page.keyboard.press('Control+Shift+z');
  await until(() => group(note.id), 'Redo puts it back');
  return note;
}
async function marks(page, c, { group, until, byAgent, undo }, note) {
  const { x, y, w, h } = note.box;
  const ring = await byAgent('/api/notebooks/groups/create', {
    page: PAGE,
    ink: [stroke({ color: '#4458c9', size: 5 }, [x - 12, y - 12, w + 24, h + 24])],
  });
  const highlight = await byAgent('/api/notebooks/groups/create', {
    page: PAGE,
    ink: [stroke({ color: '#ffd23f', size: 2, alpha: 0.42, fill: true }, [x, y, w, 30])],
  });
  await c.shot('book-notes-agent-marks', page);
  await undo();
  await until(() => !group(highlight.id) && group(ring.id), 'Undo takes the highlight back, the rectangle stays');
  await undo();
  await until(() => !group(ring.id) && group(note.id), 'and then the rectangle');
}
// A rectangle's stroke round a box, as the store's shapes are (bookinkmath.js shape)
const stroke = (ink, [x, y, w, h]) => ({
  ...ink,
  points: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ].map(([px, py], i) => [px, py, 0.58, i * 6]),
});
async function scrapChanged(page, { group, until, byAgent, undo }) {
  const snip = await page.screenshot({ clip: { x: 20, y: 40, width: 200, height: 120 } });
  const scrap = await byAgent('/api/notebooks/groups/scrap', {
    anchor,
    said: 'typed',
    words: 'Make the price smaller',
    snip: `data:image/png;base64,${snip.toString('base64')}`,
  });
  await byAgent('/api/notebooks/groups/edit', {
    id: scrap.id,
    since: group(scrap.id).updated,
    words: 'Make the price much smaller',
    said: 'typed',
  });
  await undo();
  await until(() => group(scrap.id)?.words === 'Make the price smaller', "Undo puts the scrap's words back");
  await byAgent('/api/notebooks/groups/delete', { id: scrap.id });
  await undo();
  await until(() => group(scrap.id), 'Undo brings the deleted scrap back');
  assert.equal(group(scrap.id).words, 'Make the price smaller');
}
