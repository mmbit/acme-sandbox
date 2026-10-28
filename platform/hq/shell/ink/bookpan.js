// Moving about the page: panned in any direction by two fingers (one, once a pen is in use, where this device's
// preferences say so: book.input.fingerPans()), the middle button, Shift or Space held with the mouse, the hand tool or
// a trackpad's two fingers, gliding on after a flick; zoomed by two fingers' pinch, a trackpad's pinch or Ctrl/⌘ and
// the wheel, about the point between the fingers or under the pointer, out as far as the page's least zoom and never on
// into the overview (its button and keys open that). A mouse's wheel alone steps through the tools. (was the row of
// pages' table; one finger draws, Shift pans and the wheel's tools: the board's controls)
//
// The fingers down are only those the browser said are: a finger's lift, cancel or lost capture ends its part, a
// first finger down (isPrimary) means no other is, and the window losing focus or the page hidden lets every gesture
// go, so a lift the browser never sent can't leave the paper deaf.
//
// desk: the paper the page shows on. book (bookpages.js): its view (bookview.js) and book.tools (booktools.js: mode()
// 'hand' pans). drawing(): whether the pen is on the page.
import { setView, halt, viewOf } from './bookview.js';
import { clampScale, zoomAt } from './bookrow.js';

// a flick's speed is measured over its last moments; slower than STILL px/ms it doesn't glide
const FLICK_MS = 90,
  STILL = 0.15;
// how quickly a glide slows (ms for it to lose about two thirds of its speed, as iOS's scrolling does)
const GLIDE_MS = 325;
// a wheel's rest: the view settles this long after its last turn
const WHEEL_REST_MS = 160;
// a wheel's line is this many px (Firefox's deltaMode 1)
const LINE_PX = 16;
// a mouse wheel's notch, as Chrome and Safari tell it (wheelDeltaY); a trackpad's comes in other sizes
const NOTCH = 120;
// a wheel's zoom: this much a px of its turn, at most MOST of a step in one event (a mouse's notch is 100 px)
const WHEEL_ZOOM = 0.0075,
  MOST = 0.25;

// Returns { stop(), letGo() (every gesture let go: the page turned), panning(e) (whether this pointer pans) } (release()
// gone with the sheets' notes)
export function panning(desk, book, { drawing }) {
  const table = { desk, book, drag: null, pinch: null, touches: new Map(), glide: 0, wheelRest: 0, space: false };
  table.stop = () => {
    cancelAnimationFrame(table.glide);
    table.glide = 0;
    halt(book);
  };
  desk.addEventListener('pointerdown', e => pressed(table, e, drawing));
  desk.addEventListener('pointermove', e => moved(table, e));
  desk.addEventListener('pointerup', e => lifted(table, e));
  desk.addEventListener('pointercancel', e => lifted(table, e));
  desk.addEventListener('lostpointercapture', e => lifted(table, e));
  addEventListener('blur', () => letGo(table));
  document.addEventListener('visibilitychange', () => document.hidden && letGo(table));
  desk.addEventListener('wheel', e => wheeled(table, e, drawing), { passive: false });
  // (the middle button's own autoscroll and paste are the pan's)
  for (const type of ['mousedown', 'auxclick']) desk.addEventListener(type, e => e.button === 1 && e.preventDefault());
  gestures(table);
  spaceBar(table);
  // Safari scrolls and selects under a pen until its touches say no; a finger's pans are ours already (touch-action)
  desk.addEventListener(
    'touchmove',
    e => [...e.changedTouches].some(t => t.touchType === 'stylus') && e.preventDefault(),
    { passive: false },
  );
  return {
    stop: table.stop,
    letGo: () => letGo(table),
    panning: e => table.drag?.id === e.pointerId,
  };
}

// ---- a press

// Whether a mouse's press pans: the middle button, or the main one with Space or Shift held or the hand tool (Shift but
// with Select and shapes, where it adds to what's picked and keeps a shape even: bookselect.js, bookshapes.js)
const pans = (table, e) => {
  const mode = table.book.tools?.mode?.();
  return (
    e.pointerType === 'mouse' &&
    (e.button === 1 ||
      (e.button === 0 && (table.space || mode === 'hand' || (e.shiftKey && !['select', 'shapes'].includes(mode)))))
  );
};
// Whether a finger on its own moves the page: else it draws with the tool in use, and two fingers move it
const fingerPans = table => !!table.book.input?.fingerPans?.();

