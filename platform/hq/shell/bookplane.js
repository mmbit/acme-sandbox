// The paper plane that sends a sheet, or a free page on its own (booksendpage.js): it flies off to the face it goes
// to with a soft paper whoosh, then ten seconds to undo, a ring running out round it, calm, with Undo beside it.
import { esc } from '../util.js';
import { noise, ready } from './audio.js';
import { faceBox } from './bookrail.js';
import { SEND_MS, sendSheet, undoSend } from './booksheetdata.js';
import { leftOf, whose } from './booksheetplace.js';

// the plane's ring: its circle's length, which runs out over the seconds to undo (booksheet.css bs-run's end)
const RING = 87.96;
export const PLANE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 11.2 21 3.5l-4.6 17-5.1-5.6-3.1 3.6.4-5.3z" fill="#fff" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.6 13.2 21 3.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

// The seconds to undo a send: a ring running out round the plane, calm, and Undo beside it
export function flightHtml(sh, sheet, to) {
  const deadline = deadlineOf(sh, sheet),
    left = leftOf(deadline, Date.now(), SEND_MS);
  return `<span class="bs-flight" role="timer" aria-label="Sending to ${esc(to)}, ten seconds to undo">
    <svg class="bs-ring" viewBox="0 0 32 32" aria-hidden="true"><circle class="bs-track" cx="16" cy="16" r="14"/><circle
      cx="16" cy="16" r="14" style="stroke-dasharray: ${RING}; stroke-dashoffset: ${RING * (1 - left)}; animation-duration: ${Math.max(
        0,
        deadline - Date.now(),
      )}ms"/></svg>${PLANE}
    <button class="bs-undo" data-undo="${sheet.id}" aria-label="Undo the send to ${esc(to)}">Undo</button></span>`;
}
// When a send goes, in this browser's clock: as the store answered the tap here, else its send_at (within the seconds)
function deadlineOf(sh, sheet) {
  const now = Date.now();
  return sh.deadlines.get(sheet.id) ?? Math.min(now + SEND_MS, Math.max(now, sheet.send_at ?? now));
}

// The plane tapped: it flies off to the face, a soft paper whoosh, and the sheet goes in ten seconds unless undone
export async function sendNow(sh, v, sheet, plane, send = () => sendSheet(sh.dev, sheet.id)) {
  if (!sheet) return;
  fly(plane, faceBox(whose(sheet, sh.ceo())));
  whoosh();
  try {
    const s = await send();
    sh.deadlines.set(s.id, Date.now() + SEND_MS);
    sh.book.steps.push({ sheet: s.id, undo: () => undoNow(sh, v, s) });
  } catch (e) {
    sh.tell(v.page, e);
  }
  sh.refresh();
}
export async function undoNow(sh, v, sheet) {
  if (!sheet) return;
  sh.book.steps = sh.book.steps.filter(step => step.sheet !== sheet.id);
  sh.deadlines.delete(sheet.id);
  try {
    await undoSend(sh.dev, sheet.id);
  } catch (e) {
    sh.tell(v.page, e);
  }
  sh.refresh();
}
// A send in its seconds: the sheets read again as they end (the store sends it then), and again a little later if the
// two clocks disagree
export function awaitSend(sh, sheet) {
  sh.waits ??= new Map();
  if (sh.waits.has(sheet.id)) return;
  const tries = (sh.tries ??= new Map()),
    n = tries.get(sheet.id) ?? 0;
  if (n > 8) return;
  tries.set(sheet.id, n + 1);
  const wait = Math.max(0, deadlineOf(sh, sheet) - Date.now()) + 300 + n * 700;
  sh.waits.set(
    sheet.id,
    setTimeout(() => {
      sh.waits.delete(sheet.id);
      sh.refresh();
    }, wait),
  );
}
// The plane's own flight to the face it goes to (or up off the paper)
function fly(plane, to) {
  const from = plane?.getBoundingClientRect();
  if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ghost = document.createElement('i');
  ghost.className = 'bs-flying';
  ghost.innerHTML = PLANE;
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px` });
  (plane.closest('#book') ?? document.body).append(ghost);
  const dx = (to ? to.left + to.width / 2 : innerWidth) - from.left - 12,
    dy = (to ? to.top + to.height / 2 : from.top - 120) - from.top - 12;
  ghost
    .animate(
      [
        { transform: 'translate(0, 0) rotate(0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.2 - 40}px) rotate(-12deg) scale(1.15)`, opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) rotate(8deg) scale(0.6)`, opacity: 0 },
      ],
      { duration: 650, easing: 'cubic-bezier(.3,.1,.3,1)' },
    )
    .finished.then(() => ghost.remove());
}
// a soft paper whoosh (the book's only sound), when HQ's sound is on
function whoosh() {
  if (!ready()) return;
  noise(0.05, { vol: 0.03, freq: 3200, type: 'highpass' });
  noise(0.5, { vol: 0.045, freq: 500, sweep: 5, q: 0.7, attack: 0.14, at: 0.03 });
}
