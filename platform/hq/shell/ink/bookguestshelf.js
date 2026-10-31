// A guest's shelf and a book's first page (Ink 1.1, the deck's Guests chapter). The shelf holds books only: one per
// project they have something in, and their own journal. A book's first page links the work shared with them from that
// project, each opening beside the book (bookguestwork.js). At every step the next one is lit: the book, then the work,
// with asks for them, else the first. Its look: bookguest.css.
import { esc } from '../../util.js';

// Line drawings, ink only, in currentColor: shared work (a page in a window) and a journal (lines and a pencil)
const WORK = `<svg viewBox="0 0 120 120" aria-hidden="true"><rect x="16" y="22" width="88" height="76" rx="4"/>
  <path d="M16 36h88M25 29h.01M32 29h.01M39 29h.01M28 50h40M28 60h64M28 70h52M28 84h22"/></svg>`;
const JOURNAL = `<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M14 24h92M14 44h92M14 64h92M14 84h92"/>
  <path d="M20 34c6-8 10-8 14 0s8 8 14 0 8-8 14 0"/><path d="M86 70l14-16 6 5-14 16-8 3z"/></svg>`;
const ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>';

// The lit one of a list: the first with asks for them, else the first
const litOf = list => list.find(x => x.asks > 0) ?? list[0];

// shelf: GET /guest/notebooks/api/shelf. main: the page's main, drawn over. text: the guest's words (notebookwords.js).
export function showShelf(shelf, main, text) {
  const lit = litOf(shelf.books);
  main.className = 'bk-guest-wide';
  main.innerHTML = `${headHtml(shelf.name)}<nav class="bk-guest-shelf" aria-label="${esc(text.shelf)}">
    ${shelf.books.map(b => coverHtml(b, b === lit, text)).join('')}
    <a class="bk-guest-book" href="?notebook=${+shelf.journal.notebook}" data-journal>
      <span class="bk-guest-cover">${JOURNAL}</span>
      <span class="bk-guest-book-name">${esc(text.journal)}</span>
      <span class="bk-guest-book-state">${shelf.journal.asks ? esc(text.asksForYou(shelf.journal.asks)) : esc(text.yoursAlone)}</span>
      ${countHtml(shelf.journal.asks)}</a></nav>
    <p class="bk-guest-foot">${esc(text.shelfFoot)}</p>`;
}
const coverHtml = (
  b,
  lit,
  text,
) => `<a class="bk-guest-book"${lit ? ' data-lit' : ''} href="?book=${encodeURIComponent(b.key)}">
  <span class="bk-guest-cover">${WORK}</span>
  <span class="bk-guest-book-name">${esc(b.name)}</span>
  <span class="bk-guest-book-state">${esc(b.asks ? text.asksForYou(b.asks) : text.allRead)}</span>
  ${countHtml(b.asks)}</a>`;
const countHtml = n => (n ? `<b class="bk-guest-count" aria-hidden="true">${+n}</b>` : '');
// Their name as the deck draws it: a ring with their initial, the name in hand, the one address on the right
const headHtml = name =>
  `<header class="bk-guest-head"><span class="bk-guest-me" aria-hidden="true">${esc(
    [...String(name)][0] ?? '',
  )}</span><h1>${esc(name)}</h1><span class="bk-guest-where">${esc(location.host)}/guest</span></header>`;

// A project's book at its first page: its work shared with them, each a card with its asks and Open
export function showBook(shelf, key, main, text) {
  const book = shelf.books.find(b => b.key === key);
  if (!book) return showShelf(shelf, main, text);
  const lit = litOf(book.artifacts);
  main.className = 'bk-guest-wide';
  main.innerHTML = `<p class="bk-guest-back"><a href="./">‹ ${esc(text.shelf)}</a></p>
    <article class="bk-guest-page"><h1>${esc(book.name)}</h1><h2>${esc(text.sharedWithYou)}</h2>
    <ul class="bk-guest-works">${book.artifacts.map(a => workHtml(a, a === lit, text)).join('')}</ul></article>`;
}
function workHtml(a, lit, text) {
  const state = a.asks
    ? `<p class="bk-guest-asks"><i aria-hidden="true"></i>${esc(text.asksForYou(a.asks))}</p>`
    : `<p class="bk-guest-state">${esc(a.ends ? text.until(day(a.ends)) : text.writeOnIt)}</p>`;
  return `<li class="bk-guest-work"${lit ? ' data-lit' : ''}><span class="bk-guest-shot">${WORK}</span>
    <h3>${esc(a.name)}</h3><p class="bk-guest-at">${esc(a.where)}</p>${state}
    <a class="bk-guest-open" href="?notebook=${+a.notebook}">${esc(text.open)} ${ARROW}</a></li>`;
}
const day = iso =>
  new Date(iso).toLocaleDateString(document.documentElement.lang, { weekday: 'short', day: 'numeric', month: 'short' });
