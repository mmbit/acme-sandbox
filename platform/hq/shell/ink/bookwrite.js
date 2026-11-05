// Writing in the book: whether a press writes (the Pencil and a mouse on a page whose ink is read and that isn't locked,
// unless the press pans or a tool takes it: every tool's press passes here), and a stroke lifted onto its page, one step
// for Undo and Redo.
import { INKS } from '/__review/ink.js';
import { at } from './bookview.js';
import { boxOf } from './bookrow.js';
import { inkUnit } from './bookunits.js';
import { changed, shut } from './booksave.js';
import { scrapAt } from './bookscrap.js';
import { isTap, wandered } from '/__review/tap.js';
import { followPress } from './bookpress.js';
import { newId } from './bookedit.js';

// The book's ink until the tools say otherwise: Night, at review mode's pen size
export const INK = { color: '#2a2352', size: INKS[0].size };

// The Pencil and a mouse write on the page once its ink is read, unless the press pans (bookpan.js) or the mouse's
// tools take it (moving a picture, a text box: booktools.js); a finger does too, unless it moves the page: with the
// hand, or where this device's preferences say so (on since its first pen) (book.input.fingerPans(): bookinput.js). A text field on a page (a
// reply's) is the field's: the Pencil writes into it with Scribble. The Pencil or a finger on something on the page (a
// box of words, an answer's slip, a scrap's photo or its words) waits: a quick tap there is a click on it, never a dot
// of ink, and once it moves its line starts where it touched (a stroke starts anywhere: README, Our scraps). On bare paper it inks at once, so a dotted i keeps its dot.
// The grid takes no ink: a press there by anything is a tap if it lifts where it came down (gridPress).
export function drawable(book, e, table) {
  if (e === book.waited) {
    book.waited = null;
    return true;
  }
  // (a note's words kept from Scribble for the pen take its strokes as ink; a read refused, over the page, is tapped to try again)
  // (a scrap's words not being typed in are the page's to draw on by touch: README, Our scraps; a mouse's press there
  // is the field's)
  const field = e.pointerType === 'mouse' ? 'textarea:not([data-pen])' : `textarea:not([data-pen], ${RESTING})`;
  if (e.target.closest?.(`${field}, input, [contenteditable], button, .bk-lost`)) return false;
  const mouse = e.pointerType === 'mouse';
  if (!e.isPrimary || (mouse && (e.button !== 0 || table.panning(e)))) return false;
  const hit = at(book, e.clientX, e.clientY);
  if (!hit) return false;
  // (the grid takes no ink: a tap there opens a scrap or makes one, a ring and a line are bookgridgesture.js's. Every
  // press is followed, a finger's that pans the grid too, and acts only if it lifts where it came down.
  if (!hit.view.page.focus) return gridPress(book, e, hit);
  // (a finger writes too, where it doesn't move the page: bookpan.js.)
  const writes = e.pointerType === 'pen' || mouse || (e.pointerType === 'touch' && !book.input?.fingerPans?.());
  if (!writes || table.panning(e)) return false;
  // (a page not read yet, or locked (sent, or read-only), takes no tool's press: asked here before any tool is, so none
  // can draw, move or type on it and a new one can't miss it.)
  if (!hit.view.page.ink || shut(hit.view.page) || book.tools?.press(e)) return false;
  table.stop();
  book.target = hit.i;
  book.inking = book.tools?.ink() ?? INK;
  if (e.pointerType !== 'mouse' && onSomething(e, hit)) return waitFor(book, e);
  return true;
}
// A press on the grid: lifted where it came down, however long it was held, it's a tap (bookscrapopen.js tapped). On
// a page not read yet it's held, and tapped once the page is read (its read's own, never one of its own: a read
// refused shows over the page, tapped to try again).
function gridPress(book, down, hit) {
  let far = false;
  const tap = () => hit.view.page.ink && book.scrap?.tapped(hit.view, hit.x, hit.y);
  followPress(down, {
    move: m => (far ||= wandered(down, m)),
    up: u => !far && u.type !== 'pointercancel' && (hit.view.page.ink ? tap() : hit.view.reading?.then(tap)),
  });
  return false;
}
const onSomething = (e, hit) =>
  !!e.target.closest?.(`.bk-typed, .answer-slip, ${RESTING}`) || scrapAt(hit.view.page.scraps, [hit.x, hit.y]) >= 0;
// A scrap's words not being typed in: a press there waits like one on its photo, a tap the field's (its caret), a line
// drawn from it ink on the page
export const RESTING = 'textarea.bk-scrap-words:not(:focus)';
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
  // (only the desk's own capture: a finger's press is held by what it lands on until the line takes it to the desk,
  // and that lost hold is no lost line.)
  desk.addEventListener('lostpointercapture', e => e.target === desk && book.ink.cancel(e));
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
    id: newId(), // (its own: bookedit.js)
  };
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
// A stroke undone: it goes, and the growth it made (out of sight, Undo slid there first: bookedit.js)
function unstroke(book, hooks, page, stroke) {
  const n = page.ink.lastIndexOf(stroke);
  // (one already gone, rubbed out or its unit deleted by someone else, takes nothing else with it)
  if (n < 0) return;
  page.ink.splice(n, 1);
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
  }
  changed(book, page);
}
