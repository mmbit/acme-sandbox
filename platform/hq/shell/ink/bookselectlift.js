// The select tool's live move and resize (bookselect.js): what's picked lifts off its page's tiles onto a canvas of its
// own over them and follows the pointer by a CSS transform (moved, or scaled about the opposite corner), its boxes of
// words by a translate, so what shows while it's held is what lands. Let go, it lands as new things in the page's lists
// (bookselectmath.js), one step for Undo, and the canvas goes once the tiles under it show them. Carried onto a call's
// window instead, its pictures go to the call (calldrop.js) and everything stays where it was on the page.
import { draw } from '/__review/ink.js';
import { drawScrap } from './sketchscraps.js';
import { sfx } from '../audio.js';
import { grownTo } from './bookrow.js';
import { boundsOf, mapBox, moveBy, movedText, movedThings, scaleAt, union } from './bookselectmath.js';
import { bounds, boxOfText, frameAt, frameDown, pageOf, swapIn, textEl } from './bookselect.js';
import { followPress } from './bookpress.js';
import { callWindowAt, dropOnCall, lightCall } from '../calldrop.js';

// a press moves or scales once it has moved this far (screen px); let go, the lifted things settle in SETTLE_MS
// (bookselect.css: .bk-sel-lifted's transition)
const DRAG_PX = 3,
  SETTLE_MS = 120;
// the lifted canvas's room round its ink (page px), and the most device px it holds (an iPad's Safari draws no bigger)
const PAD = 2,
  CANVAS_MAX = 16e6;

// A press on the selection (corner -1) or on a corner's handle (0 top-left, then clockwise): it lifts once it moves,
// and lands where it's let go
export function drag(sel, e, { corner }) {
  const { book } = sel,
    from = pageOf(book, e),
    b = bounds(sel);
  let held = null,
    tr = moveBy(0, 0);
  const move = m => {
    if (!held && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < DRAG_PX) return;
    held ??= lift(sel, corner);
    const to = pageOf(book, m);
    tr = corner < 0 ? moved(from, to, m.shiftKey) : scaleAt(b, corner, to, book.scale, sel.ink);
    shown(sel, held, tr);
    held.onCall = !!sel.scraps.length && !!callWindowAt(m.clientX, m.clientY);
    lightCall(held.onCall);
  };
  const up = u => {
    if (!held) return;
    const onCall = held.onCall && u.type !== 'pointercancel';
    lightCall(false);
    // (on the call, the page keeps its own: the things land back where they were, at once)
    if (onCall && held.canvas) held.canvas.style.transform = '';
    drop(sel, held, onCall || u.type === 'pointercancel' ? null : tr);
    if (onCall) dropOnCall(sel.scraps.map(s => fetch(s.url).then(got => got.blob())));
  };
  followPress(e, { move, up });
  return true;
}
// A move from one point to another, anywhere (the paper is endless every way);
// with Shift, straight across or straight down
function moved(from, to, straight) {
  const d = [to[0] - from[0], to[1] - from[1]];
  if (straight) d[Math.abs(d[0]) > Math.abs(d[1]) ? 1 : 0] = 0;
  return moveBy(...d);
}

