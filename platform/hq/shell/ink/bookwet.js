// The book's wet canvases, where a line or a shape shows as it's drawn (ink.js's pen, bookshapes.js): laid in the
// page it's drawn on, just over that page's dry ink (bookpage.js), so the live line lies where it will once dry, under
// the page's words and its notes' parts; over it, for a see-through line (the marker's), the ink that will lie over
// it, taken off the page's own canvases meanwhile. Both cover the paper exactly, so whatever draws on them draws in the
// paper's px. (the Ink README, The book's frame)
import { fit } from '/__review/ink.js';
import { shown } from './bookview.js';

// a book's wet canvases (.bk-wet: the line's, then over), held from the start: laid in a page, they go with it when
// it's let go, till the next line lays them in another
const canvases = new WeakMap();

// The pen's own (ink.js pen's use and cleared), as the book opens: a line about to be drawn (drawable(e)) laid in its
// page, and the page's ink back on its own canvases once the line is wiped
export function wetHooks(book, drawable) {
  canvases.set(book, [...book.paper.querySelectorAll('.bk-wet')]);
  return {
    use: e => drawable(e) && (layWet(book, book.views[book.target], book.inking), true),
    cleared: () => dryWet(book),
  };
}

// The wet canvases laid in view for a line or a shape about to be drawn in ink
// ({ alpha }), over drawn for a see-through one
export function layWet(book, view, ink) {
  const [wet, over] = canvases.get(book),
    box = shown(book),
    // (a unit's new canvas goes in under the others: bookpage.js paint)
    dry = [...view.el.querySelectorAll(':scope > canvas.bk-ink')].at(-1);
  if (wet.parentElement !== view.el) {
    if (dry) dry.after(wet, over);
    else view.el.prepend(wet, over);
  }
  const place = {
    inset: 'auto',
    left: `${box.x0}px`,
    top: `${box.y0}px`,
    width: `${box.x1 - box.x0}px`,
    height: `${box.y1 - box.y0}px`,
  };
  for (const c of [wet, over]) Object.assign(c.style, place);
  if (!(ink.alpha < 1)) return;
  const g = fit(over),
    { pan, scale: s } = book;
  g.transform(s, 0, 0, s, -pan.x * s, -pan.y * s);
  view.under(true);
  view.over(g, box);
  book.inkOver = view; // (the page whose ink is on over)
}
// Both cleared, and the page's ink back on its own canvases: a line's as ink.js clears it, a shape's once it has landed
export function dryWet(book) {
  canvases.get(book).forEach(fit);
  book.inkOver?.under(false);
  book.inkOver = null;
}
