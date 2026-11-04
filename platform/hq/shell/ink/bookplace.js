// Where the board left the book (bookpages.js): one place for the device, whichever way it's held or however wide its
// window, so the board picks up where it left off; and the page shown, in brief.
import { store } from '../../util.js';
import { scope } from './bookscope.js';
import { fitOf, placeOf, viewOf } from './bookview.js';

const placeKey = () => `book.place${scope ? `.guest.${scope.notebook}` : ''}`;
// The place remembered on this device, or null
export const remembered = () => store.get(placeKey(), null);
// The view's place at rest, for this device (bookview.js placeOf: the page's point at its content's top-left): z, how far it's zoomed past its page's fit (bookview.js), kept as the page
// is laid at another width
export function remember(book) {
  const v = viewOf(book);
  if (!v) return;
  const at = placeOf(book);
  store.set(placeKey(), {
    notebook: book.notebook,
    page: v.page.id,
    x: Math.round(at.x),
    y: Math.round(at.y),
    z: Math.round((book.scale / fitOf(v.page)) * 1000) / 1000,
  });
  document.dispatchEvent(new CustomEvent('book:turn', { detail: { page: v.page.id } }));
}
export function shownPage(book) {
  const page = viewOf(book)?.page;
  if (!page?.id) return null;
  const { id, notebook, day, kind, label, w, h, chapter } = page;
  return { id, notebook, day, kind, label, w, h, chapter };
}
