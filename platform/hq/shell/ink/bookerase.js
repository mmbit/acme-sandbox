// The book's eraser: it takes ink where it passes, at the size chosen (bookpalette.js), as a real eraser does: a line
// it crosses is cut there and the rest stays, a filled shape it touches goes whole (bookstrokes.js rub). Pictures,
// typed words and post-its are never its: they go with a scratch-out over their group or its clip's Delete
// (bookgroups.js), or Select's Delete. A rub, however long, is one step for Undo and Redo (bookedit.js).
import { rub } from './bookstrokes.js';
import { followPress } from './bookpress.js';

// a quick flick reports points far apart: the rub goes every STEP of its radius between them
const STEP = 0.5;

// book: bookpages.js's. hooks: { begin(view), redraw(view, box) }. radius(): the eraser's on screen (CSS px).
// Returns { press(e, at) }.
export function mountEraser(book, hooks, radius) {
  return { press: (e, at) => rubbing(book, hooks, radius() / (book.scale || 1), e, at) };
}

function rubbing(book, hooks, r, e, at) {
  e.preventDefault();
  const { view } = at,
    page = view.page,
    change = hooks.begin(view);
  let last = [at.x, at.y];
  // (a Pencil has no cursor: a ring the eraser's size follows its tip while it rubs)
  const ring = e.pointerType === 'mouse' ? null : ringAt(book, r * book.scale, e);
  const pass = to => {
    const n = Math.max(1, Math.ceil(Math.hypot(to[0] - last[0], to[1] - last[1]) / (r * STEP)));
    for (let i = 1; i <= n; i++) {
      const b = [last[0] + ((to[0] - last[0]) * i) / n, last[1] + ((to[1] - last[1]) * i) / n],
        a = [last[0] + ((to[0] - last[0]) * (i - 1)) / n, last[1] + ((to[1] - last[1]) * (i - 1)) / n],
        done = rub(page.ink, a, b, r);
      if (!done) continue;
      page.ink.splice(0, page.ink.length, ...done.ink);
      hooks.redraw(view, done.box);
    }
    last = to;
  };
  pass(last);
  followPress(e, {
    move: m => {
      const each = m.getCoalescedEvents?.();
      for (const c of each?.length ? each : [m]) pass(pointOf(book, c));
      if (ring) place(book, ring, m);
    },
    up: () => {
      ring?.remove();
      change.end();
    },
  });
  return true;
}
const pointOf = (book, m) => {
  const r = book.desk.getBoundingClientRect();
  return [book.pan.x + (m.clientX - r.left) / book.scale, book.pan.y + (m.clientY - r.top) / book.scale];
};
function ringAt(book, r, e) {
  const ring = document.createElement('div');
  ring.className = 'bk-eraser-ring';
  Object.assign(ring.style, { width: `${2 * r}px`, height: `${2 * r}px`, margin: `${-r}px 0 0 ${-r}px` });
  book.desk.append(ring);
  place(book, ring, e);
  return ring;
}
function place(book, ring, m) {
  const d = book.desk.getBoundingClientRect();
  ring.style.translate = `${m.clientX - d.left}px ${m.clientY - d.top}px`;
}
