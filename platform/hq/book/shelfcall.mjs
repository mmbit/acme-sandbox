// book-check.mjs's story of the Pencil on the Shelf during a call (shell/ink/bookcallmarks.js takesCallInk,
// bookshelfwindow.js; shared/review/pentouch.js ownsPen), held like the board's iPad on its side, its screen shown:
// with the Shelf open over HQ, a ring round a notebook on it is the call's scribble, a note for its agent, and the
// watch-along's moments say what it circled there. Then the book opened on a page and a scrap opened on it: the pen's
// line there is the notebook's ink, no note for the call.
//   node platform/hq/book-check.mjs --stories 'the Pencil on the Shelf'
import assert from 'node:assert/strict';
import { Moments, lines } from '../../../shared/watchalong/moments.ts';
import { playLine } from './call.mjs';
import { minimiseCall } from './callview.mjs';
import { namedNotebook } from './chrome.mjs';
import { MINI, bookOpen, middleOf, openScrap, shelfAtRest, shelfKey, until } from './kit.mjs';
import { recording } from './picture.mjs';

const SETTLE_MS = 1500; // (callnotes.js)

// c: book-check.mjs's { hqIn, base, shot, noErrorsIn, shots }
export const shelfCallStories = c => ({
  "the Pencil on the Shelf during a call scribbles for the call's agent, on an open page it's the notebook's ink":
    browser => shelfCall(browser, c),
});

async function shelfCall(browser, c) {
  const s = await recording(browser, c, MINI, { notebooks: namedNotebook() });
  const { page, context } = s;
  s.line = await playLine(context);
  // (the notes review mode's pen makes, and the book's store's changes)
  await context.addInitScript(() => {
    window.__notes = 0;
    document.addEventListener('pencil:note', () => window.__notes++);
  });
  s.stored = 0;
  context.notebook.listen(() => s.stored++);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom`);
    await page.waitForSelector('#loading.gone');
    await bookOpen(page, false);
    await page.locator('#call').tap();
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
    await page.locator('#call-screenshare').tap();
    await minimiseCall(page);
    await onTheShelf(s, c);
    await onThePage(s, c);
    await page.locator('.cb-hangup').tap();
    c.noErrorsIn(s.errors);
  } catch (error) {
    await c.shot('shelf-call-failed', page);
    throw error;
  } finally {
    await s.done();
  }
}
const notesHeard = s => s.line.said.filter(e => e.type === 'note').length;

// The Shelf over HQ, a ring round its first notebook: a note for the call, and its moment says what it circled
async function onTheShelf(s, c) {
  const { page, hand } = s;
  await (await shelfKey(page)).tap();
  const shelf = page.getByRole('dialog', { name: 'The Shelf' });
  const book = shelf.locator('.bk-book').first();
  await book.waitFor();
  await shelfAtRest(page);
  await page.waitForTimeout(600);
  await hand.stroke('pen', ring(await book.boundingBox()));
  await until(
    () => notesHeard(s) === 1,
    () => `the ring on the Shelf a note for the call (${notesHeard(s)} heard)`,
  );
  assert.equal(await shelf.isVisible(), true, 'the Shelf still open under the ring');
  await c.shot('shelf-call-ring', page);
  // (the ring's moment, once the recorder has sent it)
  let inked = [];
  const circled = await until(
    () => {
      const moments = new Moments();
      moments.add(s.events);
      inked = lines(
        moments.list.filter(m => m.kind === 'ink'),
        () => '',
      );
      return inked.find(l => l.includes('circled'));
    },
    () => `the ring in the watch-along’s moments (its pen's: ${JSON.stringify(inked)})`,
  );
  console.log(`the ring on the Shelf: ${circled}`);
  assert.match(circled, /circled "My journal[^"]*" \(button\)|circled "The Shelf" \(dialog\)/, 'what it circled');
  await page.keyboard.press('Escape');
  await shelf.waitFor({ state: 'hidden' });
}

// The book open on a page, a new scrap opened on it by the pen's tap on the empty grid: the pen's line there the
// notebook's ink, no note for the call
async function onThePage(s, c) {
  const { page, hand } = s;
  await bookOpen(page, true);
  const desk = await page.locator('#book .bk-desk').boundingBox();
  const { sheet } = await openScrap(page, { tap: at => hand.stroke('pen', [at]) }, undefined, [
    desk.x + 120,
    desk.y + 200,
  ]);
  const before = { notes: await page.evaluate(() => window.__notes), stored: s.stored };
  const [x, y] = middleOf(sheet);
  await hand.stroke('pen', [
    [x - 80, y - 20],
    [x - 30, y + 10],
    [x + 20, y - 15],
    [x + 70, y + 20],
  ]);
  await until(() => s.stored > before.stored, 'the line on the page saved in the notebook');
  await page.waitForTimeout(SETTLE_MS + 1000);
  assert.equal(await page.evaluate(() => window.__notes), before.notes, 'no note of the call’s pen on the page');
  assert.equal(notesHeard(s), 1, 'the call heard no note of the page’s line');
  await c.shot('shelf-call-page', page);
}

// A ring round a box, as a hand draws one: round once and a little past where it began (some 13°: round a tall book,
// further past is a hook the watch-along reads as no ring)
function ring(b) {
  const [x, y] = middleOf(b),
    rx = b.width / 2 + 14,
    ry = b.height / 2 + 14;
  return Array.from({ length: 30 }, (_, i) => {
    const a = (i / 28) * 2 * Math.PI;
    return [Math.round(x + rx * Math.cos(a)), Math.round(y + ry * Math.sin(a))];
  });
}
