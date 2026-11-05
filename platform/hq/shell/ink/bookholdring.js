// The ring round the pen while a double tap's second press is held for a voice note (bookinput.js): put on the screen
// where the press came down (the pen's, not the page's), it fills round the point in the hold this device's preferences
// give it, wide enough to show round a Pencil's tip and a fingertip, never under them (the hand hides what's under the
// tip: the board, call 262). Full, it closes and lets go as the note starts recording (bookvoice.js: its bars); a press
// that wanders, lifts early or meets a second finger takes it away at once. It takes no press, and its style is
// bookvoice.css's.

// the ring's radius in its 44 px box, and its line's length round
const R = 17,
  ROUND = 2 * Math.PI * R;
// it shows this long after the press (ms), so a quick double tap's second press flashes nothing, and fills in the rest
const SHOW_MS = 80;
// closed, it lets go this long (ms: bookvoice.css's bk-hold-done)
const DONE_MS = 260;

// down: the press (its clientX, clientY); ms: the hold. Returns { full(), gone() }.
export function holdRing(down, ms) {
  const el = document.createElement('div');
  el.className = 'bk-hold-ring';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `left:${down.clientX}px;top:${down.clientY}px;--bk-round:${ROUND};--bk-show:${SHOW_MS}ms;--bk-fill:${Math.max(0, ms - SHOW_MS)}ms`;
  el.innerHTML = `<svg viewBox="0 0 44 44"><circle class="bk-hold-under" cx="22" cy="22" r="${R}"/><circle class="bk-hold-fill" cx="22" cy="22" r="${R}"/></svg>`;
  document.body.append(el);
  return {
    // (the hold reached: it closes, swells a touch and fades as the recording starts)
    full() {
      el.dataset.full = '';
      setTimeout(() => el.remove(), DONE_MS);
    },
    gone: () => el.remove(),
  };
}
