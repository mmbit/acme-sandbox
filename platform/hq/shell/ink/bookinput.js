// The board's bindings on the page that are more than a tool's press (the strip, the wheel, Shift and Ctrl are
// bookstrip.js, bookpan.js and booktools.js): a press held still, which becomes a voice note (a mouse's, where a
// microphone is connected; a double tap held, by a finger or a pen) or, where this device's preferences want it, the
// radial menu (a pen's or a finger's long press); and whether a finger moves the page or draws. A hold is a voice note
// only where the microphone is already allowed: nothing on the book asks for it, only a tap on a mic does (the board,
// call 158). Each waits the hold this device keeps (shared/review/prefs.js).
//
// book.input: { fingerPans(), claims(e) }. claims(e): whether a press on the paper is one of these, or the strip's,
// for a part that would wait on a still finger itself (booktape.js's Paste bubble).
import { stylesheet } from '../../util.js';
import { prefs, holdMs } from '/__review/prefs.js';
import { isTap, wandered } from '/__review/tap.js';
import { canRecord } from '../voice.js';
import { micAllowed } from '/__review/micallowed.js';
import { scrapAt } from './bookscrap.js';
import { listen } from './bookvoice.js';
import { openRadial } from './bookradial.js';
import { unmake } from './bookpan.js';

// a double tap: its second press this soon after the first one's lift, and this near it (px)
const DOUBLE_MS = 350,
  DOUBLE_PX = 24;
// where a press is never a hold of the page's: a control, a field, words, an answer, the strip
const NOT_PAPER =
  'button, input, textarea, select, a, label, [contenteditable], .bk-typed, .answer-slip, .bk-strip, .bk-card';
// the tools a hold is theirs to keep: Select's press and the mouse's with the hand are their own (a finger's or a pen's
// with the hand holds as with the pen: bookwrite.js)
const HELD_TOOLS = ['pen', 'highlighter', 'eraser', 'shapes', 'text'];

export function mountInput(book) {
  stylesheet('shell/ink/bookinput.css');
  const input = { book, last: null, hold: null, pen: false, mic: null };
  addEventListener('pointerdown', e => e.pointerType === 'pen' && (input.pen = true), true);
  book.desk.addEventListener('pointerdown', e => pressed(input, e), true);
  addEventListener('pointermove', e => input.hold && moved(input, e), true);
  addEventListener('pointerup', e => lifted(input, e), true);
  addEventListener('pointercancel', e => !e.unmade && letGo(input, e), true);
  microphones(input);
  return (book.input = {
    // A finger moves the page, rather than drawing, with the hand, and once a
    // pen has been used here, where the preferences say so
    fingerPans: () => book.tools?.mode?.() === 'hand' || (input.pen && prefs().penPans),
    claims: e => !!e.target?.closest?.('.bk-strip') || !!kindOf(input, e),
  });
}

// ---- which hold a press may become

// 'voice', 'radial' or null: a mouse's press held still is a voice note (a microphone connected and allowed); a
// finger's or a pen's, the second of a double tap, is one too (one allowed), and a single one the radial menu where the
// preferences want it
function kindOf(input, e) {
  const { book } = input,
    mouse = e.pointerType === 'mouse';
  if (!e.isPrimary || (mouse && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey))) return null;
  const mode = book.tools?.mode?.();
  if (!HELD_TOOLS.includes(mode) && !(mode === 'hand' && !mouse)) return null;
  if (e.target instanceof Element && e.target.closest(NOT_PAPER)) return null;
  const at = book.at(e.clientX, e.clientY);
  if (!at?.view.page.ink || scrapAt(at.view.page.scraps, [at.x, at.y]) >= 0) return null;
  if (mouse) return input.mic && micAllowed() ? 'voice' : null;
  if (doubled(input, e)) return canRecord && micAllowed() ? 'voice' : null;
  return prefs().radial ? 'radial' : null;
}
const doubled = (input, e) => {
  const l = input.last;
  return (
    !!l &&
    l.type === e.pointerType &&
    e.timeStamp - l.t < DOUBLE_MS &&
    Math.hypot(e.clientX - l.x, e.clientY - l.y) < DOUBLE_PX
  );
};

// ---- a press, held

function pressed(input, e) {
  if (!e.isPrimary) return letGo(input);
  // (a finger's or a pen's press, for whether it was a tap)
  input.down = e.pointerType === 'mouse' ? null : e;
  const kind = kindOf(input, e);
  if (!kind) return;
  clearTimeout(input.hold?.timer);
  // (a finger that moves the page drew no dot with its first tap: nothing to take off)
  const dotted = e.pointerType === 'pen' || (e.pointerType === 'touch' && !input.book.input.fingerPans());
  input.hold = { down: e, kind, double: kind === 'voice' && dotted };
  input.hold.timer = setTimeout(() => held(input), holdMs());
}
function moved(input, e) {
  const h = input.hold;
  if (e.pointerId === h.down.pointerId && wandered(h.down, e)) letGo(input);
}
function lifted(input, e) {
  if (input.hold?.down.pointerId === e.pointerId) letGo(input);
  // (a tap is the first half of a double tap, maybe; anything else isn't)
  const down = input.down;
  if (down?.pointerId !== e.pointerId) return;
  input.down = null;
  input.last = isTap(down, e) ? { t: e.timeStamp, x: e.clientX, y: e.clientY, type: e.pointerType } : null;
}
function letGo(input) {
  clearTimeout(input.hold?.timer);
  input.hold = null;
}

// Held still long enough: what the press began is let go unmade (the line, the tool's start, a finger's pan, a double
// tap's first dot), and the voice note or the radial menu opens there
function held(input) {
  const { book } = input,
    { down, kind, double } = input.hold;
  input.hold = null;
  if (book.ink?.drawing) book.ink.cancel();
  book.table?.letGo();
  unmake(book.desk, down);
  if (double) book.tools?.undot?.(down.clientX, down.clientY);
  navigator.vibrate?.(8);
  if (kind === 'voice') return listen(book, down);
  const tools = Object.entries(book.tools?.buttons?.() ?? {})
    .filter(([, b]) => b.offsetParent)
    .map(([mode, b]) => ({ mode, label: b.getAttribute('aria-label'), icon: b.innerHTML }));
  openRadial(down, { tools, mode: book.tools?.mode?.(), use: m => book.tools?.use?.(m) });
}

// ---- the microphone

// Whether one is connected, kept up to date (a desk's mouse holds for a voice note only then)
function microphones(input) {
  const devices = navigator.mediaDevices;
  if (!canRecord || !devices?.enumerateDevices) return;
  const read = () =>
    devices.enumerateDevices().then(
      all => (input.mic = all.some(d => d.kind === 'audioinput')),
      () => (input.mic = false),
    );
  read();
  devices.addEventListener?.('devicechange', read);
}
