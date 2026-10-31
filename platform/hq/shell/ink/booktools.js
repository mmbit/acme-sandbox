// The book's tools for a mouse and a pen: what a press on the paper does with the tool in use (bookpalette.js: the pen,
// the marker, the eraser, shapes, Select and typed words). Only Select moves things (bookselect.js): with
// any other tool a picture taped in is paper like the page, and the pen draws on it. (the sheets' post-its gone; the
// pictures' own grab-to-move gone, one way to move things: job #13071) The eraser and shapes start anywhere on the page.
// (eraser, shapes, Select: job #19243)
//
// bookpages.js mounts them and asks, on a press on the paper: press(e) true: taken here; otherwise the pen draws with
// ink().
import { stylesheet } from '../../util.js';
import { mountTexts } from './booktexts.js';
import { begin } from './bookedit.js';
import { mountPalette, inkOf, eraserRadius, setMode } from './bookpalette.js';
import { mountStrip } from './bookstrip.js';
import { mountAmend } from './bookamend.js';
import { mountInput } from './bookinput.js';
import { mountSelect } from './bookselect.js';
import { mountShapes } from './bookshapes.js';
import { mountEraser } from './bookerase.js';

// a second press this soon and this near the first, on bare paper, is a double click: a box of typed words there
const DOUBLE_MS = 450,
  DOUBLE_PX = 5;

// book: bookpages.js's (at(), scale, views, steps, desk, ink, shown()). paper: the book's paper. hooks: { lay() (the
// page laid again, grown to hold what's on it), changed(page) (saved soon), redraw(view, box) (the strips a box of a
// page crosses drawn again), refresh(view) }.
export function mountTools(book, paper, hooks) {
  stylesheet('shell/ink/booktools.css');
  const st = { book, paper, hooks, last: null }; // (last: the last press on bare paper, for a double click)
  st.texts = mountTexts(book, { changed: hooks.changed, color: () => st.pen });
  // (a stroke over words strikes or slices them: bookamend.js.)
  book.amend = mountAmend(book, st.texts);
  // (Select, shapes and the eraser: bookselect.js, bookshapes.js, bookerase.js; each change one step for Undo and Redo,
  // bookedit.js.)
  const edits = { ...hooks, begin: view => begin(book, view, hooks) };
  st.select = mountSelect(book, { ...edits, texts: st.texts });
  st.shaping = mountShapes(book, paper.querySelector('.bk-wet'), edits, () => ({
    ...inkOf(st),
    kind: st.shape,
    fill: st.fill,
  }));
  st.erasing = mountEraser(book, edits, () => eraserRadius(st));
  // (a tool put down lets its selection go)
  st.changedTool = () => st.select.settle();
  mountPalette(st);
  // (the rail, and a press held: a voice note or the radial menu, and whether a finger draws.)
  st.strip = mountStrip(st, setMode);
  mountInput(book);
  // (pages read before the tools were here: their words now)
  for (const view of book.views) st.texts.added(view);
  return toolsOf(st);
}
// What the book asks of its tools (book.tools)
function toolsOf(st) {
  return {
    mode: () => st.mode,
    ink: () => inkOf(st),
    press: e => press(st, e),
    // A Pencil's tap on a box of words its ink would draw over (the highlighter's): it's edited, the caret there.
    tapped: (box, at) => st.texts.edit(box, at),
    // A picture just taped in: picked, so it moves and scales at once.
    taped: (view, scrap) => st.select.pick(view, { scraps: [scrap] }),
    added: view => st.texts.added(view),
    // Words set on a page in a box of their own (pasted, dropped, a voice note heard): booktexts.js put.
    put: (...a) => st.texts.put(...a),
    // One tool on or back along the rail (Ctrl and the wheel: bookpan.js).
    cycle: by => st.strip.cycle(by),
    // A tool picked (the radial menu), and the dot a first tap drew taken off (bookinput.js, with the book's last step
    // as that tap pressed)
    use: mode => setMode(st, mode),
    buttons: () => st.buttons,
    undot: stepAtPress => undot(st, stepAtPress),
    // (whether words are being typed in a box: a page read again leaves its boxes as they are.)
    editing: () => st.texts.editing(),
    // (before Undo or Redo: the words being typed kept, a selection let go.)
    settle() {
      st.texts.done();
      st.select.settle();
    },
  };
}
// ---- a press on the paper

