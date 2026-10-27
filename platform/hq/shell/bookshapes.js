// Shapes in the book: an ellipse, a rectangle, a line or an arrow, outlined or filled, in the pen's colour and width,
// drawn from where the press starts to where it's let go (Shift: a circle, a square, a line at 45°). It shows live on
// the book's wet canvas as it's pulled out, and lands as ink.js's plain stroke on the page (bookstrokes.js shape), one
// step for Undo and Redo (bookedit.js). A shape is ink like any line: a ring round something is a mark as the pen's
// ring is, and a line or an arrow from one note's number to another's links them (booksheet.js claim), as the pen's
// line does.
import { draw, fit } from '/__review/ink.js';
import { shape } from './bookstrokes.js';
import { boxOf, grownTo } from './bookrow.js';
import { followPress } from './bookpress.js';

// book: bookpages.js's. wet: the book's wet canvas, over the paper. hooks: { begin(view), lay() }. tool(): { kind,
// fill, color, size, alpha? }. Returns { press(e, at) }.
export function mountShapes(book, wet, hooks, tool) {
  return { press: (e, at) => pull(book, wet, hooks, tool(), e, at) };
}

function pull(book, wet, hooks, t, e, at) {
  e.preventDefault();
  const { view } = at,
    from = [at.x, at.y],
    ink = { color: t.color, size: t.size, ...(t.alpha < 1 ? { alpha: t.alpha } : {}) };
  let made = null,
    frame = 0,
    last = e;
  const of = m => shape(t.kind, from, pointOf(book, m), ink, { even: m.shiftKey, fill: t.fill });
  // (drawn once a frame, however many moves came: a pen sends twice as many)
  const paint = () => {
    frame = 0;
    made = of(last);
    const g = fit(wet);
    wet.style.opacity = 1;
    if (!made) return;
    const { pan, scale: s } = book;
    g.transform(s, 0, 0, s, -pan.x * s, -pan.y * s);
    draw(g, [made]);
  };
  const move = m => {
    last = m;
    frame ||= requestAnimationFrame(paint);
  };
  // (Shift pressed or let go mid-pull: the shape snaps or frees at once)
  const shift = k => {
    if (k.key !== 'Shift') return;
    last = { clientX: last.clientX, clientY: last.clientY, shiftKey: k.type === 'keydown' };
    frame ||= requestAnimationFrame(paint);
  };
  const up = u => {
    off();
    cancelAnimationFrame(frame);
    const stroke = u.type === 'pointercancel' ? null : of(u.type === 'pointerup' ? u : last);
    if (stroke) land(book, view, hooks, stroke, t.kind);
    // (the wet shape goes the frame after the dry one shows, so nothing flickers)
    requestAnimationFrame(() => fit(wet));
  };
  const off = listen({ keydown: shift, keyup: shift });
  followPress(e, { move, up });
  return true;
}
// Listeners on the window, caught first; returns the way to take them off
function listen(on) {
  for (const [type, f] of Object.entries(on)) addEventListener(type, f, true);
  return () => Object.entries(on).forEach(([type, f]) => removeEventListener(type, f, true));
}
// A point on screen in the page's px, wherever it is (off the paper too, as a shape is pulled past its edge)
function pointOf(book, m) {
  const r = book.desk.getBoundingClientRect();
  return [book.pan.x + (m.clientX - r.left) / book.scale, book.pan.y + (m.clientY - r.top) / book.scale];
}
// The shape onto its page: a line between two numbers is the sheet's link, anything else ink, the page grown to hold it
function land(book, view, hooks, stroke, kind) {
  const ends = kind === 'arrow' ? { ...stroke, points: stroke.points.slice(0, 2) } : stroke;
  if ((kind === 'line' || kind === 'arrow') && book.sheets?.claim(view, ends)) return;
  const change = hooks.begin(view),
    page = view.page;
  Object.assign(page, grownTo(page, boxOf(stroke)));
  page.ink.push(stroke);
  view.place();
  hooks.lay();
  view.addInk(stroke);
  change.end();
}
