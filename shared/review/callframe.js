// The Pencil on a call, in the page HQ's viewer shows (review mode without the book: a preview's page, its call told by
// HQ, review.js 'review:call'). A mark there is for the call's agent, as on HQ's own page (callnotes.js): no post-it and
// nothing into the notebook by itself. Once the pen has rested SETTLE_MS the mark goes to HQ ({ callMark: { id,
// anchor, snip, ago } }: its anchor, its masked snip, how long ago its first line began), which files it as its own
// call's mark, with the words the call heard since then (HQ's desk.js, callnotes.js). Its ink stays drawn (r.held)
// until HQ says the agent's turn on it is done ({ had: note }), or the call ends (the board, call 161.).
//   HQ answers { callMark: { id, note } } once it's on the call's page, or { callMark: { id, failed } } with why not:
//   then its ink goes and the board is told.
import { redrawInk, reset } from './acts.js';
import { say } from './dock.js';
import { marked } from './mark.js';
import { openLines } from './marks.js';
import { SETTLE_MS, snipOfMark } from './settle.js';

// How long the board is told a mark didn't reach the call
const TOLD_MS = 8000;

export function setupCallFrame(r) {
  Object.assign(r, { held: [], callAt: 0, settleTimer: 0 });
  let sent = 0;
  // the pen down holds the mark open; the first one down is when its words begin
  addEventListener(
    'pointerdown',
    e => {
      if (!r.calling || e.pointerType !== 'pen') return;
      clearTimeout(r.settleTimer);
      if (r.mode === 'idle') r.callAt = Date.now();
    },
    true,
  );
  r.handCall = () => {
    clearTimeout(r.settleTimer);
    if (r.calling) r.settleTimer = setTimeout(() => hand(r, ++sent), SETTLE_MS);
  };
  addEventListener('review:call', e => {
    r.calling = !!e.detail;
    if (r.calling) return;
    // (the call over: a mark still open has no post-it to go by, and goes with it)
    clearTimeout(r.settleTimer);
    r.held = [];
    if (r.mode !== 'idle') reset(r);
    redrawInk(r);
  });
  addEventListener('review:callmark', e => {
    const { id, note, failed } = e.detail ?? {};
    const held = r.held.find(h => h.id === id);
    if (!held) return;
    if (Number.isInteger(note)) held.note = note;
    else {
      r.held = r.held.filter(h => h !== held);
      redrawInk(r);
      say(r, `${failed || "The mark couldn't reach the call."} Draw it again?`, TOLD_MS);
    }
  });
  addEventListener('review:had', e => {
    r.held = r.held.filter(h => h.note !== e.detail);
    redrawInk(r);
  });
  // (held lines follow what they're on as the page scrolls)
  addEventListener('scroll', () => r.held.length && redrawInk(r), { capture: true, passive: true });
}
// The held marks' lines, where their elements are now (surface.js paintInk draws them under the open mark's)
export const heldLines = r => (r.held ?? []).flatMap(h => openLines(r, h.lines, h.mark));
// A mark rested on a call: its pen stays up (the next mark is drawn), it goes to HQ and its ink is held
export const settleCall = r => r.handCall?.();

async function hand(r, id) {
  const mark = r.mark;
  if (!r.calling || r.mode !== 'note' || !mark) return;
  r.mode = 'sending';
  const lines = [...r.strokes],
    snip = await snipOfMark(r, mark, lines);
  if (r.mark !== mark) return;
  const anchor = marked(r),
    ago = Math.max(0, Date.now() - (r.callAt || Date.now()));
  r.held.push({ id, note: null, mark, lines });
  r.toHq({ callMark: { id, anchor, snip: snip || null, ago } });
  reset(r);
}
