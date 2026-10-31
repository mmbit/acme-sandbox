// A mark's end, the same on a call or not, the Pencil's (pencil.js) or a mouse's on HQ (surface.js): once the pen has
// stayed up SETTLE_MS the mark is done. Its
// note goes into the book with the words heard while it was drawn (the mic's, or on a call the call's own hearing:
// callnotes.js), and its ink lifts off the page into the book (lift.js), nothing of it left where it was (marks.js
// paint: rule zero). On a call the note is for the call's agent, never a scrap of the notebook's by itself: its ink
// stays where it was drawn until the agent's turn on it is done (callnotes.js held; the board, call 161.). Lines drawn while it goes in are drawn at once and make the next mark. A mark the book doesn't take stays, the board is
// told, and it goes in with the next line. This is the one way from a mark to the book: a different flow changes it
// here.
import { stopMic } from './dictation.js';
import { reset } from './acts.js';
import { say } from './dock.js';
import { lift } from './lift.js';
import * as marks from './marks.js';
import { boxOfLines, marked } from './mark.js';
import { expose } from './snapshot.js';
import * as written from './written.js';

// The Pencil up this long and the mark is done: about a breath, so a circle and the arrow after it stay one note
export const SETTLE_MS = 1500;
// How long the Pencil's tip says a mark couldn't go into the book
const TOLD_MS = 8000;
// lifted, handed in by pencil.js: a line the Pencil finished, for the lines drawn while a mark went in (redrawn: the next
// mark's).
let liftedLine;

export function setupSettle(r, { lifted }) {
  Object.assign(r, { nextLines: [], markAt: 0, nextAt: 0, settleTimer: 0, filing: null, unheard: null });
  liftedLine = lifted;
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
  // (only on a call: off one, a mark waits for its post-it's Save, the board's pin flow.)
  document.addEventListener('ink:stroke', e => e.detail?.phase === 'end' && r.call && settleSoon(r));
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
        for (const line of next) liftedLine(r, line);
        settleSoon(r);
      }
      return true;
    },
    err => {
      console.error('The Pencil: a note into the book', err);
      if (r.mark !== mark) return false;
      r.mode = 'note';
      r.unheard = err?.status ? null : tried;
      for (const line of r.nextLines.splice(0)) liftedLine(r, line);
      const why = err?.status ? `The book said no: ${err.message}.` : 'Could not reach the book.';
      say(r, `${why} The mark stays here, and goes in with your next line.`, TOLD_MS);
      return false;
    },
  ));
}
// The lines drawn while a mark went in: the next mark's once it's gone, or its own again if it didn't go (the post-it's
// Save, postit.js booked)
export function nextMark(r) {
  const next = r.nextLines.splice(0);
  if (r.mode === 'idle') r.markAt = r.nextAt;
  for (const line of next) liftedLine(r, line);
}
// ...its words, its note, then its ink lifted into the book; null if it was let go meanwhile (another maybe begun)
async function inBook(r, mark) {
  await heardNow(r);
  if (r.mark !== mark) return null;
  const lines = marks.openLines(r),
    drawn = [...r.strokes],
    went = await toBook(r);
  if (!went) return null;
  if (r.call) {
    r.held.push({ note: went.note.id, mark, lines: drawn });
    marks.paint(r);
  } else await lift(r, { lines, note: { id: went.note.id, page: went.note.page }, snip: went.snip });
  return r.mark === mark ? went : null;
}
// What the call heard the board say since a mark began (performance.now() then; callnotes.js's for a mark in HQ's
// viewer too.)
export const heardSince = (r, at) =>
  r.callHeard
    .filter(h => h.at >= at)
    .map(h => h.text)
    .join(' ')
    .trim();
// The words heard while the mark was drawn: on a call, what the call heard since its first line; else the mic's, once
// any still being said are in
async function heardNow(r) {
  if (!r.call) return (r.rec || r.stopping) && stopMic(r);
  const words = heardSince(r, r.markAt);
  Object.assign(r, { spoken: !!words, typed: false });
  r.text.value = words;
}

// The mark's note into the book (its words once any still being said are in), as it settles (file) or by the post-it's
// Send (postit.js). Its lines then go from the page at once: they live on in its snip. Returns
// { note, snip, photoless: whether it went without its photo (the screenshot failed, or was still developing after
// 9 s), for the post-it to say so }; null if the mark was let go while it developed (another maybe begun: never that
// one's lines).
export async function toBook(r) {
  // (handwriting: the lines not read yet are read now, and words read as written are said 'written')
  written.readNow(r);
  const mark = r.mark,
    words = r.text.value.trim(),
    said = !words ? null : r.spoken && !r.typed ? 'spoken' : !r.typed && words === mark.written ? 'written' : 'typed',
    general = mark.kind === 'general';
  const snip = general ? null : await snipOfMark(r, mark, r.strokes);
  if (r.mark !== mark) return null;
  const anchor = general ? { ...marked(r), el: null } : marked(r);
  const note = await marks.post(r, { anchor, live: r.mark.el, words, said, snip });
  r.steps.push({ kind: note.group ? 'scrap' : 'note', id: note.id }); // (scrap)
  written.sent(r, mark, note);
  mark.filed = true;
  marks.paint(r);
  return { note, snip, photoless: !general && !snip };
}
// A mark's snip of its screenshot once taken, round its lines (or its element, with none), or null: the screenshot
// failed, was still developing after SHOT_WAIT_MS, or the mark was let go meanwhile (toBook, and on a call
// callframe.js.)
const SHOT_WAIT_MS = 9000;
export async function snipOfMark(r, mark, lines) {
  const taken = await Promise.race([r.shot, new Promise(res => setTimeout(() => res(null), SHOT_WAIT_MS))]);
  if (!taken || r.mark !== mark) return null;
  return marks.snipOf({ c: expose(r, taken, mark), k: taken.k }, lines.length ? boxOfLines(lines) : mark.element.rect);
}
