// The Pencil on a call (HQ's call tells it what it needs through the document's events:
// platform/hq/shell/ink/calldraw.js; Ink's folder). While a call is on, a mark
// goes on the call's page in the book, not on a sheet: the agent on the call is the one listening. No mic of its own:
// the call hears the board, and what it hears while a mark is drawn is the note's words. The mark goes into the book as
// every mark does (settle.js), and HQ's call sends it to the agent ('pencil:note', marks.js). It's for the agent:
// nothing of it goes into the notebook by itself (the agent makes a scrap of what it judges worth keeping), and its ink
// stays drawn (r.held) until the agent's turn on it is done, then goes, so the board circles afresh on a clean screen
// (the board, call 161.).
// The agent's ink isn't the Pencil's: drive.js rings where it aims, over the page, and nothing of it goes in the book
//   call:on    { call, agent, name, color }  a call is on: its calls row, its agent, its name and its ink
//   call:off   { done }                       it ended; done() once a mark still settling is in the book
//   call:heard { text }                       words the call heard the board say
//   call:had   { note }                       the agent's turn on that note is done (or the line couldn't take it):
//                                             its ink goes
//   call:mark  { anchor, snip, ago, answer }  a mark the Pencil made on the page in HQ's viewer (its callframe.js,
//                                             through HQ's desk.js): filed as this screen's own, with the words heard
//                                             since its first line, ago ms back; answer({ note } or { failed }) says how
//                                             it went
import { reset } from './acts.js';
import { say } from './dock.js';
import { file, heardSince } from './settle.js';
import { paint, post } from './marks.js';

// Words the call heard are kept this long for the mark being drawn (the line hears a phrase once it's finished)
const HEARD_MS = 60_000;
// How long the Pencil's tip says a mark couldn't go into the book
const TOLD_MS = 8000;

export function setupCall(r) {
  Object.assign(r, { call: null, callHeard: [], held: [] });
  document.addEventListener('call:on', e => {
    r.call = e.detail;
    r.callHeard = [];
    // (a walk-through's page is the call's notes page, opened by HQ's call: no second one.)
  });
  document.addEventListener('call:off', e => ended(r).finally(() => e.detail?.done?.()));
  document.addEventListener('call:heard', e => {
    const now = performance.now();
    r.callHeard = [...r.callHeard.filter(h => now - h.at < HEARD_MS), { at: now, text: String(e.detail?.text ?? '') }];
  });
  document.addEventListener('call:had', e => {
    r.held = r.held.filter(h => h.note !== e.detail?.note);
    paint(r);
  });
  document.addEventListener('call:mark', e => framed(r, e.detail));
}
// A mark from the viewer's page, on the call's page as one drawn here would be (marks.js post tells the call of it):
// its ink stays there, not here
async function framed(r, { anchor, snip, ago, answer }) {
  if (!r.call) return answer({ failed: 'The call had ended.' });
  const since = performance.now() - ago,
    words = heardSince(r, since);
  try {
    const note = await post(r, { anchor, words, said: words ? 'spoken' : null, snip });
    answer({ note: note.id });
  } catch (err) {
    console.error("The Pencil: a mark from the viewer's page", err);
    answer({ failed: err?.status ? `The book said no: ${err.message}.` : 'Could not reach the book.' });
  }
}

// The call ended: a mark going in, then one still settling (one the book said no to, tried once more). One the book
// still won't take is gone with the call, and the board is told. One whose last try never heard back isn't sent again:
// the book may have it, and a second try would make it twice. Lines drawn after that try go in on their own, with the
// words heard since it, and the board is told the book may still have the lines it undid since. (One whose last try
// never heard back)
async function ended(r) {
  clearTimeout(r.settleTimer);
  await r.filing;
  const unheard = r.mark && r.unheard?.mark === r.mark ? r.unheard : null;
  const undone = unheard?.sent.some(l => !r.strokes.includes(l));
  if (unheard) {
    r.strokes = r.strokes.filter(l => !unheard.sent.includes(l));
    r.markAt = unheard.at;
  }
  const lost =
    "The connection dropped as the call's last mark went in: look for the mark on the call's page in the book" +
    (undone ? ', where it may still have the lines you undid since.' : '.');
  if (unheard && !r.strokes.length) {
    say(r, lost, TOLD_MS);
    reset(r);
  } else if ((await file(r)) === false) {
    say(r, "The call's last mark couldn't go into the book, so it isn't kept.", TOLD_MS);
    reset(r);
  } else if (unheard) say(r, lost, TOLD_MS);
  r.call = null;
  r.unheard = null;
  r.callHeard = [];
  r.held = [];
  paint(r);
}