// What's picked off its page: its ink and pictures out of the page's lists onto a canvas over them (the tiles drawn
// without them in the same frame), its words' boxes held where they are. The step starts here.
function lift(sel, corner) {
  const { book, hooks, view } = sel,
    page = view.page;
  const held = {
    change: hooks.begin(view),
    things: { ink: sel.ink, scraps: sel.scraps, texts: sel.texts },
    was: { ink: page.ink.slice(), scraps: page.scraps.slice() },
    drawn: boundsOf({ ink: sel.ink, scraps: sel.scraps }, null),
    texts: sel.texts.map(t => ({ t, box: boxOfText(sel, t), el: textEl(view, t) })),
  };
  held.canvas = held.drawn && canvasFor(book, view, held.things, held.drawn);
  const out = new Set([...sel.ink, ...sel.scraps]);
  page.ink.splice(0, page.ink.length, ...held.was.ink.filter(s => !out.has(s)));
  page.scraps.splice(0, page.scraps.length, ...held.was.scraps.filter(s => !out.has(s)));
  if (held.drawn) hooks.redraw(view, held.drawn);
  book.desk.dataset.drag = corner < 0 ? 'move' : corner % 2 ? 'nesw' : 'nwse';
  sfx.tick();
  return held;
}
// The ink and pictures drawn on a canvas of their own, as the page draws them (pictures, then a highlighter's ink
// under a pen's), as sharp as the zoom shows them
function canvasFor(book, view, { ink, scraps }, box) {
  const w = box.x1 - box.x0 + 2 * PAD,
    h = box.y1 - box.y0 + 2 * PAD,
    k = Math.min((devicePixelRatio || 1) * Math.max(1, book.scale), Math.sqrt(CANVAS_MAX / (w * h)));
  const c = document.createElement('canvas');
  c.className = 'bk-sel-lifted';
  Object.assign(c, { width: Math.ceil(w * k), height: Math.ceil(h * k) });
  Object.assign(c.style, {
    left: `${box.x0 - PAD}px`,
    top: `${box.y0 - PAD}px`,
    width: `${c.width / k}px`,
    height: `${c.height / k}px`,
  });
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, (PAD - box.x0) * k, (PAD - box.y0) * k);
  for (const s of scraps) drawScrap(g, s);
  draw(g, [...ink.filter(s => s.alpha < 1), ...ink.filter(s => !(s.alpha < 1))]);
  view.el.append(c);
  requestAnimationFrame(() => (c.dataset.up = ''));
  return c;
}

// The held things where a change takes them: the canvas by a transform about the anchor, the words by a translate,
// the frame round them
function shown(sel, held, tr) {
  const { canvas, drawn } = held;
  if (canvas) {
    canvas.style.transformOrigin = `${tr.ax - drawn.x0 + PAD}px ${tr.ay - drawn.y0 + PAD}px`;
    canvas.style.transform = `translate(${tr.dx}px, ${tr.dy}px) scale(${tr.k})`;
  }
  const boxes = held.texts.map(({ t, box, el }) => {
    const to = movedText(t, tr, box),
      dx = to.x - t.x,
      dy = to.y - t.y;
    if (el) el.style.translate = `${dx}px ${dy}px`;
    return { x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 + dx, y1: box.y1 + dy };
  });
  frameAt(sel, [...(drawn ? [mapBox(tr, drawn)] : []), ...boxes].reduce(union));
}

// Let go: the things land as new ones in their places in the page's lists (none when they didn't move, or the press
// was cancelled), one step, the page grown to hold them; the canvas settles (its shadow eases off) and goes once the
// tiles under it are drawn again
function drop(sel, held, tr) {
  const { book, hooks, view } = sel,
    page = view.page,
    still = !tr || (tr.k === 1 && !tr.dx && !tr.dy),
    boxes = new Map(held.texts.map(({ t, box }) => [t, box])),
    swap = still ? new Map() : movedThings(held.things, tr, t => boxes.get(t));
  const now = x => swap.get(x) ?? x,
    after = { ink: held.things.ink.map(now), scraps: held.things.scraps.map(now), texts: held.things.texts.map(now) };
  page.ink.splice(0, page.ink.length, ...held.was.ink);
  page.scraps.splice(0, page.scraps.length, ...held.was.scraps);
  swapIn(page, swap);
  const landed = boundsOf({ ink: after.ink, scraps: after.scraps }, null);
  if (landed) Object.assign(page, grownTo(page, landed));
  held.change.end();
  hooks.lay();
  for (const { el } of held.texts) if (el) el.style.translate = '';
  if (!still) hooks.texts.added(view);
  delete book.desk.dataset.drag;
  Object.assign(sel, after);
  frameDown(sel);
  if (!still) sfx.land();
  const { canvas } = held;
  if (!canvas) return;
  delete canvas.dataset.up;
  const settled = () => {
    hooks.redraw(view, union(held.drawn, landed));
    requestAnimationFrame(() => canvas.remove());
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) settled();
  else setTimeout(settled, SETTLE_MS);
}
