// The board's bindings on the page that are more than a tool's press (the rail, the wheel, Shift and Ctrl are
// bookstrip.js, bookpan.js and booktools.js): whether a finger moves the page or draws, and a double tap held, a voice
// note at that spot. A tap, then a second press there, held still as long as this device's preferences say
// (shared/review/prefs.js holdMs), with the pen or the marker, by the Pencil or a finger where a finger draws: the line
// it began and the first tap's dot are let go, and the book records there as when the mic is tapped and a spot held
// (bookvoice.js heldAt), the words writing themselves where it was held. Nothing else waits on a press held still: a
// single one is ink, and a second press that moves draws.
//
// book.input: { fingerPans(), claims(e) }. claims(e): whether a press on the paper is the strip's, for a part that
// hears a finger's tap itself (Select's Paste: bookselectpaste.js fingerTaps).
import { prefs, holdMs } from '/__review/prefs.js';
import { isTap, wandered } from '/__review/tap.js';
import { unmake } from './bookpan.js';
import { shut } from './booksave.js';

// a double tap: its second press this soon after the first one's lift, and this near it (px)
const DOUBLE_MS = 350,
  DOUBLE_PX = 24;
// where a press is never held for a voice note, a double tap's or the mic's (bookvoice.js): a control, a field, a box
// of words, an answer, the strip, a card
export const NOT_PAPER =
  'button, input, textarea:not([data-pen]), select, a, label, [contenteditable], .bk-typed, .answer-slip, .bk-strip, .bk-card';
// the tools whose double tap may be held: the inks, whose first tap is a dot to take back
const INKS = ['pen', 'highlighter'];

export function mountInput(book) {
  // down: the press on the paper now, for whether it's a tap; last: the last tap, the first half of a double tap maybe;
  // hold: a double tap's second press, still, its timer running
  const input = { book, down: null, last: null, hold: null };
  book.desk.addEventListener('pointerdown', e => pressed(input, e), true);
  addEventListener('pointermove', e => input.hold && moved(input, e), true);
  addEventListener('pointerup', e => lifted(input, e), true);
  // (a press let go unmade is this file's own: held)
  addEventListener('pointercancel', e => !e.unmade && lifted(input, e), true);
  return (book.input = {
    // A finger moves the page, rather than drawing, where this device's preferences say so (on since its first pen)
    fingerPans: () => prefs().penPans,
    claims: e => !!e.target?.closest?.('.bk-strip'),
  });
}

// A press on the paper: a double tap's second press, where it may be held, waits for the hold
function pressed(input, e) {
  letGo(input);
  if (!e.isPrimary) return (input.down = input.last = null);
  // (the book's last step as it began, so the dot a tap draws is known by the step it made since)
  input.down = { e, stepAtPress: input.book.steps.at(-1) };
  const first = input.last;
  if (!doubled(first, e) || !holds(input.book, e)) return;
  input.hold = { down: e, first, timer: setTimeout(() => held(input), holdMs()) };
}
const doubled = (first, e) =>
  !!first &&
  first.type === e.pointerType &&
  e.timeStamp - first.t < DOUBLE_MS &&
  Math.hypot(e.clientX - first.x, e.clientY - first.y) < DOUBLE_PX;
// Whether a press may be held for a voice note: the Pencil's, or a finger's where it draws, with an ink, on the open
// paper of a page that's read, where the book can record (bookvoice.js)
function holds(book, e) {
  const by = e.pointerType === 'pen' || (e.pointerType === 'touch' && !book.input.fingerPans());
  if (!by || !book.voice || !INKS.includes(book.tools?.mode())) return false;
  if (e.target instanceof Element && e.target.closest(NOT_PAPER)) return false;
  const at = book.at(e.clientX, e.clientY);
  return !!at?.view.page.ink && !shut(at.view.page);
}
function moved(input, e) {
  const { down } = input.hold;
  if (e.pointerId === down.pointerId && wandered(down, e)) letGo(input);
}
// Lifted: a tap is the first half of a double tap, maybe; anything else isn't
function lifted(input, e) {
  const { down } = input;
  if (down?.e.pointerId !== e.pointerId) return;
  letGo(input);
  input.down = null;
  input.last =
    e.type === 'pointerup' && isTap(down.e, e)
      ? { t: e.timeStamp, x: e.clientX, y: e.clientY, type: e.pointerType, stepAtPress: down.stepAtPress }
      : null;
}
function letGo(input) {
  clearTimeout(input.hold?.timer);
  input.hold = null;
}

// Held still long enough: the line it began and whatever took the press let go unmade, the first tap's dot taken back,
// and the voice note listening, for that spot on the page
function held(input) {
  const { book } = input,
    { down, first } = input.hold,
    at = book.at(down.clientX, down.clientY);
  input.hold = input.down = input.last = null;
  if (book.ink.drawing) book.ink.cancel();
  unmake(book.desk, down);
  book.tools.undot(first.stepAtPress);
  book.voice.heldAt(down, { view: at.view, x: at.x, y: at.y });
}