// True when the press is taken here: a field's or a control's (nothing draws), Select's, a box of typed words (edited),
// or a new box of words (the text tool, or a double click on bare paper)
function press(st, e) {
  const { book } = st,
    mouse = e.pointerType === 'mouse' && e.button === 0,
    // (a finger is the tools' too, where it doesn't move the page: bookpan.js.)
    finger = e.pointerType === 'touch' && !book.input?.fingerPans?.();
  if (!e.isPrimary || !(mouse || finger || e.pointerType === 'pen')) return false;
  const target = e.target instanceof Element ? e.target : null,
    box = target?.closest('.bk-typed');
  // (a press anywhere but in the words being typed keeps them: a press on the paper takes no focus by itself)
  if (st.texts.editing() && !box?.matches('[data-editing]')) st.texts.done();
  // (Ctrl or ⌘ held: Select for this press, the tool before it back once it's let go.)
  if (mouse && (e.ctrlKey || e.metaKey) && st.mode !== 'select' && !box?.matches('[data-editing]'))
    return selectFor(st, e);
  // (the select tool takes every press on the page but a field's, a control's and the words being typed:
  // bookselect.js.)
  const own = 'input, textarea, select, button, a, label, .bk-typed[data-editing]';
  if (st.mode === 'select' && !target?.closest(own)) return st.select.press(e) || true;
  // (with another tool, what's picked still moves and scales by its frame's handles (a picture just taped in); a press
  // anywhere else lets it go, and draws.)
  if (st.select.holds(e)) return st.select.press(e);
  st.select.settle();
  // (a box of words is the highlighter's, the eraser's and a shape's to draw over)
  const over = ['highlighter', 'eraser', 'shapes'].includes(st.mode);
  if (box && (!over || box.matches('[data-editing]'))) return st.texts.press(box, e);
  // (a scrap's words kept from Scribble for the pen take its strokes, with the tools that draw: bookamend.js.)
  const penned = !['select', 'text'].includes(st.mode) && target?.closest('textarea[data-pen]');
  if (!penned && target?.closest('input, textarea, select, [contenteditable], button, a, label')) return true;
  const at = book.at(e.clientX, e.clientY);
  if (!at || !at.view.page.ink) return false;
  if (st.mode === 'eraser') return st.erasing.press(e, at);
  if (st.mode === 'shapes') return st.shaping.press(e, at);
  if (st.mode === 'text') {
    e.preventDefault();
    st.texts.place(at, roomTo(st, e));
    return true;
  }
  return mouse && doubled(st, e, at);
}

// Ctrl or ⌘ held with the mouse: the press is Select's (a box drawn round things, or what's under it moved), and
// let go, the tool before it is back, what was picked still picked (it moves by its frame with any tool). On a Mac,
// Ctrl's press is a right click too: its menu doesn't open.
function selectFor(st, e) {
  const was = st.mode;
  setMode(st, 'select');
  st.select.press(e);
  const menu = c => c.preventDefault();
  const up = u => {
    if (u.pointerId !== e.pointerId) return;
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    // (after Select's own lift has run: its picks kept)
    setTimeout(() => {
      removeEventListener('contextmenu', menu, true);
      if (st.mode === 'select') setMode(st, was, { keep: true });
    });
  };
  addEventListener('contextmenu', menu, true);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  return true;
}

// A second press of a double click on bare paper: the dot the first one drew taken off, and a box of words there
function doubled(st, e, at) {
  const last = st.last;
  st.last = { t: e.timeStamp, x: e.clientX, y: e.clientY, stepAtPress: st.book.steps.at(-1) };
  if (!last || e.timeStamp - last.t > DOUBLE_MS || Math.hypot(e.clientX - last.x, e.clientY - last.y) > DOUBLE_PX)
    return false;
  st.last = null;
  undot(st, last.stepAtPress);
  e.preventDefault();
  st.texts.place(at, roomTo(st, e));
  return true;
}
// The dot a first press drew taken off (a double click's, and a double tap's that holds for a voice note:
// bookinput.js): the book's last step, if it's a stroke of a few px made since that press, undone as Undo would.
// Known by its step, not by where it is: a new unit's dot moves with it once the page is saved and laid again.
function undot(st, stepAtPress) {
  const steps = st.book.steps,
    dot = steps.at(-1);
  if (!(dot !== stepAtPress && dot?.stroke && isDot(dot.stroke))) return;
  steps.pop();
  dot.undo();
}
// Where a new box's words must wrap by, in its page's px: before the paper's edge
function roomTo(st, e) {
  const desk = st.book.desk.getBoundingClientRect(),
    right = desk.right - 16;
  return st.book.at(right, e.clientY)?.x ?? st.book.shown().x1;
}
function isDot(stroke) {
  const b = boxAround(stroke);
  const small = 12 + stroke.size * 2;
  return b.x1 - b.x0 < small && b.y1 - b.y0 < small;
}
function boxAround(stroke) {
  const r = stroke.size + 2,
    xs = stroke.points.map(p => p[0]),
    ys = stroke.points.map(p => p[1]);
  return { x0: Math.min(...xs) - r, y0: Math.min(...ys) - r, x1: Math.max(...xs) + r, y1: Math.max(...ys) + r };
}
