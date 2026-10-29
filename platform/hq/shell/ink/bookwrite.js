// Writing in the book: whether a press writes (the Pencil and a mouse on a page whose ink is read, unless the press
// pans or a tool takes it), and a stroke lifted onto its page, one step for Undo and Redo. (moved here from bookpages.js, and Redo: job #19243)
import { INKS } from '/__review/ink.js';
import { at, setView } from './bookview.js';
import { boxOf, grownTo, pageBox, spanOf } from './bookrow.js';
import { changed, shut } from './booksave.js';
import { scrapAt } from './bookscrap.js';
import { isTap, wandered } from '/__review/tap.js';
import { followPress } from './bookpress.js';

// The book's ink until the tools say otherwise: Night, at review mode's pen size
export const INK = { color: '#2a2352', size: INKS[0].size };

// The Pencil and a mouse write on the page once its ink is read, unless the press pans (bookpan.js) or the mouse's
// tools take it (moving a picture, a text box: booktools.js); a finger does too, unless this device's preferences
// have it move the page once a pen is in use (book.input.fingerPans(): bookinput.js). A text field on a page (a
// reply's) is the field's: the Pencil writes into it with Scribble. The Pencil on something on the page (a box of
// words, an answer's slip, a picture) waits: a quick tap there is a click on it, never a dot of ink, and once it
// moves its line starts where it touched. On bare paper it inks at once, so a dotted i keeps its dot.
export function drawable(book, e, table) {
  if (e === book.waited) {
    book.waited = null;
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
  }
  // (a page written on keeps its size, whatever the paper does next, and grows to hold what's written on it)
  page.blank = false;
  // (it grows any way, its top-left too.)
  const box = pageBox(page),
    was = { x: box.x0, y: box.y0, w: page.w, h: page.h },
    grown = grownTo(page, boxOf(line)),
    grew = grown.w > was.w || grown.h > was.h;
  if (grew) {
    Object.assign(page, grown);
    v.place();
  }
  page.ink.push(line);
  v.addInk(line);
  book.ink.clear();
  const grewFrom = grew ? was : null;
  book.steps.push({
    page,
    stroke: line,
    undo: () => unstroke(book, hooks, page, line, grewFrom),
    redo: () => restroke(book, hooks, page, line, grown),
  });
  if (grew) setView(book);
  changed(book, page);
}
// A stroke undone: it goes, and the growth it made; its page comes into view if it's out of it
function unstroke(book, hooks, page, stroke, grewFrom) {
  page.ink.splice(page.ink.lastIndexOf(stroke), 1);
  if (grewFrom) Object.assign(page, grewFrom);
  inkChanged(book, hooks, page, boxOf(stroke));
}
// (and made again)
function restroke(book, hooks, page, stroke, grown) {
  page.ink.push(stroke);
  Object.assign(page, spanOf(page, grown));
  inkChanged(book, hooks, page, boxOf(stroke));
}
function inkChanged(book, hooks, page, box) {
  const i = book.views.findIndex(v => v.page === page);
  if (i >= 0) {
    book.views[i].place();
    book.views[i].redraw(box);
    hooks.lay();
    hooks.inView(i, box);
  }
  changed(book, page);
}
