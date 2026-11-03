// A review round's book (bookshelf.js draws it, bookshelfbooks.js its book on the Shelf): Close the round (its overview's
// options, bookshelfoptions.js), asking first while asks are open; then the Shelf, the book wrapped in its envelope and
// away to the CEO; back, its string pulled, unwrapped and opened at its first Advice page. Each moment of the envelope's played softly, heard as paper.
import { heard } from './booksounds.js';
import { closeRound, loadPages, unwrapRound } from './notebookdata.js';

// s: the overview's state (bookshelf.js mountScreens). ui: { draw(), refresh(), told(words) }, the overview's own.
// Returns rounded(n, what): a round's button pressed ('close', 'anyway', 'keep', 'unwrap').
export function mountRounds(s, ui) {
  pullable(s, ui);
  return (n, what) => rounded(s, ui, n, what);
}

// A round's buttons: Close the round, its question's Close and Not yet, the envelope's string pulled
function rounded(s, ui, n, what) {
  if (s.playing) return;
  if (what === 'keep') {
    s.asking = null;
    return ui.draw();
  }
  if (what === 'close' || what === 'anyway') return closeIt(s, ui, n, what === 'anyway');
  if (what === 'unwrap' && n.round.state === 'back') return unwrap(s, ui, n);
}
// Close the round: refused while asks are open (asksOpen), the question asked in its options with the count read
// again; closed, the Shelf shows it wrapped in its envelope. Any other refusal is said as it is.
async function closeIt(s, ui, n, anyway) {
  s.asking = null;
  let closed;
  try {
    closed = await closeRound(s.dev, n.id, anyway);
  } catch (e) {
    if (e.reason === 'asksOpen' && !anyway) {
      s.asking = { id: n.id };
      await ui.refresh();
      return s.far.querySelector('.bk-round-ask [data-round=anyway]')?.focus();
    }
    ui.draw();
    return ui.told(e.message);
  }
  n.round = closed; // (the round as the Shelf reads it, away)
  if (s.level === 'pages') {
    s.menu = false;
    return s.hooks.shelf();
  }
  await played(s, ui, n, 'wrap');
  ui.refresh();
}
// The string pulled: it unwinds, the flap opens, the Advice comes out; the book opens at its first Advice page
async function unwrap(s, ui, n) {
  const asked = unwrapRound(s.dev, n.id);
  asked.catch(() => {});
  await played(s, ui, n, 'unwrap');
  try {
    await asked;
    const { pages } = await loadPages(s.dev, n.id),
      advice = pages.find(p => p.chapter === 'advice');
    if (advice) return s.hooks.open(advice, n.id);
    s.hooks.notebook(n.id);
  } catch (e) {
    ui.told(e.message);
    ui.refresh();
  }
}
// An envelope's moment on the Shelf, heard softly (booksounds.js): wrapped, the cover goes in, the flap folds down and
// the string winds round (1.4 s); unwrapped, the other way (1.6 s). Without motion, straight to the end.
const PLAYS = { wrap: 1400, unwrap: 1600 };
async function played(s, ui, n, kind) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  s.playing = still ? null : { id: n.id, kind };
  if (kind === 'wrap' && n.round) n.round = { ...n.round, state: 'away' };
  heard(kind);
  ui.draw();
  if (still) return;
  await new Promise(res => setTimeout(res, PLAYS[kind]));
  s.playing = null;
}
// The string pulled with a finger: a drag down from its end unwraps as a tap does
function pullable(s, ui) {
  let from = null;
  s.far.addEventListener('pointerdown', e => {
    from = e.target.closest?.('.bk-round[data-state=back] .bk-env-pull') ? { y: e.clientY, e } : null;
  });
  s.far.addEventListener('pointermove', e => {
    if (!from || e.clientY - from.y < 18) return;
    const tile = from.e.target.closest('.bk-tile');
    from = null;
    const n = s.read.shelf?.shelf.find(b => String(b.id) === tile.dataset.book);
    if (n?.round?.state === 'back') {
      s.swallow = true;
      setTimeout(() => (s.swallow = false), 400);
      unwrap(s, ui, n);
    }
  });
  s.far.addEventListener('pointerup', () => (from = null));
}
