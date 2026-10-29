// book-check.mjs's answers story on a narrower book (bookanswers.mjs): a note's answer placed beside it on a wide page,
// drawn at the narrow spot placed for the paper each book shows where it hasn't the room, and a note the board wrote
// later on one of its spots.
import assert from 'node:assert/strict';
import { freePage } from './bookmouse.mjs';
import { notebookOn, onScreen, pagePx } from './bookanswersplay.mjs';
import { inPaper, inStory, written } from './bookanswers.mjs';
import { BOOK, paperWidth } from './shell/ink/booklayout.js';
import {
  ANSWER,
  NARROWER,
  answerSpot,
  downAgain,
  overlapping,
  spotBox,
  spotBoxes,
  spotChain,
} from '../coordinator/src/ink/answerspot.ts';

// A note written on a wide page (the book spread over a desktop), its answer beside it as the store places it there
// (answerspot.ts, with its narrow spots), opened in the book beside HQ's page on a desktop, an iPad mini upright (the
// spread, and dragged beside HQ's page at its least) and a phone: none has the room beside it, so it lies below the
// note at the narrow spot placed for the widest paper that fits that book's (answerspot.ts NARROWER, from the company's
// screens; the upright spread's paper is wider than any of them), as wide as that paper lets it, clear of
// every note and left of the controls, never moved over the board's writing. later: the board then wrote a note on one
// of its spots, on a screen that draws another ('narrow': on a wide book; 'wide': on a narrower one), and the store
// moved the spots it covers down clear of it (answerplace.ts spotsClear, as downAgain places them): no screen draws the
// answer over that note, the book spread wide over a desktop (its wide spot) nor a narrower one.
export async function besideOnNarrower(browser, c, later = null) {
  const p = freePage(c),
    nb = notebookOn(c, p),
    note = nb.typed(4400, 'Can the header say what this page is for, in a line?', 40, 60),
    next = nb.typed(4401, 'and the footer', 40, 260),
    text = 'Yes: “Your week at a glance”, under the logo.';
  note.texts[0].w = 520;
  note.box = { x: 40, y: 60, w: 520, h: 80 };
  let spot = answerSpot(note.box, { text }, [note.box, next.box], { x: 0, w: 1200 });
  assert.equal(spot.dx, note.box.w + ANSWER.gap, "beside the note on a wide page's paper");
  nb.groups.push(note, next);
  if (later) spot = writtenOn(nb, note.box, spot, later);
  note.children = [nb.answer(4410, 'text', text, spot)];
  // (each screen's spot: its wide one, or the narrow one placed for the widest of NARROWER's papers that fits its own)
  const spots = spotChain(spot),
    on = (viewport, state) =>
      spots[1 + NARROWER.findIndex(w => w <= paperWidth(viewport.width, viewport.height, state))],
    screens = [
      ['desktop', c.DESKTOP, { hasTouch: false, deviceScaleFactor: 1 }, on(c.DESKTOP, open)],
      ['mini-upright', upright, {}, on(upright, open)],
      ['mini-upright-least', upright, {}, on(upright, least)],
      ['phone', c.PHONE, { hasTouch: true, isMobile: true }, on(c.PHONE, open)],
      ...(later === 'wide' ? [['desktop-spread', c.DESKTOP, { hasTouch: false, deviceScaleFactor: 1 }, spot]] : []),
    ];
  assert.equal(spots.length, 1 + NARROWER.length, 'a narrow spot for each narrower paper');
  try {
    for (const [size, viewport, options, shown] of screens)
      await inStory(browser, c, { viewport, nb, made: [], options }, async page => {
        if (shown === spot) await kept(page, c, 'wide', { mode: 'spread', book: null }, 'spread');
        if (size === 'mini-upright-least') await kept(page, c, 'portrait', least, 'open');
        await written(page, 4410);
        const at = await pagePx(page, '.bk-answer[data-answer="4410"]');
        for (const g of nb.groups) assert.ok(!overlapping(at, g.box), `${size}: the answer clear of note ${g.id}`);
        assert.deepEqual(
          [Math.round(at.x - note.box.x), Math.round(at.y - note.box.y), Math.round(at.w)],
          [shown.dx, shown.dy, shown.w],
          `${size}: at its ${shown === spot ? 'wide' : 'narrow'} spot for ${JSON.stringify(
            await onScreen(page, '.bk-answer[data-answer="4410"]').then(o => o.paper),
          )}`,
        );
        await inPaper(page, 4410);
        await c.shot(`answers-beside-${later ? `later-${later}-` : ''}${size}`, page);
      });
  } finally {
    c.pages.splice(c.pages.indexOf(p), 1);
  }
}
const upright = { width: 744, height: 1133 },
  open = { mode: 'open', book: null },
  least = { mode: 'open', book: BOOK.min };
// The board's note on the answer's first narrow spot (written on a wide book) or its wide one (on a narrower book: left
// of its controls, clear of the narrow spots it draws), and the spots it covers moved down clear as the store moves them
function writtenOn(nb, root, spot, later) {
  const on = spotBox(root, later === 'narrow' ? spot.narrow : spot),
    added = later === 'narrow' ? nb.typed(4402, LATER, on.x, on.y + 10) : nb.typed(4402, LATER, 450, 160);
  if (later === 'wide')
    assert.ok(overlapping(added.box, on) && !spotBoxes(root, spot.narrow).some(b => overlapping(added.box, b)));
  nb.groups.push(added);
  const taken = nb.groups.map(g => g.box),
    again = s => ({
      ...(overlapping(added.box, spotBox(root, s)) ? downAgain(root, s, taken) : s),
      ...(s.narrow && { narrow: again(s.narrow) }),
    });
  return again(spot);
}
const LATER = 'and the logo a little smaller';
// The book as the board leaves it with its cover's edge on a shape of screen (booklayout.js: remembered per shape),
// HQ loaded again: spread over the whole of a desktop, or beside HQ's page at its least on an iPad upright
async function kept(page, c, shape, state, mode) {
  await page.evaluate(([key, state]) => localStorage.setItem(key, JSON.stringify(state)), [`hq.book.${shape}`, state]);
  await page.reload();
  await page.waitForSelector('#loading.gone');
  await c.settled(page, mode);
}
