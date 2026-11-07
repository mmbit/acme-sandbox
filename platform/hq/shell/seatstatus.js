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

// A seat's row: its name, its state in a word, how many jobs run on it and what new work waits for (the coordinator's
// seatstatus.ts: admission apart from the work under way, so a paced seat with five running never reads as out), and
// its windows as bars. A seat the worker hasn't reported yet has no status: its word alone.
function row(s) {
  const status = s.removing ? null : s.status,
    state = s.removing ? 'removing' : s.state === 'ready' ? (HELD[status?.admission] ?? 'ready') : (s.state ?? 'new');
  const word =
    {
      paced: 'paced',
      login: s.sign_in === 'key' ? 'needs key' : 'signed out',
      new: 'setting up',
      draining: 'stopped',
      sleeping: 'waiting',
    }[state] ?? state;
  const weekReset = resetOf(s.week_resets, WEEK_MS);
  // what a paced seat still takes and until when, as its state's tooltip, with the worker's note
  const says = [state === 'paced' ? pacedWords(status) : '', s.note ? cap(s.note) : ''].filter(Boolean);
  const bars = [
    bar('5-hour', s.util, resetOf(s.resets)),
    bar('Week', s.week, weekReset, state === 'paced' ? evenPace(s, weekReset) : null),
  ].join('');
  const now = status ? nowWords(status, s.state) : '';
  return (
    `<li data-seat="${esc(s.id)}"><b class="seat-name">${engineMark(s.cli ?? s.engine)}${esc(s.id)}</b>
    <span class="st st-${esc(state)}"${says.length ? ` title="${esc(says.join('. '))}"` : ''}>${esc(word)}</span>` +
    `${now ? `<span class="seat-until">${esc(now)}</span>` : ''}${bars ? `<div class="use">${bars}</div>` : ''}</li>`
  );
}
// A ready seat the server holds back: paced, or waiting (at its stop level, or for the worker's next start)
const HELD = { paced: 'paced', unavailable: 'sleeping' };
// What runs on a seat and what new work waits for, in a few words: "5 running · urgent only until Thu 08:33". A seat
// signed out or paused says so in its word, and takes nothing new until the board acts.
function nowWords(status, state) {
  const running = status.running ? `${status.running} running` : 'nothing running';
  if (!['ready', 'sleeping', 'draining'].includes(state)) return status.running ? running : '';
  const until = status.until ? ` until ${clockWhen(status.until)}` : '';
  const admits = {
    open: 'takes new work',
    paced: `urgent only${until}`,
    unavailable: outWords(status),
  }[status.admission];
  return `${running} · ${admits}`;
}
// Why a seat takes no new work and when it's back, by the status's reason:
// - 'usage': no usage read since the worker started, so no return time is known yet
// - 'quota': at its stop level until its window resets
// - 'provider': held by its provider until the hold ends
// - 'drained': held at its stop until the hold the worker reported ends
// A held Codex seat is checked again before then, at its nextCheck.
function outWords(status) {
  const from = status.until ? `new work from ${clockWhen(status.until)}` : '';
  const check = status.nextCheck ? `, checked again ${clockWhen(status.nextCheck)}` : '';
  if (status.reason === 'usage') return 'no new work until its usage is read';
  if (status.reason === 'quota') return `at its stop, ${from || 'reset not reported'}${check}`;
  const held = { provider: 'held by its provider', drained: 'held at its stop' }[status.reason];
  if (held) return `${held}, ${from || 'return time not reported'}${check}`;
  return from || 'no new work';
}
// A paced seat's tooltip: what it still takes, and when its pace lets the rest start, at its use so far (more use moves
// that later)
const pacedWords = status =>
  `Takes only urgent work and your conversations${status?.until ? ` until ${clockWhen(status.until)}, at its use so far` : ''}`;
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