function pressed(table, e, drawing) {
  const { book, touches } = table;
  if (e.pointerType === 'pen') return putBack(table);
  if (e.pointerType === 'touch') {
    // (the first finger of a touch: any other still held here lifted unheard)
    if (e.isPrimary) letGo(table);
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    // a second finger: a pinch, from where the view is now
    if (touches.size === 2) return pinchFrom(table);
  }
  const finger = e.pointerType === 'touch' && e.isPrimary && fingerPans(table);
  if (table.drag || table.pinch || drawing() || !(finger || pans(table, e))) return;
  // (the middle button's own scrolling, and a drag's text selection, are the pan's)
  if (e.pointerType === 'mouse') e.preventDefault();
  table.stop();
  table.drag = { id: e.pointerId, from: [e.clientX, e.clientY], pan: { ...book.pan }, finger, trail: [] };
  table.desk.setPointerCapture(e.pointerId);
  table.desk.dataset.pan = 'moving';
}
function moved(table, e) {
  if (table.touches.has(e.pointerId)) table.touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (table.pinch) return pinched(table);
  const drag = table.drag;
  if (!drag || e.pointerId !== drag.id) return;
  const s = table.book.scale;
  setView(table.book, {
    pan: { x: drag.pan.x - (e.clientX - drag.from[0]) / s, y: drag.pan.y - (e.clientY - drag.from[1]) / s },
  });
  drag.trail.push([e.timeStamp, table.book.pan.x, table.book.pan.y]);
  while (drag.trail.length > 2 && drag.trail[0][0] < e.timeStamp - FLICK_MS) drag.trail.shift();
}
// Let go (or lost: a lost capture after the lift finds nothing left): a flick glides on, a slow lift stays where it is
function lifted(table, e) {
  // (a finger's line let go as the second comes down is the pinch's start, not its end: pinchFrom)
  if (e.unmade) return;
  table.touches.delete(e.pointerId);
  if (table.pinch) {
    if (table.touches.size < 2) pinchEnd(table);
    return;
  }
  const drag = table.drag;
  if (!drag || e.pointerId !== drag.id) return;
  end(table);
  const first = drag.trail[0],
    last = drag.trail[drag.trail.length - 1];
  // (a finger's flick glides on, as a page scrolls; a mouse's drag stops where it's let go)
  if (!drag.finger || !first || e.timeStamp - last[0] > FLICK_MS) return table.book.remember();
  const dt = Math.max(1, last[0] - first[0]),
    v = { x: (last[1] - first[1]) / dt, y: (last[2] - first[2]) / dt };
  if (Math.hypot(v.x, v.y) * table.book.scale > STILL) glideOn(table, v);
  else table.book.remember();
}
function end(table) {
  table.drag = null;
  delete table.desk.dataset.pan;
  if (table.space) table.desk.dataset.pan = 'ready';
}
// Every finger and pinch let go where it got to, the pan's capture with it
function letGo(table) {
  table.touches.clear();
  if (table.pinch) pinchEnd(table);
  const drag = table.drag;
  if (!drag) return;
  end(table);
  if (table.desk.hasPointerCapture(drag.id)) table.desk.releasePointerCapture(drag.id);
  table.book.remember();
}
// A pen, or a second finger, coming down ends a finger's pan: a pen puts the page back where the finger found it
// (that finger was the hand resting on the glass)
function putBack(table) {
  table.stop();
  if (!table.drag?.finger) return;
  setView(table.book, { pan: table.drag.pan });
  end(table);
}

// A flick: the page carries on and slows, stopping where the page's reach ends
function glideOn(table, v) {
  const book = table.book;
  let last = performance.now();
  const step = now => {
    const dt = now - last,
      before = { ...book.pan },
      decay = Math.exp(-dt / GLIDE_MS);
    last = now;
    setView(book, { pan: { x: before.x + v.x * dt, y: before.y + v.y * dt } });
    v = { x: book.pan.x === before.x ? 0 : v.x * decay, y: book.pan.y === before.y ? 0 : v.y * decay };
    if (Math.hypot(v.x, v.y) * book.scale < 0.02) {
      table.glide = 0;
      return book.remember();
    }
    table.glide = requestAnimationFrame(step);
  };
  table.glide = requestAnimationFrame(step);
}

// ---- a pinch: two fingers zoom about the point between them, and pan as it moves

// The first finger's stroke or tool let go, as the second comes down: the line taken off, and a cancel for the tool
// that took the press (booktools.js), as the browser sends one
function drop(table) {
  const { book } = table,
    [first] = table.touches.keys();
  if (book.ink?.drawing) book.ink.cancel();
  if (first != null) unmake(table.desk, { pointerId: first, pointerType: 'touch' });
}
// A press let go unmade: a pointercancel for whatever took it (a tool's drag, a line), as the browser sends one, marked
// as ours (e.unmade) so the pan and the holds that sent it don't take it for a lift (bookinput.js too)
export function unmake(desk, { pointerId, pointerType }) {
  const e = new PointerEvent('pointercancel', { pointerId, pointerType, isPrimary: true, bubbles: true });
  e.unmade = true;
  desk.dispatchEvent(e);
}
const middleOf = table => {
  const [[ax, ay], [bx, by]] = [...table.touches.values()],
    r = table.desk.getBoundingClientRect();
  return { at: { x: (ax + bx) / 2 - r.left, y: (ay + by) / 2 - r.top }, spread: Math.hypot(ax - bx, ay - by) };
};
function pinchFrom(table) {
  // (the first finger's pan was the pinch's start: it stays where it got to; its line, or what its tool began, is let
  // go unmade)
  if (table.drag) end(table);
  else drop(table);
  table.stop();
  const { at, spread } = middleOf(table);
  table.pinch = { at, spread: Math.max(1, spread), scale: table.book.scale, pan: { ...table.book.pan } };
}
function pinched(table) {
  const p = table.pinch;
  if (table.touches.size < 2) return;
  const { at, spread } = middleOf(table),
    scale = within(table, (p.scale * spread) / p.spread);
  // (the page's point first under the fingers' middle stays under it)
  const pan = zoomAt(p.pan, p.scale, scale, p.at);
  setView(table.book, { pan: { x: pan.x - (at.x - p.at.x) / scale, y: pan.y - (at.y - p.at.y) / scale }, scale });
}
// A zoom within the page's: a pinch or a wheel stops at the least, the page held still under it (no page shown yet:
// setView takes nothing)
const within = (table, scale) => {
  const v = viewOf(table.book);
  return v ? clampScale(scale, v.page, table.book.size) : scale;
};
function pinchEnd(table) {
  table.pinch = null;
  table.book.remember();
}

