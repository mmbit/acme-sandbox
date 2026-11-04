// The pen and fingers on HQ's page, for the Pencil (pencil.js): the pen down, then moved, draws; a quick tap is a
// click (tap.js); two fingers tapped together undo. Nothing waits on a pen held still.
import { under } from './layer.js';
import { distance, isTap } from './tap.js';

// (ownsPen, theirs and free)
// A surface with its own pen handling (data-no-ink) owns its events, its own menus and dialogs too: there the pen draws
// its ink and taps its menus (a notebook's). Other surfaces, wherever mounted, take HQ's pen.
// A part of one marked data-takes-ink (a notebook's paper the board lets a call mark) is HQ's pen's again, but for the
// menus and dialogs in it, which stay the surface's: whichever mark is nearer the touched element decides.
const POPUP = 'dialog, [popover], [role="dialog"], [role="menu"]';
export function ownsPen(e) {
  let popup = false;
  for (const el of e.composedPath()) {
    if (!el.hasAttribute) continue;
    if (el.hasAttribute('data-no-ink')) return true;
    if (el.hasAttribute('data-takes-ink')) return popup;
    popup ||= el.matches(POPUP);
  }
  return false;
}
// Review mode's UI, surfaces with their own pen handling and text fields (where Scribble writes) take their own events.
export function theirs(r, e) {
  const path = e.composedPath();
  if (path.includes(r.host) || ownsPen(e)) return true;
  const t = path[0];
  return !!(
    t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  );
}
// The pen may draw now: on the page, nothing of review mode's over it (a mouse's marking has its own veil), while the
// last mark goes in too (settle.js).
// On HQ the post-it of a mark being made leaves the page to the pen, so its lines go on joining it.
export const free = r =>
  (!r.covered || r.book) &&
  r.veil.hidden &&
  (r.sheet.hidden || (r.book && r.mark && r.mark.kind !== 'general')) &&
  (r.mode === 'idle' || r.mode === 'note' || r.mode === 'sending');

// px a pen moves before it draws: less is a tap, the page's own (and so is a quick one lifted short of tap.js's TAP_PX)
const MOVE = 4;
const TAP_MS = 350; // a two-finger tap: both fingers down and up within this, barely moving
const TAP_SLOP = 12;

// The pen on the page: down, then moved past MOVE, draws (the line from where it touched); a quick tap that would
// start a mark is a click (tap.js), its line thrown away.
// p: the pen's state, { down: its pointerdown, drawing, reach: the farthest it got from down, in px }
// (a line drawn or a tap clicked here is no click of the browser's on what the pen lifted over: its next one goes, and
// a click this file makes passes)
function noClick() {
  const stop = c => {
    if (!c.isTrusted) return;
    c.stopPropagation();
    c.preventDefault();
    removeEventListener('click', stop, true);
  };
  addEventListener('click', stop, true);
  setTimeout(() => removeEventListener('click', stop, true), 400);
}
// A pen's tap as the click it was meant to be, on what's under it: focused, then its pointerup and click, as a tap
// with nothing drawn has. The pen's line had the pointer captured, so the browser's own click misses it.
function tapped(r, e) {
  const el = under(r, e.clientX, e.clientY),
    at = { clientX: e.clientX, clientY: e.clientY, bubbles: true, composed: true, cancelable: true, view: window };
  el.closest(FOCUSABLE)?.focus({ preventScroll: true });
  el.dispatchEvent(
    new PointerEvent('pointerup', { ...at, pointerId: e.pointerId, pointerType: 'pen', isPrimary: true }),
  );
  el.dispatchEvent(new PointerEvent('click', { ...at, pointerId: e.pointerId, pointerType: 'pen', detail: 1 }));
}
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]';
// The pen would begin a new mark: nothing open, or only the last mark going in
const fresh = r => r.mode === 'idle' || (r.mode === 'sending' && !r.nextLines.length);
const penDown = (r, p) => e => {
  if (e.pointerType !== 'pen' || !e.isPrimary || !free(r) || theirs(r, e)) return;
  e.preventDefault(); // Native text selection must not take the pen away from the drawing.
  e.stopPropagation(); // The page must not start a swipe or pan while the pen owns the gesture.
  Object.assign(p, { down: e, drawing: false, reach: 0 });
};
const penMove = (r, p) => e => {
  if (!p.down || e.pointerId !== p.down.pointerId) return;
  p.reach = Math.max(p.reach, distance(p.down, e));
  if (!p.drawing) {
    if (p.reach < MOVE) return;
    p.drawing = r.pencil.start(p.down);
    if (!p.drawing) return (p.down = null);
  }
  e.stopPropagation();
  r.pencil.move(e);
};
const penUp = (r, p) => e => {
  if (!p.down || e.pointerId !== p.down.pointerId) return;
  const drew = p.drawing,
    tap = drew && e.type === 'pointerup' && fresh(r) && isTap(p.down, e, p.reach);
  p.down = null;
  p.drawing = false;
  if (drew) {
    e.stopPropagation();
    if (e.type === 'pointercancel' || tap) r.pencil.cancel(e);
    else r.pencil.end(e);
  }
  if (tap) tapped(r, e);
  if (drew) noClick();
};
// undo: pencil.js's, the last thing taken back
export function setupTouch(r, { undo }) {
  pen(r);
  twoFingerTap(r, undo);
}
function pen(r) {
  const p = { down: null, drawing: false };
  addEventListener('pointerdown', penDown(r, p), true);
  addEventListener('pointermove', penMove(r, p), true);
  addEventListener('pointerup', penUp(r, p), true);
  addEventListener('pointercancel', penUp(r, p), true);
  // (Safari scrolls under a pen until its first touchmove says no; a finger's still scroll)
  addEventListener(
    'touchmove',
    e => p.down && [...e.changedTouches].some(t => t.touchType === 'stylus') && e.preventDefault(),
    { capture: true, passive: false },
  );
}

// Two fingers tapped together, anywhere on the page: undo
function twoFingerTap(r, undo) {
  let tap = null;
  const fingers = e => [...e.touches].filter(t => t.touchType !== 'stylus');
  addEventListener(
    'touchstart',
    e => {
      const f = fingers(e);
      if (ownsPen(e)) tap = null;
      else if (f.length === 2 && e.touches.length === 2)
        tap = { at: e.timeStamp, from: f.map(t => [t.clientX, t.clientY]) };
      else if (e.touches.length > 2) tap = null;
    },
    { capture: true, passive: true },
  );
  addEventListener(
    'touchmove',
    e => {
      if (!tap) return;
      const moved = [...e.touches].some(
        (t, i) => tap.from[i] && Math.hypot(t.clientX - tap.from[i][0], t.clientY - tap.from[i][1]) > TAP_SLOP,
      );
      if (moved) tap = null;
    },
    { capture: true, passive: true },
  );
  addEventListener(
    'touchend',
    e => {
      if (!tap || e.touches.length) return;
      const quick = e.timeStamp - tap.at < TAP_MS;
      tap = null;
      if (quick && !r.covered) undo(r);
    },
    { capture: true, passive: true },
  );
}
