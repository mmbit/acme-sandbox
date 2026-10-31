// Writing in the book: whether a press writes (the Pencil and a mouse on a page whose ink is read, unless the press
// pans or a tool takes it), and a stroke lifted onto its page, one step for Undo and Redo. (moved here from bookpages.js, and Redo: job #19243)
import { INKS } from '/__review/ink.js';
import { at } from './bookview.js';
import { boxOf } from './bookrow.js';
import { inkUnit } from './bookunits.js';
import { changed, shut } from './booksave.js';
import { scrapAt } from './bookscrap.js';
import { isTap, wandered } from '/__review/tap.js';
import { followPress } from './bookpress.js';

// The book's ink until the tools say otherwise: Night, at review mode's pen size
export const INK = { color: '#2a2352', size: INKS[0].size };

// The Pencil and a mouse write on the page once its ink is read, unless the press pans (bookpan.js) or the mouse's
// tools take it (moving a picture, a text box: booktools.js); a finger does too, unless it moves the page: with the
// hand, or once a pen is in use where this device's preferences say so (book.input.fingerPans(): bookinput.js). A text field on a page (a
// reply's) is the field's: the Pencil writes into it with Scribble. The Pencil on something on the page (a box of
// words, an answer's slip, a picture) waits: a quick tap there is a click on it, never a dot of ink, and once it
// moves its line starts where it touched. On bare paper it inks at once, so a dotted i keeps its dot.
export function drawable(book, e, table) {
  if (e === book.waited) {
    book.waited = null;
    book.assign?.inking(e); // (a ring round a scrap and a line out of it: bookassign.js)
    return true;
  }
  // (a note's words kept from Scribble for the pen take its strokes: bookamend.js; a read refused, over the page, is tapped to try again)
  if (e.target.closest?.('textarea:not([data-pen]), input, [contenteditable], button, .bk-lost')) return false;
  book.pointer = e.pointerType;
  // (a finger writes too, where it doesn't move the page: bookpan.js.)
  const writes =
    e.pointerType === 'pen' ||
    (e.pointerType === 'mouse' && e.button === 0) ||
    (e.pointerType === 'touch' && !book.input?.fingerPans?.());
  if (!writes || table.panning(e) || !e.isPrimary) return false;
  const hit = at(book, e.clientX, e.clientY);
  if (!hit || book.tools?.press(e)) return false;
  // (a sent page's own groups are read-only.)
  if (!hit.view.page.ink || shut(hit.view.page)) return false;
  table.stop();
  book.target = hit.i;
  book.inking = book.tools?.ink() ?? INK;
  if (e.pointerType !== 'mouse' && onSomething(e, hit)) return waitFor(book, e);
  book.assign?.inking(e);
  return true;
}
const onSomething = (e, hit) =>
  !!e.target.closest?.('.bk-typed, .answer-slip') || scrapAt(hit.view.page.scraps, [hit.x, hit.y]) >= 0;
// The Pencil held back where it touched: lifted as a tap, it's a click (the browser's own on what's under it; a box of
// words the ink would draw over is edited); moved past a tap, or lifted slowly, its line from where it touched
function waitFor(book, down) {
  let inking = false;
  followPress(down, {
    move: m => {
      if (inking || !wandered(down, m)) return;
      inking = true;
      book.waited = down;
      book.ink.start(down);
      book.waited = null;
    },
    up: u => {
      if (inking || u.type === 'pointercancel') return;
      const box = down.target.closest('.bk-typed');
      if (isTap(down, u)) return box && book.tools?.tapped(box, [u.clientX, u.clientY]);
      book.waited = down;
      book.ink.start(down);
      book.waited = null;
      book.ink.end(u);
    },
  });
  return false;
}
// The pen's line ended when the browser stops telling about its pointer, so a lift it never sent (Scribble taking the
// Pencil's touch, a capture lost) can't leave the pen holding a line: no stroke, pan or tool would start again. A press
// of the line's own pointer, or of the one pen or mouse there is, says it's gone; so do a lost capture, the window
// left and the page hidden.
export function endLostLines(book) {
  const { desk } = book,
    end = () => book.ink.drawing && book.ink.cancel();
  desk.addEventListener('pointerdown', e => (e.pointerType === 'pen' || e.pointerType === 'mouse') && end(), true);
  desk.addEventListener('lostpointercapture', e => book.ink.cancel(e));
  addEventListener('blur', end);
  document.addEventListener('visibilitychange', () => document.hidden && end());
}
// A stroke lifted: into its page's px (pan and zoom undone), onto its ink, the page grown to hold it, and saved soon
export function dried(book, stroke, hooks) {
  const v = book.views[book.target],
    page = v.page,
    { pan, scale: s } = book;
  const round = n => Math.round(n * 100) / 100;
  const line = {
    ...stroke,
    size: book.inking.size,
    points: stroke.points.map(([x, y, p, t]) => [round(x / s + pan.x), round(y / s + pan.y), p, t]),
  };
  // Only the pen edits content. A highlighter always leaves ink.
  if (!(line.alpha < 1)) {
    // A scratch-out deletes its group without keeping the gesture as ink.
    if (book.groups?.scratch(v, line)) return book.ink.clear();
    // A line across words strikes them out or slices them open instead of adding ink.
    if (book.amend?.claim(stroke, book.pointer)) return book.ink.clear();
    // A stroke that circled a scrap and was lifted on the list it opened handed the scrap over (bookassign.js).
    if (book.assign?.claim()) return book.ink.clear();
  }
  // (into the unit it starts on, else the board's drawing it comes near, else a new unit of its own: bookunits.js.
  page.blank = false;
  line.g = inkUnit(page, line);
  page.ink.push(line);
  book.ink.clear();
  book.steps.push({
    page,
    stroke: line,
    undo: () => unstroke(book, hooks, page, line),
    redo: () => restroke(book, hooks, page, line),
  });
  // (the unit grows to hold it, and the page is laid again round it)
  hooks.lay();
  v.addInk(line);
  changed(book, page);
}
// A stroke undone: it goes, and the growth it made; its page comes into view if it's out of it
function unstroke(book, hooks, page, stroke) {
  page.ink.splice(page.ink.lastIndexOf(stroke), 1);
  inkChanged(book, hooks, page, stroke);
}
// (and made again)
function restroke(book, hooks, page, stroke) {
  page.ink.push(stroke);
  inkChanged(book, hooks, page, stroke);
}
function inkChanged(book, hooks, page, stroke) {
  const i = book.views.findIndex(v => v.page === page);
  if (i >= 0) {
    hooks.lay();
    book.views[i].redraw(boxOf(stroke));
    hooks.inView(i, boxOf(stroke));
  }
  changed(book, page);
}
