// The pen and fingers on HQ's page, for the Pencil (pencil.js): the pen down, then moved, draws; held still, listens;
// a quick tap is a click (tap.js); two fingers tapped together undo.
import { under } from './layer.js';
import { audioContext, canRecord, startMic, stopMic } from './dictation.js';
import { reset } from './acts.js';
import { TAP_MS as PEN_TAP_MS, TAP_PX, distance, isTap } from './tap.js';
import { file, settleSoon } from './settle.js';
import { across } from './postit.js';

// (offPage, theirs and free)
// A touch beside HQ's page, on the book (outside <body>, platform/hq/shell/book.js): the book's, never the page's ink.
export const offPage = e => !e.composedPath().includes(document.body);
// Where a pen's touch belongs to the page or the browser, not the ink: review mode's own UI, the book, text fields
// (Scribble writes in them) and what the page marks data-no-ink (a floating control the pen works as a finger does)
export function theirs(r, e) {
  const path = e.composedPath();
  if (path.includes(r.host) || offPage(e)) return true;
  const t = path[0];
  return !!(
    t instanceof Element &&
    t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-ink]')
  );
}
// The pen may draw now: on the page, nothing of review mode's over it (a mouse's marking has its own veil), while the
// last mark goes in too (settle.js).
export const free = r =>
  !r.covered && r.veil.hidden && r.sheet.hidden && (r.mode === 'idle' || r.mode === 'note' || r.mode === 'sending');

// px a pen moves before it draws: less is a tap, the page's own (and so is a quick one lifted short of tap.js's TAP_PX)
const MOVE = 4;
const HOLD_MS = 550; // a pen held this still this long starts a voice note
const TAP_MS = 350; // a two-finger tap: both fingers down and up within this, barely moving
const TAP_SLOP = 12;

// The pen on the page: down, then moved past MOVE, draws (the line from where it touched); held still, listens; a
// quick tap that would start a mark is a click (tap.js), its line thrown away.
// p: the pen's state, { down: its pointerdown, drawing, timer: a hold's or the mic's, reach: the farthest it got from down, in px, mic: the
// pointer whose touch may start the mic, ctx: the audio context made at that touch, until the mic starts with it }
// (a line drawn, a voice note or a tap clicked here is no click of the browser's on what the pen lifted over: its next
// one goes, and a click this file makes passes)
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
const penDown = (r, p, begin) => e => {
  if (e.pointerType !== 'pen' || !e.isPrimary || !free(r) || theirs(r, e)) return;
  r.penSeen = true;
  Object.assign(p, { down: e, drawing: false, reach: 0 });
  p.timer = setTimeout(() => p.down === e && !p.drawing && hold(r, e, p, begin), HOLD_MS);
  // off a call the mic listens from a new mark's first line, once it can't be a tap, or a held note (on one, the call
  // hears: callnotes.js): a tap never opens it (house rule 7). Its audio context is made here, at the pen's touch, a
  // gesture, so Safari lets it run; a paired page's mark goes to the other screen with no mic
  if (!r.call && r.mode === 'idle' && canRecord && !r.rec && !r.stopping && !across(r)) {
    p.mic = e.pointerId;
    p.ctx = audioContext();
  }
};
// The mic, for the mark or held note this touch began
const listen = (r, p) => {
  if (!p.ctx) return;
  startMic(r, p.ctx);
  p.ctx = null;
};
const penMove = (r, p) => e => {
  if (!p.down || e.pointerId !== p.down.pointerId || r.holding) return;
  p.reach = Math.max(p.reach, distance(p.down, e));
  if (!p.drawing) {
    if (p.reach < MOVE) return;
    clearTimeout(p.timer);
    p.drawing = r.pencil.start(p.down);
    if (!p.drawing) return (p.down = null);
    // (the mic once the line can't be a tap: past a tap's time, or its reach below. tap.js)
    const down = p.down;
    p.timer = setTimeout(() => p.down === down && listen(r, p), PEN_TAP_MS - (performance.now() - down.timeStamp));
  }
  if (p.reach >= TAP_PX) listen(r, p);
  e.stopPropagation();
  r.pencil.move(e);
};
const penUp = (r, p) => e => {
  // (the mic it started stops unheard if no mark began: a tap, or a touch that drew nothing; one it never started has
  // only its audio context to close)
  if (p.mic === e.pointerId) {
    p.mic = null;
    if (p.ctx) p.ctx.close();
    else queueMicrotask(() => r.mode === 'idle' && !r.holding && stopMic(r, true));
    p.ctx = null;
  }
  if (!p.down || e.pointerId !== p.down.pointerId) return;
  clearTimeout(p.timer);
  const drew = p.drawing,
    held = !!r.holding,
    tap = drew && e.type === 'pointerup' && fresh(r) && isTap(p.down, e, p.reach);
  p.down = null;
  p.drawing = false;
  if (drew) {
    e.stopPropagation();
    if (e.type === 'pointercancel' || tap) r.pencil.cancel(e);
    else r.pencil.end(e);
  }
  if (tap) tapped(r, e);
  if (held) letGo(r);
  if (drew || held) noClick();
};
// begin, undo: pencil.js's, a new mark begun and the last thing taken back
export function setupTouch(r, { begin, undo }) {
  pen(r, begin);
  twoFingerTap(r, undo);
}
function pen(r, begin) {
  const p = { down: null, drawing: false, timer: 0, mic: null, ctx: null };
  addEventListener('pointerdown', penDown(r, p, begin), true);
  addEventListener('pointermove', penMove(r, p), true);
  addEventListener('pointerup', penUp(r, p), true);
  addEventListener('pointercancel', penUp(r, p), true);
  // (Safari scrolls under a pen until its first touchmove says no; a finger's still scroll)
  addEventListener(
    'touchmove',
    e => (p.down || r.holding) && [...e.changedTouches].some(t => t.touchType === 'stylus') && e.preventDefault(),
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
      if (offPage(e)) tap = null;
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

// Hold still to talk: a pin where the pen is, a red pulse at its tip, the words heard (the mic, or on a call the
// call's own hearing: callnotes.js); lifted, the words land as its note (settle.js)
function hold(r, e, p, begin) {
  r.holding = { x: e.clientX, y: e.clientY, fresh: r.mode === 'idle' };
  Object.assign(r.listen.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
  r.listen.hidden = false;
  if (r.holding.fresh) {
    r.strokes = [];
    r.mark = { kind: 'pin', x: e.clientX, y: e.clientY, el: under(r, e.clientX, e.clientY), area: null };
    begin(r);
    listen(r, p);
  } else if (canRecord && !r.call && !r.rec && !r.stopping) r.mic.click();
}
async function letGo(r) {
  const { fresh } = r.holding,
    mark = r.mark;
  r.holding = null;
  r.listen.hidden = true;
  if (r.mark !== mark || r.mode !== 'note' || !fresh) return;
  // (on a call the words of the phrase still being said come after: the mark settles as a drawn one does)
  if (r.call) return settleSoon(r);
  await stopMic(r);
  if (r.mark !== mark || r.mode !== 'note') return;
  if (r.text.value.trim()) file(r);
  else if (canRecord) reset(r); // (nothing heard: no note)
}
