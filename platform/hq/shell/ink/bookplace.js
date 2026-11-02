// Where the board left the book (bookpages.js): one place for the device, whichever way it's held or however wide its
// window, so the board picks up where it left off; and the page shown, in brief.
import { store } from '../../util.js';
import { scope } from './bookscope.js';
import { viewOf } from './bookview.js';

const placeKey = () => `book.place${scope ? `.guest.${scope.notebook}` : ''}`;
// The place remembered on this device, or null
export const remembered = () => store.get(placeKey(), null);
// The view's place at rest, for this device
export function remember(book) {
  const v = viewOf(book);
  if (!v) return;
  const { pan, scale } = book;
  store.set(placeKey(), {
    notebook: book.notebook,
    page: v.page.id,
    x: Math.round(pan.x),
    y: Math.round(pan.y),
    s: Math.round(scale * 1000) / 1000,
  });
  document.dispatchEvent(new CustomEvent('book:turn', { detail: { page: v.page.id } }));
}
export function shownPage(book) {
  const page = viewOf(book)?.page;
  if (!page?.id) return null;
  const { id, notebook, day, kind, label, w, h, chapter } = page;
  return { id, notebook, day, kind, label, w, h, chapter };
}
