// What the board answers an agent with from a scrap it opened: there is no room or field under a slip to answer in,
// the board draws (or types) on the scrap itself and its Beantwoord sends it (the board, call 262; bookscrapkeys.js).
// What goes is what was drawn and typed on the scrap since it was opened this visit and hasn't gone yet: its strokes,
// and its typed lines as words. It goes as the desk phone's answer to an agent's card still open on the scrap
// (bookasks.js), else as the reply to the agent's newest answer under it (the store's reply route, which sends it to
// that agent).
import { ask } from './notebookdata.js';
import { readAgain } from './booksave.js';
import { slipsUnder } from './notebookstack.js';

// An opened scrap's page record (bookscrapopen.js) seen: what's on it as it's first opened this visit is the scrap's
// already, never an answer (kept on the record, which the visit keeps). Strokes are told by their ids (bookedit.js);
// typed lines, which a line typed here has none of till it's saved, by their words.
export function seen(page) {
  page.had ??= { ink: new Set(inkOf(page, page.focus).map(s => s.id)), words: new Set(linesOf(page, page.focus)) };
}

// What the board's Beantwoord answers on group g: { ask } (an agent's card on it still open), { answer } (the agent's
// newest answer under it, the board's reply its last word not yet), or null: nothing of an agent's waits on the board
export function turnOf(g) {
  const ask = (g?.asks ?? []).find(a => a.status === 'open');
  if (ask) return { ask };
  const last = slipsUnder(g?.children ?? [])
    .filter(c => c.style !== 'version')
    .at(-1);
  return last?.kind === 'answer' ? { answer: last } : null;
}

// What's on group gid's scrap that goes with its answer: { ink, words }, the strokes and typed lines drawn on it since
// it was opened this visit and not gone yet (page: the scrap's opened record, or the grid's page, whose opened record
// it then reads; not opened: nothing)
export function unsent(page, gid) {
  const scrap = recordOf(page, gid);
  if (!scrap?.had) return { ink: [], words: '' };
  return {
    ink: inkOf(scrap, gid).filter(s => !scrap.had.ink.has(s.id)),
    words: linesOf(scrap, gid)
      .filter(line => !scrap.had.words.has(line))
      .join('\n'),
  };
}
// What went marked gone, so it never goes twice
export function gone(page, gid, { ink, words }) {
  const had = recordOf(page, gid)?.had;
  for (const s of ink) had?.ink.add(s.id);
  for (const line of words ? words.split('\n') : []) had?.words.add(line);
}

// The reply to an agent's answer (its slip's id) from the scrap: what's unsent on it, through the store's reply route,
// the page read again. Refused (nothing drawn or typed, among others), it throws why.
export async function replyFromScrap(book, page, gid, answer) {
  const what = unsent(page, gid);
  await ask(book.dev, '/api/notebooks/groups/reply', null, {
    answer: answer.id,
    ...(what.words && { words: what.words }),
    ...(what.ink.length && { ink: what.ink }),
  });
  gone(page, gid, what);
  // (read again before the sheet is put back, so the grid it goes back onto has the reply)
  await readAgain(book, page);
}

// A scrap's opened record: the page itself when it's that, else the one the grid's page keeps for it this visit
const recordOf = (page, gid) => (page.focus === gid ? page : page.scrapViews?.get(gid)?.page);
// A group's strokes on a page record, and its typed lines' words
const inkOf = (page, gid) => (page.ink ?? []).filter(s => s.g === gid);
const linesOf = (page, gid) =>
  (page.texts ?? [])
    .filter(t => t.g === gid)
    .map(t => t.text.trim())
    .filter(Boolean);
