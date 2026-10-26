// The table under the pages, moved by a finger, a trackpad or a mouse on the bare table: it pans freely, glides on
// after a flick, and comes to rest with a page square in the book.
//
// desk: the element the table shows in. book: { pan: { x, y }, setPan(pan), settle(), halt() (a slide under way
// stops) }, the pages' (bookpages.js). bare(e): whether a mouse press is on the bare table (on a page it draws).
// drawing(): whether the pen is on a page.

// a press that moves this far has a direction: mostly along one axis, it keeps to it, as a page scrolls
const LOCK_PX = 8;
// a flick's speed is measured over its last moments; slower than STILL px/ms it doesn't glide
const FLICK_MS = 90,
  STILL = 0.15;
// how quickly a glide slows (ms for it to lose about two thirds of its speed, as iOS's scrolling does)
const GLIDE_MS = 325;
// a wheel's rest: the table settles this long after its last turn
const WHEEL_REST_MS = 160;
// a wheel's line is this many px (Firefox's deltaMode 1)
const LINE_PX = 16;

// Returns { stop(), release() }: the table stops where it is (the pen came down)
export function panning(desk, book, { bare, drawing }) {
  const table = { desk, book, drag: null, glide: 0, wheelRest: 0 };
  table.stop = () => {
    cancelAnimationFrame(table.glide);
    table.glide = 0;
    book.halt();
  };
  desk.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') return putBack(table);
    const finger = e.pointerType === 'touch',
      mouse = e.pointerType === 'mouse' && e.button === 0 && bare(e);
    // a second finger: a pinch (bookzoom.js), so the first one's pan is put back
    if (finger && table.drag?.finger) return putBack(table);
    if (table.drag || drawing() || !(finger || mouse)) return;
    table.stop();
    table.drag = { id: e.pointerId, from: [e.clientX, e.clientY], pan: { ...book.pan }, lock: null, finger, trail: [] };
    desk.setPointerCapture(e.pointerId);
    desk.classList.add('bk-moving');
  });
  desk.addEventListener('pointermove', e => dragged(table, e));
  desk.addEventListener('pointerup', e => lifted(table, e));
  desk.addEventListener('pointercancel', e => lifted(table, e));
  desk.addEventListener('wheel', e => wheeled(table, e, drawing), { passive: false });
  // Safari scrolls and selects under a pen until its touches say no; a finger's pans are ours already (touch-action)
  desk.addEventListener(
    'touchmove',
    e => [...e.changedTouches].some(t => t.touchType === 'stylus') && e.preventDefault(),
    { passive: false },
  );
  // release(): a finger's pan ends where it began (it held a note still, which lifts instead: booknotegrip.js.
  return { stop: table.stop, release: () => putBack(table) };
}

// A pen, or a second finger, coming down ends a finger's pan and puts the table back: that finger was the hand resting
// on the glass (or the first of a pinch)
function putBack(table) {
  table.stop();
  if (!table.drag?.finger) return;
  table.book.setPan(table.drag.pan);
  end(table);
}
function dragged(table, e) {
  const drag = table.drag;
  if (!drag || e.pointerId !== drag.id) return;
  let dx = e.clientX - drag.from[0],
    dy = e.clientY - drag.from[1];
  if (!drag.lock && Math.hypot(dx, dy) >= LOCK_PX)
    drag.lock = Math.abs(dx) > 2 * Math.abs(dy) ? 'x' : Math.abs(dy) > 2 * Math.abs(dx) ? 'y' : 'free';
  if (drag.lock === 'x') dy = 0;
  if (drag.lock === 'y') dx = 0;
  table.book.setPan({ x: drag.pan.x - dx, y: drag.pan.y - dy });
  drag.trail.push([e.timeStamp, table.book.pan.x, table.book.pan.y]);
  while (drag.trail.length > 2 && drag.trail[0][0] < e.timeStamp - FLICK_MS) drag.trail.shift();
}
// Let go: a flick glides on, a slow lift comes to rest
function lifted(table, e) {
  const drag = table.drag;
  if (!drag || e.pointerId !== drag.id) return;
  end(table);
  const first = drag.trail[0],
    last = drag.trail[drag.trail.length - 1];
  if (!first || e.timeStamp - last[0] > FLICK_MS) return table.book.settle();
  const dt = Math.max(1, last[0] - first[0]),
    v = { x: (last[1] - first[1]) / dt, y: (last[2] - first[2]) / dt };
  if (Math.hypot(v.x, v.y) > STILL) glideOn(table, v);
  else table.book.settle();
}
function end(table) {
  table.drag = null;
  table.desk.classList.remove('bk-moving');
}

// A flick: the table carries on and slows, stopping at the row's reach
function glideOn(table, v) {
  const book = table.book;
  let last = performance.now();
  const step = now => {
    const dt = now - last,
      before = { ...book.pan },
      decay = Math.exp(-dt / GLIDE_MS);
    last = now;
    book.setPan({ x: before.x + v.x * dt, y: before.y + v.y * dt });
    v = { x: book.pan.x === before.x ? 0 : v.x * decay, y: book.pan.y === before.y ? 0 : v.y * decay };
    if (Math.hypot(v.x, v.y) < 0.02) {
      table.glide = 0;
      return book.settle();
    }
    table.glide = requestAnimationFrame(step);
  };
  table.glide = requestAnimationFrame(step);
}

// A wheel or a trackpad's two fingers: the table follows them (Shift turns a wheel sideways). A pinch (ctrlKey) is
// the book's zoom (bookzoom.js), not a pan, and the browser doesn't zoom the book either.
function wheeled(table, e, drawing) {
  e.preventDefault();
  if (e.ctrlKey || drawing()) return;
  table.stop();
  const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? table.desk.clientHeight : 1;
  const [dx, dy] = e.shiftKey && !e.deltaX ? [e.deltaY, 0] : [e.deltaX, e.deltaY];
  table.book.setPan({ x: table.book.pan.x + dx * k, y: table.book.pan.y + dy * k });
  clearTimeout(table.wheelRest);
  table.wheelRest = setTimeout(() => table.book.settle(), WHEEL_REST_MS);
}
