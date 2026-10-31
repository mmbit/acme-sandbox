// A piece of work shared with a guest, open with their book beside it (Ink 1.1, the deck's Guests chapter): a slim bar
// back to the work's book and its address, and the work itself in a frame, its session handed on by the guest desk
// (/guest/onward). The book (book.js) takes its room on the right, open at their page on this work, where the notes
// they pin land and the asks for them wait in red. On a phone the book covers it, its handle folding it away.
// Its look: bookguest.css.
import { esc } from '../../util.js';

// work: one of a book's artifacts (GET /guest/notebooks/api/shelf), with book: its project's book
export function showWork(work, text) {
  const view = document.createElement('section');
  view.className = 'bk-guest-view';
  view.setAttribute('aria-label', work.name);
  view.innerHTML = `<div class="bk-guest-bar"><a href="?book=${encodeURIComponent(work.book.key)}">‹ ${esc(work.book.name)}</a>
    <a class="bk-guest-address" href="${esc(work.open)}" target="_blank" rel="noopener">${esc(work.where)}</a></div>
    <iframe title="${esc(text.workTitle)}: ${esc(work.name)}" src="${esc(work.open)}"
      allow="autoplay; fullscreen; clipboard-write"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>`;
  document.body.classList.add('bk-guest-working');
  document.querySelector('main').before(view);
}
