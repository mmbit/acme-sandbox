// The book's tools for a mouse and a pen: what a press on the paper does with the tool in use (bookpalette.js: the pen,
// the highlighter, the eraser, shapes, Select, typed words and the hand). A press on something on a page moves it: a
// picture taped in follows the pointer, lifted a little, and lands where it's let go; a box of typed words moves by its
// grip (booktexts.js). (the sheets' post-its gone) Ink starts only on bare
// paper; the eraser and shapes start anywhere on the page. (eraser, shapes, Select: job #19243)
//
// bookpages.js mounts them and asks, on a press on the paper: hand mode (mode()) pans; press(e) true: taken here;
// otherwise the pen draws with ink().
import { stylesheet } from '../../util.js';
import { stackLeft } from './bookui.js';
import { scrapBoxOf } from './bookrow.js';
import { scrapAt, slid } from './bookscrap.js';
import { drawScrap } from './sketchscraps.js';
import { mountTexts } from './booktexts.js';
import { sfx } from '../audio.js';
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
// a press on a picture moves it once it has moved this far (screen px); let go, it settles onto the paper in SETTLE_MS
// (booktools.css: .bk-lifted's transition)
const DRAG_PX = 3,
  SETTLE_MS = 120;

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
  // (the strip, and a press held: a voice note or the radial menu, and whether a finger draws.)
  st.strip = mountStrip(st, setMode);
  mountInput(book);
  hovering(st);
  // (pages read before the tools were here: their words now)
  for (const view of book.views) st.texts.added(view);
  return toolsOf(st);
}
// What the book asks of its tools (book.tools)
function toolsOf(st) {
  const { book } = st;
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
    // One tool on or back through the strip (a mouse's wheel: bookpan.js).
    cycle: by => st.strip.cycle(by),
    // A tool picked (the radial menu), and the dot a first tap drew at a point on screen taken off (bookinput.js)
    use: mode => setMode(st, mode),
    buttons: () => st.buttons,
    undot(x, y) {
      const at = book.at(x, y);
      if (at) undot(st, at);
    },
    // (whether words are being typed in a box: a page read again leaves its boxes as they are.)
    editing: () => st.texts.editing(),
    // (before Undo or Redo: the words being typed kept, a selection let go.)
    settle() {
      st.texts.done();
      st.select.settle();
    },
  };
}
// A grab cursor over a picture a press would move (a box of words' is its own css)
function hovering(st) {
  const desk = st.book.desk;
  desk.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || e.buttons || st.moving) return;
    const at = ['pen', 'highlighter'].includes(st.mode) ? st.book.at(e.clientX, e.clientY) : null,
      over = at?.view.page.scraps && scrapAt(at.view.page.scraps, [at.x, at.y]) >= 0;
    if (over) desk.dataset.over = 'grab';
    else delete desk.dataset.over;
  });
  desk.addEventListener('pointerleave', () => delete desk.dataset.over);
}

// ---- a press on the paper

// True when the press is taken here: a field's or a control's (nothing draws), a box of typed words, a picture
// (moved), or a new box of words (the text tool, or a double click on bare paper)
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
  // (with another tool, what's picked still moves and scales by its frame (a picture just taped in); a press elsewhere
  // lets it go.)
  if (st.select.holds(e)) return st.select.press(e);
  st.select.settle();
  // (a box of words is the highlighter's, the eraser's and a shape's to draw over, but for its grip)
  const over = ['highlighter', 'eraser', 'shapes'].includes(st.mode);
  if (box && (!over || target.closest('.bk-typed-grip') || box.matches('[data-editing]')))
    return st.texts.press(box, e);
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
  if (mouse) {
    const k = scrapAt(at.view.page.scraps, [at.x, at.y]);
    if (k >= 0) return moveScrap(st, at, k, e);
    if (doubled(st, e, at)) return true;
  }
  return false;
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
  st.last = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  if (!last || e.timeStamp - last.t > DOUBLE_MS || Math.hypot(e.clientX - last.x, e.clientY - last.y) > DOUBLE_PX)
    return false;
  st.last = null;
  undot(st, at);
  e.preventDefault();
  st.texts.place(at, roomTo(st, e));
  return true;
}
// The dot a first press drew taken off: the book's last step, a stroke of a few px on this page around the point (a
// double click's, and a double tap's that holds for a voice note: bookinput.js)
function undot(st, at) {
  const steps = st.book.steps,
    dot = steps.at(-1);
  if (!(dot?.stroke && dot.page === at.view.page && isDot(dot.stroke, at))) return;
  steps.pop();
  const ink = at.view.page.ink;
  ink.splice(ink.lastIndexOf(dot.stroke), 1);
  st.hooks.redraw(at.view, boxAround(dot.stroke));
  st.hooks.changed(at.view.page);
}
// Where a new box's words must wrap by, in its page's px: before the paper's edge or the islands over it, whichever
// comes first at the press's height
function roomTo(st, e) {
  const desk = st.book.desk.getBoundingClientRect(),
    right = Math.min(desk.right, stackLeft() ?? desk.right) - 16;
  return st.book.at(right, e.clientY)?.x ?? st.book.shown().x1;
}
function isDot(stroke, at) {
  const b = boxAround(stroke);
  return b.x1 - b.x0 < 12 + stroke.size * 2 && b.y1 - b.y0 < 12 + stroke.size * 2 && b.x0 < at.x && at.x < b.x1;
}
function boxAround(stroke) {
  const r = stroke.size + 2,
    xs = stroke.points.map(p => p[0]),
    ys = stroke.points.map(p => p[1]);
  return { x0: Math.min(...xs) - r, y0: Math.min(...ys) - r, x1: Math.max(...xs) + r, y1: Math.max(...ys) + r };
}

