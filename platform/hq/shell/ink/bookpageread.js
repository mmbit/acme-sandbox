// A page of the book read from the store and laid: its groups read, drawn and given to the tools, and every page laid
// again at the paper's width, the one shown at the same zoom past its fit (from bookpages.js, at its size limit.
import { readPage, said } from './booksave.js';
import { fitOf, setView, viewOf } from './bookview.js';

// The page laid again (its size, as it has grown) and drawn where it is
export function lay(book) {
  // (its units laid as a masonry at the paper's width, bookunits.js; the tools' layer drawn again where units moved;
  // the page shown as far zoomed past its fit as before.)
  const page = viewOf(book)?.page,
    z = book.scale / fitOf(page);
  for (const v of book.views) if (v.place(book.size.w)) book.tools?.added?.(v);
  setView(book, { scale: z * fitOf(page) });
}
// A page's groups read, drawn and given to the tools
export function read(book, v) {
  return (v.reading ??= readPage(book, v.page).then(
    () => {
      lay(book);
      v.redraw();
      book.groups.drawn(v.page);
      book.tools?.added?.(v);
    },
    e => {
      v.reading = null;
      said(book, v.page, e.message);
    },
  ));
}
