// A guest's own small shelf: with more than one book (and none named in the address), each of their books as a cover
// tile with its name and how their page stands, a tap opening it (?notebook=).
import { esc } from '../../util.js';

// notebooks: the guest's list (GET /guest/notebooks/api/list). status: the page's status line, the shelf put after it.
// text: the guest's words (notebookwords.js).
export function showGuestShelf(notebooks, status, text) {
  const shelf = document.createElement('nav');
  shelf.className = 'bk-guest-shelf';
  shelf.setAttribute('aria-label', text.notebooks);
  shelf.innerHTML = notebooks
    .map(
      n => `<a class="bk-guest-book" href="?notebook=${encodeURIComponent(n.id)}">
      <span class="bk-guest-book-name">${esc(n.name)}</span>
      <span class="bk-guest-book-state">${esc(stateOf(n, text))}</span></a>`,
    )
    .join('');
  status.after(shelf);
}
// How the guest's page stands in a book: in a round, open, marked done or the round closed; else how many pages
function stateOf(n, text) {
  if (n.kind !== 'round') return text.pageCount(n.pages?.length ?? 0);
  if (n.state === 'closed') return text.roundClosed;
  const page = n.pages?.[0];
  return page?.canUndo || page?.sent || page?.sending ? text.markedDone : text.pageOpen;
}
