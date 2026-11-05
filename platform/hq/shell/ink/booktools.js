// The book's tools for a mouse and a pen: what a press on the paper does with the tool in use (bookpalette.js: the pen,
// the marker, the eraser, shapes, Select and typed words). Only Select moves things (bookselect.js): with
// any other tool a picture taped in is paper like the page, and the pen draws on it. The eraser and shapes start
// anywhere on the page.
//
// bookpages.js mounts them and asks, on a press on the paper: press(e) true: taken here; otherwise the pen draws with
// ink(). Never on a locked page: bookwrite.js asks none of them there.
import { stylesheet } from '../../util.js';
import { mountTexts } from './booktexts.js';
import { begin } from './bookedit.js';
import { mountPalette, inkOf, eraserRadius, setMode, gestures } from './bookpalette.js';
import { mountStrip } from './bookstrip.js';
import { mountInput } from './bookinput.js';
import { mountVoice } from './bookvoice.js';
import { mountSelect } from './bookselect.js';
import { mountShapes } from './bookshapes.js';
import { mountEraser } from './bookerase.js';
import { followPress } from './bookpress.js';
import { wandered } from '/__review/tap.js';
import { RESTING } from './bookwrite.js';

// a second press this soon and this near the first, on bare paper, is a double click: a box of typed words there
const DOUBLE_MS = 450,
  DOUBLE_PX = 5;

// book: bookpages.js's (at(), scale, views, steps, desk, ink, shown()). paper: the book's paper. hooks: { lay() (the
// page laid again, grown to hold what's on it), changed(page) (saved soon), redraw(view, box) (the strips a box of a
// page crosses drawn again), rubbed(view, box) (only that box painted again), refresh(view) }.
export function mountTools(book, paper, hooks) {
  stylesheet('shell/ink/booktools.css');
  const st = { book, paper, hooks, last: null }; // (last: the last press on bare paper, for a double click)
  st.texts = mountTexts(book, { changed: hooks.changed, boxLeft: hooks.boxLeft, color: () => st.pen });
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
  // (the rail, its mic after Text, and whether a finger draws.)
  st.strip = mountStrip(st, setMode);
  mountVoice(book, st.buttons.text);
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
    // Whether a line drawn now may be a gesture (the grid's circle and line): the pen's own nib's alone, never the
    // pencil's or the brush's.
    gestures: () => gestures(st),
    press: e => press(st, e),
    // A Pencil's tap on a box of words its ink would draw over (the highlighter's): it's edited, the caret there.
    tapped: (box, at) => st.texts.edit(box, at),
    // A picture just taped in: picked, so it moves and scales at once.
    taped: (view, scrap) => st.select.pick(view, { scraps: [scrap] }),
    added: view => st.texts.added(view),
    // Words set on a page in a box of their own (pasted, dropped, a voice note heard): booktexts.js put.
    put: (...a) => st.texts.put(...a),
    // The pen's colour now, what words put on a page take (a voice note's as they're heard: bookheard.js)
    color: () => st.pen,
    // The dot a double tap's first tap drew taken off, before its second press is held for a voice note (bookinput.js)
    undot: stepAtPress => undot(st, stepAtPress),
    // One tool on or back along the rail (Ctrl and the wheel: bookpan.js).
    cycle: by => st.strip.cycle(by),
    // (whether words are being typed in a box: a page read again waits for it to be left. leave: a caret alone gives
    // way to the read, and comes back after it.)
    typing: () => st.texts.typing(),
    leave: () => st.texts.leave(),
    // (before Undo or Redo: the words being typed kept, a selection let go.)
    settle() {
      st.texts.done();
      st.select.settle();
    },
  };
}
// ---- a press on the paper

// True when the press is taken here: a field's or a control's (nothing draws), Select's, a box of typed words (edited,
// or moved by its grip), or a new box of words (the text tool, or a double click on bare paper)
function press(st, e) {
  const { book } = st,
    mouse = e.pointerType === 'mouse' && e.button === 0,
    // (a finger is the tools' too, where it doesn't move the page: bookpan.js.)
    finger = e.pointerType === 'touch' && !book.input?.fingerPans?.();
  if (!e.isPrimary || !(mouse || finger || e.pointerType === 'pen')) return false;
  const target = e.target instanceof Element ? e.target : null,
    box = target?.closest('.bk-typed'),
    grip = !!target?.closest('.bk-typed-grip');
  // (a press anywhere but in the words being typed keeps them: a press on the paper takes no focus by itself)
  if (st.texts.editing() && (grip || !box?.matches('[data-editing]'))) st.texts.done();
  // (a box's grip moves it straight away, with any tool: Select's move.)
  if (grip) return st.select.grab(box, e, { keep: st.mode === 'select' });
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
  // (a scrap's words kept from Scribble for the pen, or not being typed in, take a pen's or a finger's strokes, with the
  // tools that draw: ink over them. README, Our scraps)
  const penned =
    !['select', 'text'].includes(st.mode) &&
    target?.closest(mouse ? 'textarea[data-pen]' : `textarea[data-pen], ${RESTING}`);
  if (!penned && target?.closest('input, textarea, select, [contenteditable], button, a, label')) return true;
  const at = book.at(e.clientX, e.clientY);
  if (!at || !at.view.page.ink) return false;
  if (st.mode === 'eraser') return st.erasing.press(e, at);
  if (st.mode === 'shapes') return st.shaping.press(e, at);
  if (st.mode === 'text') {
    e.preventDefault();
    if (mouse) st.texts.place(at, roomTo(st, e));
    // (a touch's box once it lifts as a tap: an iPad brings up its keyboard only for a caret placed at a lift, never at
    // a press, and a Pencil that moves on writes nothing with the text tool.)
    else placeAtLift(st, e, at);
    return true;
  }
  return mouse && doubled(st, e, at);
}

// The text tool's press by touch: its box placed once it lifts, if it never went past a tap's reach
function placeAtLift(st, down, at) {
  let far = false;
  followPress(down, {
    move: m => (far ||= wandered(down, m)),
    up: u => u.type !== 'pointercancel' && !far && st.texts.place(at, roomTo(st, down)),
  });
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
// The dot a double click's first press drew taken off: the book's last step, if it's a stroke of a few px made since that press, undone as Undo would.
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
