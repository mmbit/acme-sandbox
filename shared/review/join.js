// A line drawn on or beside a note's hairline joins that note (pencil.js): the note opens again as the mark being made,
// its ink and the new lines one mark, and as it settles (settle.js) the note is changed in the book, its ink, its snip
// cut again and the words said since added, rather than a new one made. Undo puts the note back as it was.
import { nearLines } from './mark.js';
import { send } from './markpage.js';
import * as marks from './marks.js';

// A line this close to a note's ink (px, round its box) joins it: on it, or just beside it as an arrow or a word is
const NEAR_PX = 24;

// The board's note a first line joins, taken off the page's marks while it's open again, with its ink on the screen
// now: { m, lines }, or null. Never the call's agent's ink, which is theirs, and off a call never a call's note: a new
// circle goes to its owner's sheet as a note of its own.
export function joining(r, area) {
  const near = m => {
    const ink = marks.placed(m);
    return nearLines(area, ink, NEAR_PX) && marks.showsNow(r, m, ink);
  };
  const ours = x => (r.call ? x.by !== r.call.agent : !x.onCall);
  const m = [...(r.marks ?? [])].reverse().find(x => ours(x) && near(x));
  if (!m) return null;
  r.marks = r.marks.filter(x => x !== m);
  r.marksStale = true; // (back as the book has it once the mark ends, joined or let go: pencil.js unmark)
  return { m, lines: marks.placed(m) };
}

// The joined mark into the book: the note it joins changed (its ink, the snip cut again, the words said since after
// its own), a step to undo, and heard as a note is ('pencil:note'). Returns the note.
export async function rejoin(r, m, { anchor, words, said, snip }) {
  const before = { anchor: m.anchor, words: m.words, said: m.said, snip: m.snip && (await pictureOf(m.snip)) };
  const { note } = await send('/note/edit', {
    id: m.id,
    anchor,
    words: [m.words, words].filter(Boolean).join(' '),
    said: words ? said : m.said,
    ...(snip && { snip }),
  });
  r.steps.push({ kind: 'join', id: m.id, before });
  const call = r.call?.call ?? null;
  document.dispatchEvent(new CustomEvent('pencil:note', { detail: { id: note.id, n: note.n, page: note.page, call } }));
  return note;
}
// ...undone: the note as it was before it was joined
export async function unjoin(r, { id, before }) {
  const { snip, ...rest } = before;
  await send('/note/edit', { id, ...rest, ...(snip && { snip }) });
  await marks.load(r);
}

// A snip from the book, as the data URL the store takes back
async function pictureOf(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`the note's snip: ${res.status}`);
  const blob = await res.blob();
  return new Promise((done, failed) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result);
    reader.onerror = () => failed(reader.error);
    reader.readAsDataURL(blob);
  });
}
