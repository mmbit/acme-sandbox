// A scrap just saved, shown in the book (the pin flow): its page turned to (read into the book first when it's new, its
// notebook opened at it when the book shows another), read till it holds the scrap, and the paper slid to show it
// whole, its words under it too, clear of the islands over the paper's edges: a phone's book reads a page's scraps as a
// list, and a stroke on a scrap must start on it, not on the tools.
import { slideTo } from './bookview.js';
import { readAgain } from './booksave.js';
import { loadGroups } from './notebookdata.js';
import { store } from '../../util.js';

// room left of a scrap shown when the paper must pan to it (page px)
const ROOM = 24;

let book = null; // (bookpages.js's, once the groups are mounted: bookgroups.js)
// The newest group this screen has shown, by id: one newer the book shows as it opens (booknewest.js)
const SHOWN = 'book.shownGroup';
export const lastShown = () => store.get(SHOWN, 0);
export const mountShow = b => (book = b);

// The page a group is on, as the book has it read (null: not open in the book, or not read yet)
export const pageOf = id => book?.views.find(v => v.page.id === id && v.page.groups)?.page ?? null;

// pages: bookpages.js's answer; { page, id }: the scrap's page and its group
export async function showGroup(pages, { page, id }) {
  if (pages.page()?.id !== page) await turnTo(pages, page);
  const v = book.views[book.cur];
  if (v?.page.id !== page) return;
  await v.reading;
  if (!v.page.groups?.has(id)) await readAgain(book, v.page);
  if (book.views[book.cur] !== v || !bringIntoSight(v, id)) return;
  if (id > lastShown()) store.set(SHOWN, id);
}
// A group on a page shown slid into sight, then() once it's there: false when it isn't drawn on it (also bookforyou.js's.
export function bringIntoSight(v, id, then = () => {}) {
  const r = reachOf(v, id);
  if (!r) return false;
  slideTo(book, inSight(r), () => {
    book.remember();
    then();
  });
  return true;
}
// A scrap's page turned to: read into the book first when it's new; its own notebook (the store's: a scrap can go to
// one other than My journal, notebookscraps.ts) opened at it when the book shows another
async function turnTo(pages, page) {
  if (book.views.some(v => v.page.id === page)) return pages.made(page);
  const { notebook } = await loadGroups(pages.dev, page);
  return notebook === book.notebook ? pages.made(page) : pages.find({ page, notebook });
}
// A unit's place with its answers under it (bookunits.js places both), in the page's px. (job #14672; also
// bookforyou.js's.)
export function reachOf(v, id) {
  const p = v.page.places?.find(q => q.id === id),
    under = v.el.querySelector(`:scope > .bk-groups > .bk-under[data-g="${id}"]`);
  if (!p) return null;
  return { x: p.x, y: p.y, w: p.w, h: under ? under.offsetTop + under.offsetHeight - p.y : p.h };
}
// Where the paper shows a group: zoomed out (never in) till it fits the paper with a little room,
// and panned only as far as it must to show it there, its top a quarter down (less, if its foot would be hidden)
function inSight(r) {
  const paper = book.size,
    s = Math.min(book.scale, paper.w / (r.w + 2 * ROOM), paper.h / (r.h + 2 * ROOM)),
    seen = { x0: book.pan.x, x1: book.pan.x + paper.w / s, h: paper.h / s },
    { y } = book.pan;
  const across = r.x >= seen.x0 && r.x + r.w <= seen.x1 ? book.pan.x : r.x - ROOM,
    down = r.y >= y && r.y + r.h <= y + seen.h ? y : r.y - Math.min(seen.h / 4, seen.h - r.h - ROOM);
  return { pan: { x: across, y: down }, scale: s };
}
