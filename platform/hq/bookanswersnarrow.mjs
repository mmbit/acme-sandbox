// book-check.mjs's answers story on a narrower book (bookanswers.mjs): a note's answer placed beside it on a wide page,
// drawn at its narrow spot where the book's paper hasn't the room, and a note the board wrote later on that spot.
import assert from 'node:assert/strict';
import { freePage } from './bookmouse.mjs';
import { notebookOn, overlaps, pagePx } from './bookanswersplay.mjs';
import { inPaper, inStory, written } from './bookanswers.mjs';
import { ANSWER, answerSpot, downAgain, spotBox } from '../coordinator/src/ink/answerspot.ts';

// A note written on a wide page (the book spread over a desktop), its answer beside it as the store places it there
// (answerspot.ts, with its narrow spot), opened in the book beside HQ's page on a desktop, an iPad mini upright and a
// phone: none has the room beside it, so it lies at its narrow spot below the note, clear of every note and inside the
// paper, never moved over the board's writing. later: the board then wrote a note on one of its spots, on a screen that
// draws the other ('narrow': on a wide book; 'wide': on a narrower one), and the store moved that spot down clear of it
// (answerplace.ts spotsClear, as downAgain places it): no screen draws the answer over that note, the book spread wide
// over a desktop (its wide spot) nor a narrower one.
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
  const screens = [
    ['desktop', c.DESKTOP, { hasTouch: false, deviceScaleFactor: 1 }],
    ['mini-upright', { width: 744, height: 1133 }, {}],
    ['phone', c.PHONE, { hasTouch: true, isMobile: true }],
    ...(later === 'wide' ? [['desktop-spread', c.DESKTOP, { hasTouch: false, deviceScaleFactor: 1 }]] : []),
  ];
  try {
    for (const [size, viewport, options] of screens)
      await inStory(browser, c, { viewport, nb, made: [], options }, async page => {
        const shown = size === 'desktop-spread' ? spot : spot.narrow;
        if (shown === spot) await spread(page, c);
        await written(page, 4410);
        const at = await pagePx(page, '.bk-answer[data-answer="4410"]');
        for (const g of nb.groups) assert.ok(!overlaps(at, g.box), `${size}: the answer clear of note ${g.id}`);
        assert.deepEqual(
          [Math.round(at.x - note.box.x), Math.round(at.y - note.box.y), Math.round(at.w)],
          [shown.dx, shown.dy, shown.w],
          `${size}: at its ${shown === spot ? 'wide' : 'narrow'} spot`,
        );
        await inPaper(page, 4410);
        await c.shot(`answers-beside-${later ? `later-${later}-` : ''}${size}`, page);
      });
  } finally {
    c.pages.splice(c.pages.indexOf(p), 1);
  }
}
// The board's note on the answer's narrow spot (written on a wide book) or its wide one (on a narrower book: left of
// its controls, clear of the narrow spot it draws), and the spot it covers moved down clear as the store moves it
function writtenOn(nb, root, spot, later) {
  const on = spotBox(root, later === 'narrow' ? spot.narrow : spot),
    added = later === 'narrow' ? nb.typed(4402, LATER, on.x, on.y + 10) : nb.typed(4402, LATER, 450, 160);
  if (later === 'wide') assert.ok(overlaps(added.box, on) && !overlaps(added.box, spotBox(root, spot.narrow)));
  nb.groups.push(added);
  const taken = nb.groups.map(g => g.box);
  return later === 'narrow'
    ? { ...spot, narrow: downAgain(root, spot.narrow, taken) }
    : { ...downAgain(root, spot, taken), narrow: spot.narrow };
}
const LATER = 'and the logo a little smaller';
// The book spread over the whole of a desktop, as the board leaves it with its cover's edge dragged left (booklayout.js:
// remembered per shape), HQ loaded again
async function spread(page, c) {
  await page.evaluate(() => localStorage.setItem('hq.book.wide', JSON.stringify({ mode: 'spread', book: null })));
  await page.reload();
  await page.waitForSelector('#loading.gone');
  await c.settled(page, 'spread');
}