// ---- moving a picture

// A press on a picture: once it moves, the picture lifts off its page (a light shadow, a touch bigger) and follows the
// pointer; let go, it lands there, on top of the others, saved, one step Undo takes back. A click leaves it be.
function moveScrap(st, at, k, e) {
  const { book } = st,
    { view } = at,
    page = view.page,
    s = page.scraps[k],
    scale = book.scale || 1;
  e.preventDefault();
  let lifted = null;
  const d = m => [(m.clientX - e.clientX) / scale, (m.clientY - e.clientY) / scale];
  const move = m => {
    if (m.pointerId !== e.pointerId) return;
    if (!lifted && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < DRAG_PX) return;
    lifted ??= lift(st, view, page, s);
    const to = slid(s, d(m), page);
    lifted.style.translate = `${to.x - s.x}px ${to.y - s.y}px`;
  };
  const up = u => {
    if (u.pointerId !== e.pointerId) return;
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
    if (!lifted) return;
    const from = { x: s.x, y: s.y, i: k },
      to = u.type === 'pointercancel' ? from : slid(s, d(u), page),
      same = to.x === from.x && to.y === from.y;
    land(st, view, page, s, same ? from : to, lifted);
    if (same) return;
    st.hooks.changed(page);
    book.steps.push({
      undo: () => {
        land(st, view, page, s, from);
        st.hooks.changed(page);
      },
    });
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
  return true;
}

// The picture off its page's strips onto a canvas of its own over them, lifted
function lift(st, view, page, s) {
  st.moving = true;
  st.book.desk.dataset.over = 'grabbing';
  const box = scrapBoxOf(s),
    pad = 2,
    k = (devicePixelRatio || 1) * Math.max(1, st.book.scale || 1);
  const c = document.createElement('canvas');
  c.className = 'bk-lifted';
  const w = box.x1 - box.x0 + 2 * pad,
    h = box.y1 - box.y0 + 2 * pad;
  Object.assign(c, { width: Math.ceil(w * k), height: Math.ceil(h * k) });
  Object.assign(c.style, { left: `${box.x0 - pad}px`, top: `${box.y0 - pad}px`, width: `${w}px`, height: `${h}px` });
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, (pad - box.x0) * k, (pad - box.y0) * k);
  drawScrap(g, s);
  view.el.append(c);
  page.scraps.splice(page.scraps.indexOf(s), 1);
  st.hooks.redraw(view, box);
  sfx.tick();
  requestAnimationFrame(() => (c.dataset.up = ''));
  return c;
}
// The picture down at a place ({ x, y }, and i: its place among the others, else on top), drawn on its page again
function land(st, view, page, s, to, lifted = null) {
  const was = scrapBoxOf(s),
    n = page.scraps.indexOf(s);
  if (n >= 0) page.scraps.splice(n, 1);
  Object.assign(s, { x: to.x, y: to.y });
  page.scraps.splice(to.i ?? page.scraps.length, 0, s);
  const now = scrapBoxOf(s);
  // (the page grown to hold it where it hangs past an edge, and both its places drawn again)
  const drawn = () => {
    st.hooks.lay();
    st.hooks.redraw(view, {
      x0: Math.min(was.x0, now.x0),
      y0: Math.min(was.y0, now.y0),
      x1: Math.max(was.x1, now.x1),
      y1: Math.max(was.y1, now.y1),
    });
  };
  if (!lifted) return drawn();
  st.moving = false;
  delete st.book.desk.dataset.over;
  sfx.land();
  // Let go: it settles onto the paper (its lift and shadow ease off), then the page draws it and the canvas goes, the
  // frame after, once the strips under it show it
  delete lifted.dataset.up;
  const settled = () => {
    drawn();
    requestAnimationFrame(() => lifted.remove());
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) settled();
  else setTimeout(settled, SETTLE_MS);
}
