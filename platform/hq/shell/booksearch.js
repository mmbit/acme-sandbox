// The book's Search (the rail's magnifier, bookrail.js's book:search): a card over the book's paper with one line to
// write on, with the Pencil (Apple's Scribble turns handwriting in a field into type, nothing of ours) or a keyboard.
// What the book holds is found as it's written: handwriting read into type, words said while drawing, typed notes and
// the agents' answers on them. A find tapped opens its page in the book at its note, the number lit (bookpages.js
// find). The store's route is booksearch.ts, the matching booksearchwords.js.
import { esc, titleCase } from '../util.js';
import * as world from '../world/world.js';
import { act } from './data.js';
import { dayOf, loadDay } from './bookdata.js';
import { loadSheets } from './booksheetdata.js';
import { dayName } from './bookhead.js';
import { findIn, marked, termsOf } from './booksearchwords.js';

// a pause in the writing this long asks the store (Scribble's words land a word at a time)
const ASK_MS = 150;

const LENS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const HTML = `<div class="bk-find" role="search" hidden>
  <div class="bk-find-line">${LENS}<input type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off"
    spellcheck="false" placeholder="Write a word to find" aria-label="Find in the book">
    <button class="bk-find-shut" title="Close Search"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="sr">Close Search</span></button></div>
  <p class="bk-find-say" role="status"></p>
  <ol class="bk-found"></ol></div>`;

// leaf: the book's paper's section (book.js). dev: on mock data. find({ day, page, note }): the book opens the page
// at the note (bookpages.js), opened first if it was folded (open()).
export function mountSearch(leaf, { dev, open, find }) {
  leaf.insertAdjacentHTML('beforeend', HTML);
  const card = leaf.querySelector('.bk-find'),
    s = {
      dev,
      leaf,
      card,
      field: card.querySelector('input'),
      say: card.querySelector('.bk-find-say'),
      list: card.querySelector('.bk-found'),
      asked: 0,
      timer: 0,
      found: [],
      caretDue: false,
    };
  document.addEventListener('book:search', () => (card.hidden ? show(s) : hide(s)));
  // put away, the book takes Search with it (the next magnifier tap brings it back); opened, the caret it waited for
  document.addEventListener('book:layout', e => {
    if (e.detail.mode === 'folded') hide(s);
    else if (s.caretDue) caret(s);
  });
  card.querySelector('.bk-find-shut').addEventListener('click', () => hide(s));
  s.field.addEventListener('input', () => {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => ask(s), ASK_MS);
  });
  card.addEventListener('keydown', e => {
    if (e.key === 'Escape') hide(s);
    if (e.key === 'Enter' && e.target === s.field) s.list.querySelector('button')?.click();
  });
  s.list.addEventListener('click', e => {
    const f = s.found[Number(e.target.closest('[data-i]')?.dataset.i)];
    if (!f) return;
    hide(s);
    open();
    find({ day: f.day, page: f.page, note: f.note });
  });
  told(s);
}

// Open, the words written last still there: a keyboard's caret ready where there's a mouse, once the book is open (a
// folded book's paper is inert and takes no focus: the caret waits for its book:layout); on a touch screen the field
// waits for the Pencil or a tap, so no keyboard comes up over the finds
function show(s) {
  s.card.hidden = false;
  s.caretDue = matchMedia('(pointer: fine)').matches;
  if (s.caretDue && !s.leaf.inert) caret(s);
  if (s.field.value.trim()) ask(s);
}
function caret(s) {
  s.caretDue = false;
  s.field.focus();
}
function hide(s) {
  s.card.hidden = true;
  s.caretDue = false;
  s.field.blur();
}

// The store asked for the words in the field now; only the latest question's finds are shown
async function ask(s) {
  const q = s.field.value,
    asked = ++s.asked;
  if (!termsOf(q).length) return told(s, []);
  let read;
  try {
    read = await (s.dev ? mockFind(q) : act(`/api/book/search?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (asked === s.asked) told(s, [], `The book can’t be searched just now: ${e.message}`);
    return;
  }
  if (asked === s.asked) told(s, read.found, '', read.total);
}
// (total: how many finds the book holds, found the newest of them)
function told(s, found = [], trouble = '', total = found.length) {
  const q = s.field.value.trim(),
    terms = termsOf(q);
  s.found = found;
  s.say.textContent =
    trouble ||
    (!terms.length
      ? 'Handwriting, words said while drawing, typed notes and answers'
      : !found.length
        ? `Nothing in the book says “${q}”`
        : total > found.length
          ? `The newest ${found.length} of ${total}: another word narrows them`
          : '');
  s.list.innerHTML = found.map((f, i) => findHtml(f, i, terms)).join('');
}
function findHtml(f, i, terms) {
  const answer = f.how === 'answer',
    words = `${answer ? '' : '“'}${marked(f.text, terms, esc)}${answer ? '' : '”'}`;
  return `<li><button data-i="${i}"${answer ? ' data-answer' : ''}><b class="bk-find-n">${f.n}</b><span class="bk-find-words">${words}</span>
    <small>${esc([how(f), whose(f), when(f.day)].join(' · '))}</small></button></li>`;
}
const name = id => world.agents?.get(id)?.data.name ?? titleCase(id ?? '');
const how = f =>
  f.how === 'answer'
    ? `${name(f.by)}’s answer`
    : ({ spoken: 'Said', written: 'Written', typed: 'Typed' }[f.how] ?? 'Written');
const whose = f => (f.kind === 'call' ? 'On a call' : `For ${name(f.owner ?? world.company?.ceo)}`);
const when = day => (day === dayOf(1) ? 'Yesterday' : dayName(day, dayOf()));

// (dev mode: the mock book's notes and answers, found as the store finds them)
async function mockFind(q) {
  const { days } = await loadDay(true),
    pages = new Map();
  for (const { day } of days) for (const p of (await loadDay(true, day)).pages) pages.set(p.id, p);
  const { open, sent } = await loadSheets(true),
    entries = [];
  for (const sheet of [...open, ...sent])
    for (const n of sheet.notes) {
      const p = pages.get(n.page);
      if (!p) continue;
      const at = { note: n.id, n: n.n, page: p.id, day: p.day, kind: p.kind, owner: sheet.owner };
      if (n.words) entries.push({ ...at, how: n.said ?? 'typed', by: n.by, text: n.words, at: n.created ?? '' });
      for (const l of n.slips ?? [])
        entries.push({ ...at, how: 'answer', by: l.by, text: l.text, at: l.created ?? '' });
    }
  return { q, ...findIn(entries, q) };
}
