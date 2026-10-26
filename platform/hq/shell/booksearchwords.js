// Finding words in the book (Search, booksearch.js; the store's route, booksearch.ts): the matching both share, as plain
// data, so node tests it. Each of a query's words finds a word that starts with it, in any case and with or without
// accents ("cafe" finds "Café's"), so the list narrows as the board writes.
import { fold } from '../util.js'; // (the fold every search box shares)

// the characters either side of a find that its line shows
const AROUND_CHARS = 60;
// how many finds come back, the newest, the rest counted so Search says how many more there are and that a word more
// narrows them: the list is for picking one, and cutting each find to its words is the slow part (5,000 finds take a
// quarter of a second of the store's one thread, at every pause in the writing; 30 take a few milliseconds)
const SHOWN = 30;
const WORDY = /[\p{L}\p{N}]/u;

// A query's words, folded, each once
export const termsOf = q => [...new Set(fold(q).split(/[^\p{L}\p{N}]+/u))].filter(Boolean);

// Whether the term starts a word of the folded text
function startsAWord(folded, term) {
  for (let i = folded.indexOf(term); i >= 0; i = folded.indexOf(term, i + 1)) if (startsWord(folded, i)) return true;
  return false;
}
// Whether a word starts at the folded text's index i (two code units back reach the last character, a pair's whole)
const startsWord = (folded, i) => !i || !WORDY.test([...folded.slice(Math.max(0, i - 2), i)].pop());

// Where the terms start a word in the text: [{ start, end }] in the text's own characters, in order, overlaps joined
function marksOf(text, terms) {
  const placed = place(text),
    found = [];
  for (const term of terms)
    for (let i = placed.folded.indexOf(term); i >= 0; i = placed.folded.indexOf(term, i + 1))
      if (startsWord(placed.folded, i)) found.push({ start: placed.starts[i], end: placed.ends[i + term.length - 1] });
  return joined(found);
}
// Whether every term starts a word in the text (the whole text folded once: the positions are for what's shown)
const findsAll = (text, terms) => {
  const folded = fold(text);
  return terms.length > 0 && terms.every(term => startsAWord(folded, term));
};

// The finds among entries ({ text, day, at, ... }: a note's words, an answer): { found: the first SHOWN, newest first,
// each text cut to the words around its first find, total: how many there are }
export function findIn(entries, q) {
  const terms = termsOf(q);
  if (!terms.length) return { found: [], total: 0 };
  const all = entries
    .filter(e => findsAll(e.text, terms))
    .sort((a, b) => `${b.day} ${b.at}`.localeCompare(`${a.day} ${a.at}`));
  return { found: all.slice(0, SHOWN).map(e => ({ ...e, text: excerpt(e.text, terms) })), total: all.length };
}
// The index after the first space at or after start (start itself when there's none)
const firstSpaceFrom = (words, start) => words.indexOf(' ', start) + 1 || start;
// The words around a text's first find, cut at spaces, an ellipsis where it was cut
function excerpt(text, terms) {
  const words = String(text).replace(/\s+/g, ' ').trim(),
    first = marksOf(words, terms)[0];
  if (!first || words.length <= 2 * AROUND_CHARS + first.end - first.start) return words;
  let start = Math.max(0, first.start - AROUND_CHARS),
    end = Math.min(words.length, first.end + AROUND_CHARS);
  if (start > 0) start = Math.min(first.start, firstSpaceFrom(words, start));
  if (end < words.length) end = Math.max(first.end, words.lastIndexOf(' ', end));
  return `${start > 0 ? '…' : ''}${words.slice(start, end)}${end < words.length ? '…' : ''}`;
}
// A text as HTML, its finds marked; esc: the caller's escaping
export function marked(text, terms, esc) {
  let html = '',
    at = 0;
  for (const { start, end } of marksOf(text, terms)) {
    html += `${esc(text.slice(at, start))}<mark>${esc(text.slice(start, end))}</mark>`;
    at = end;
  }
  return html + esc(text.slice(at));
}

// The folded text and, for each of its characters, where the character it came from starts and ends in the text
function place(text) {
  let folded = '',
    i = 0;
  const starts = [],
    ends = [];
  for (const char of String(text)) {
    const foldedChar = fold(char);
    for (let k = 0; k < foldedChar.length; k++) {
      starts.push(i);
      ends.push(i + char.length);
    }
    folded += foldedChar;
    i += char.length;
    // (a combining mark folds to nothing: it belongs to the character before it)
    if (!foldedChar.length && ends.length) ends[ends.length - 1] = i;
  }
  return { folded, starts, ends };
}
function joined(marks) {
  const out = [];
  for (const m of marks.sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && m.start <= last.end) last.end = Math.max(last.end, m.end);
    else out.push({ ...m });
  }
  return out;
}
