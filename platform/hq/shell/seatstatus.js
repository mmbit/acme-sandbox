// HQ-OS › Seats: how the team's AI seats are doing, at a glance (Settings › Seats changes them: seats.js).
import { esc, cap } from '../util.js';
import { loadSeats } from './data.js';
import { engineMark } from './engine.js';
import { clockWhen } from '../world/clock.js';

const WEEK_MS = 7 * 864e5;

// desk.js calls this on opening Seats and every 15 s
export async function seatStatus(el, h) {
  const list = await loadSeats(h.dev);
  if (!list.length) {
    el.innerHTML = '<p><i class="prompt">&gt; </i>No seats yet.</p>';
    return;
  }
  el.innerHTML = `<ul class="rows seat-status">${list.map(row).join('')}</ul>`;
}

function row(s) {
  const state = s.removing ? 'removing' : s.state === 'ready' && s.pace ? 'paced' : (s.state ?? 'new');
  const word =
    {
      paced: 'paced',
      login: s.sign_in === 'key' ? 'needs key' : 'signed out',
      new: 'setting up',
      draining: 'stopped',
      sleeping: 'waiting',
    }[state] ?? state;
  const weekReset = resetOf(s.week_resets, WEEK_MS);
  // what a paced seat still takes till its week resets (the worker's pacedUntil), as its state's tooltip, with its note
  const says = [
    state === 'paced' && weekReset ? `Takes only your work and what must start before ${clockWhen(weekReset)}` : '',
    s.note ? cap(s.note) : '',
  ].filter(Boolean);
  const bars = [
    bar('5-hour', s.util, resetOf(s.resets)),
    bar('Week', s.week, weekReset, state === 'paced' ? evenPace(s, weekReset) : null),
  ].join('');
  const until =
    s.until && !s.removing
      ? `<span class="seat-until">${['sleeping', 'draining'].includes(s.state) ? 'until' : 'next job'} ` +
        `${esc(clockWhen(s.until))}</span>`
      : '';
  return (
    `<li data-seat="${esc(s.id)}"><b class="seat-name">${engineMark(s.cli ?? s.engine)}${esc(s.id)}</b>
    <span class="st st-${esc(state)}"${says.length ? ` title="${esc(says.join('. '))}"` : ''}>${esc(word)}</span>` +
    `${until}${bars ? `<div class="use">${bars}</div>` : ''}</li>`
  );
}
// Where the week would be now at an even pace to the seat's stop level: past it, the seat runs out before its reset
function evenPace(s, reset, now = Date.now()) {
  const gone = reset ? 1 - (reset - now) / WEEK_MS : 0;
  return gone > 0 ? ((s.stop ?? 90) / 100) * Math.min(1, gone) : null;
}

// ---- the bars
// a window's share as a bar, nearly full in the warning colour, its reset's time beside it, and a tick at `at` (an even
// pace); nothing for a window never measured
function bar(label, share, resets, at = null) {
  if (share == null) return '';
  const pct = Math.round(share * 100),
    tick = at == null ? '' : `<b class="pace-at" style="left: ${Math.round(at * 1000) / 10}%"></b>`;
  const value = `aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"`;
  const reset = resets
    ? `<span class="use-reset" title="Resets ${esc(clockWhen(resets))}">↻ ${esc(clockWhen(resets))}</span>`
    : '<span class="use-reset"></span>';
  return (
    `<span class="use-label">${label}</span>` +
    `<span class="bar${pct >= 90 ? ' full' : ''}" role="meter" ${value} aria-label="${label} window">` +
    `<i style="width: ${pct}%"></i>${tick}</span><span class="use-pct">${pct}%</span>${reset}`
  );
}
// A window's next reset from the last one the server knows (it keeps it through readings without one): a past one is
// still known for a window of a fixed length (a week's next is 7 days on); a 5-hour window's starts at its next use, so
// it's nothing until the next reading.
function resetOf(resetMs, windowMs, now = Date.now()) {
  if (!resetMs) return null;
  if (resetMs > now) return resetMs;
  return windowMs ? resetMs + Math.ceil((now - resetMs) / windowMs) * windowMs : null;
}