// ---- a wheel, a trackpad, Safari's pinch

// A wheel or a trackpad's two fingers: the page follows them (Shift turns a wheel sideways). With Ctrl or ⌘ (a
// trackpad's pinch comes as a wheel with Ctrl), the zoom, about the pointer; the browser never zooms the book itself.
function wheeled(table, e, drawing) {
  e.preventDefault();
  if (drawing()) return;
  table.stop();
  const book = table.book,
    k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? table.desk.clientHeight : 1;
  clearTimeout(table.wheelRest);
  if (e.ctrlKey || e.metaKey) {
    const r = table.desk.getBoundingClientRect(),
      at = { x: e.clientX - r.left, y: e.clientY - r.top },
      by = Math.exp(Math.max(-MOST, Math.min(MOST, -e.deltaY * k * WHEEL_ZOOM))),
      scale = within(table, book.scale * by);
    setView(book, { pan: zoomAt(book.pan, book.scale, scale, at), scale });
    return rest(table);
  }
  // (a mouse's wheel alone: the next tool, or the one before, a notch each)
  if (!e.shiftKey && !e.altKey && wheelOf(table, e) === 'mouse') {
    const by = Math.sign(-e.wheelDeltaY || e.deltaY);
    if (by && book.tools?.cycle?.(by)) return rest(table);
  }
  const [dx, dy] = e.shiftKey && !e.deltaX ? [e.deltaY, 0] : [e.deltaX, e.deltaY];
  setView(book, { pan: { x: book.pan.x + (dx * k) / book.scale, y: book.pan.y + (dy * k) / book.scale } });
  rest(table);
}
const rest = table =>
  (table.wheelRest = setTimeout(() => {
    table.wheel = null;
    table.book.remember();
  }, WHEEL_REST_MS));
// Whether a run of wheel events is a mouse's wheel or a trackpad's two fingers (which pan): a mouse's turns in notches
// (lines, in Firefox), a trackpad's in any size and sideways too. One that isn't a notch makes the whole run the
// trackpad's, so a pan never changes the tool halfway.
function wheelOf(table, e) {
  const notch = e.deltaMode === 1 || (!e.deltaX && e.wheelDeltaY && e.wheelDeltaY % NOTCH === 0);
  if (!notch) table.wheel = 'pad';
  else table.wheel ??= 'mouse';
  return table.wheel;
}
// Safari's own pinch on a Mac's trackpad (on an iPad the fingers come as pointers, which pinch already)
function gestures(table) {
  const { desk, book } = table;
  let from = null;
  desk.addEventListener('gesturestart', e => {
    e.preventDefault();
    if (table.touches.size) return;
    const r = desk.getBoundingClientRect();
    from = { scale: book.scale, pan: { ...book.pan }, at: { x: e.clientX - r.left, y: e.clientY - r.top } };
  });
  desk.addEventListener('gesturechange', e => {
    e.preventDefault();
    if (!from) return;
    const scale = within(table, from.scale * e.scale);
    setView(book, { pan: zoomAt(from.pan, from.scale, scale, from.at), scale });
  });
  desk.addEventListener('gestureend', () => {
    if (from) book.remember();
    from = null;
  });
}

// ---- Space held: the mouse pans (when the pointer is on the paper, and not in a text field)

const typing = t => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable]');
// (the pointer on the paper itself: Space there is the pan's, even with one of the book's controls focused, which it
// would press; over the controls or HQ's page it's theirs)
function spaceBar(table) {
  addEventListener('keydown', e => {
    if (e.code !== 'Space' || typing(e.target) || !table.desk.matches(':hover')) return;
    e.preventDefault();
    if (e.repeat || table.space) return;
    table.space = true;
    table.desk.dataset.pan ??= 'ready';
  });
  const up = () => {
    table.space = false;
    if (table.desk.dataset.pan === 'ready') delete table.desk.dataset.pan;
  };
  addEventListener('keyup', e => {
    if (e.code !== 'Space' || !table.space) return;
    e.preventDefault();
    up();
  });
  addEventListener('blur', up);
}
