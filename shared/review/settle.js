// A mark's end, the same on a call or not, the Pencil's (pencil.js) or a mouse's on HQ (surface.js): once the pen has
// stayed up SETTLE_MS the mark is done. Its
// note goes into the book with the words heard while it was drawn (the mic's, or on a call the call's own hearing:
// callnotes.js), and its ink lifts off the page into the book (lift.js), a hairline left where it was (marks.js). Lines
// drawn while it goes in are drawn at once and make the next mark. A mark the book doesn't take stays, the board is
// told, and it goes in with the next line. This is the one way from a mark to the book: a different flow changes it
// here.
import { stopMic } from './dictation.js';
import { reset } from './tool.js';
import { say } from './dock.js';
import { lifted, toBook } from './pencil.js';
import { lift } from './lift.js';
import * as marks from './marks.js';

// The Pencil up this long and the mark is done: about a breath, so a circle and the arrow after it stay one note
export const SETTLE_MS = 1500;
// How long the Pencil's tip says a mark couldn't go into the book
const TOLD_MS = 8000;

export function setupSettle(r) {
  Object.assign(r, { nextLines: [], markAt: 0, nextAt: 0, settleTimer: 0, filing: null, unheard: null });
  // the Pencil down (or a mouse on the marking veil) holds the mark open; each line it ends gives it SETTLE_MS more.
  // (Down while the last mark goes in: the next mark's first line, its words heard from here.)
  addEventListener(
    'pointerdown',
    e => {
      if (e.pointerType !== 'pen' && r.veil.hidden) return;
      clearTimeout(r.settleTimer);
      if (r.mode === 'idle' || r.mode === 'pick') r.markAt = performance.now();
      else if (r.mode === 'sending' && !r.nextLines.length) r.nextAt = performance.now();
    },
    true,
  );
  document.addEventListener('ink:stroke', e => e.detail?.phase === 'end' && settleSoon(r));
}
export function settleSoon(r) {
  clearTimeout(r.settleTimer);
  r.settleTimer = setTimeout(() => file(r), SETTLE_MS);
}

// The mark into the book, then lifted into it; whether it went in. Only where there's a book: on a page without one
// a mark has its post-it, and goes by its Send. If the book didn't take it, the mark stays,
// the lines drawn meanwhile with it, and the board is told: the next line drawn tries again as it settles. unheard:
// the mark whose last try never heard back, so it may be in the book already, with the lines that try carried and
// when it went (callnotes.js ended)
export function file(r) {
  if (!r.book || r.mode !== 'note' || !r.mark || !r.sheet.hidden) return;
  r.mode = 'sending';
  const mark = r.mark,
    tried = { mark, sent: [...r.strokes], at: r.markAt };
  return (r.filing = inBook(r, mark).then(
    went => {
      if (!went) return false;
      const next = r.nextLines.splice(0);
      r.unheard = null;
      reset(r);
      r.markAt = r.nextAt; // (a pen still down now lifts into the next mark: its words count from its pen-down)
      if (next.length) {
        for (const line of next) lifted(r, line);
        settleSoon(r);
      }
      return true;
    },
    err => {
      console.error('The Pencil: a note into the book', err);
      if (r.mark !== mark) return false;
      r.mode = 'note';
      r.unheard = err?.status ? null : tried;
      for (const line of r.nextLines.splice(0)) lifted(r, line);
      const why = err?.status ? `The book said no: ${err.message}.` : 'Could not reach the book.';
      say(r, `${why} The mark stays here, and goes in with your next line.`, TOLD_MS);
      return false;
    },
  ));
}
// ...its words, its note, then its ink lifted into the book; null if it was let go meanwhile (another maybe begun)
async function inBook(r, mark) {
  await heardNow(r);
  if (r.mark !== mark) return null;
  const lines = marks.openLines(r),
    went = await toBook(r);
  if (!went) return null;
  await lift(r, { lines, note: { id: went.note.id, page: went.note.page }, snip: went.snip });
  return r.mark === mark ? went : null;
}
// The words heard while the mark was drawn: on a call, what the call heard since its first line; else the mic's, once
// any still being said are in
async function heardNow(r) {
  if (!r.call) return (r.rec || r.stopping) && stopMic(r);
  const words = r.callHeard
    .filter(h => h.at >= r.markAt)
    .map(h => h.text)
    .join(' ')
    .trim();
  Object.assign(r, { spoken: !!words, typed: false });
  r.text.value = words;
}
