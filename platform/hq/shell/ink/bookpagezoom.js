// The zoom a page opens at (bookpages.js): the one the board left it at on a screen of this shape (booklayout.js
// shapeOf), 100% on a page it never zoomed. Kept on the page in the store (notebook.ts zoomPage) as the view comes to
// rest after the board zoomed it (never the book's own zoom out to show a scrap: bookpages.js remember), so it opens
// at it again after a turn, a close or a reload, and on any screen of the shape. A guest's stays this visit's and this
// screen's. (the board's call 160)
import { zoomPage } from './notebookdata.js';

// The zoom kept on the page for this screen's shape, or undefined
export const keptZoom = (book, page) => (book.scope ? undefined : page.zooms?.[book.shape()]);

// Where a page opens: at a place on it ({ x, y, s }), or as it was left this visit, or at its top-left at its zoom
export const camOf = (book, page, place) =>
  place
    ? { pan: { x: place.x ?? 0, y: place.y ?? 0 }, scale: place.s ?? 1 }
    : (book.cams.get(page) ?? { pan: { x: 0, y: 0 }, scale: keptZoom(book, page) ?? 1 });

// The board's zoom at rest: kept on the page when it's changed
export function keepZoom(book, page) {
  const zoom = Math.round(book.scale * 1000) / 1000,
    shape = book.shape();
  if (book.scope || !page.id || zoom === (keptZoom(book, page) ?? 1)) return;
  page.zooms = { ...page.zooms, [shape]: zoom };
  zoomPage(book.dev, page.id, shape, zoom).catch(e => console.error('[hq] The page’s zoom can’t be kept:', e));
}
