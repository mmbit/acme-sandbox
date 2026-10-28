// The book's Search, in the overview's head (bookui.js's overview island, bookzoom.js): one line to write on, with the
// Pencil (Apple's Scribble turns handwriting in a field into type, nothing of ours) or a keyboard. What the book holds
// is found as it's written: handwriting read into type, words said while drawing, a scrap's typed words and the
// agents' answers under them, listed under the line. A find tapped opens its page in the book (bookpages.js find). The
// store's route is booksearch.ts (played in dev mode by notebookplay.js), the matching booksearchwords.js. It finds in
// every notebook of the board's own, so on the Shelf its line says so.
import { esc, titleCase } from '../../util.js';
import * as world from '../../world/world.js';
import { ask as fromStore } from './notebookdata.js';
import { dayName } from './bookhead.js';
import { marked, termsOf } from './booksearchwords.js';

// a pause in the writing this long asks the store (Scribble's words land a word at a time)
const ASK_MS = 150;

const LENS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const HTML = `<div class="bk-find" role="search">
  <label class="bk-find-line">${LENS}<input type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off"
    spellcheck="false" placeholder="Search the book" aria-label="Search the book"></label>
  <div class="bk-find-list" hidden><p class="bk-find-say" role="status"></p><ol class="bk-found"></ol></div></div>`;

// host: where its line goes (the overview's head). dev: on mock data. find({ day, page, note }): the book opens the
// page at the note (bookpages.js).
export function mountSearch(host, { dev, find }) {
  host.insertAdjacentHTML('afterbegin', HTML);
  const card = host.querySelector('.bk-find'),
    s = {
      dev,
      card,
      field: card.querySelector('input'),
      box: card.querySelector('.bk-find-list'),
      say: card.querySelector('.bk-find-say'),
      list: card.querySelector('.bk-found'),
      asked: 0,
      timer: 0,
      found: [],
    };
  document.addEventListener('book:far', e => named(s, e.detail.level));
  s.field.addEventListener('input', () => {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => ask(s), ASK_MS);
  });
  card.addEventListener('keydown', e => {
    if (e.key === 'Escape' && s.field.value) {
      e.stopPropagation();
      clearTimeout(s.timer);
      s.asked++;
      s.field.value = '';
      told(s);
    }
    if (e.key === 'Enter' && e.target === s.field) s.list.querySelector('button')?.click();
  });
  s.list.addEventListener('click', e => {
    const f = s.found[Number(e.target.closest('[data-i]')?.dataset.i)];
    if (!f) return;
    s.field.blur();
    find({ day: f.day, page: f.page, note: f.note });
  });
  told(s);
}

// The line's words for where the overview is: the Shelf, or inside a book
function named(s, level) {
  const words = level === 'shelf' ? 'Search your notebooks' : 'Search the book';
  s.field.placeholder = words;
  s.field.setAttribute('aria-label', words);
}

// The store asked for the words in the field now; only the latest question's finds are shown
async function ask(s) {
  const q = s.field.value,
    asked = ++s.asked;
  if (!termsOf(q).length) return told(s, []);
  let read;
  try {
    // (dev mode: the played Notebook's.)
    read = await fromStore(s.dev, '/api/book/search', { q });
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
  // (the finds' list under the line only once there's a word on it)
  s.box.hidden = !terms.length && !trouble;
  s.say.textContent =
    trouble ||
    (!found.length
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

// A day as the store names it, YYYY-MM-DD, `ago` days before today here
function dayOf(ago = 0, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
