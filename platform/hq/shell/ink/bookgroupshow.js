// A scrap just saved, shown in the book (the pin flow): its page turned to (read into the book first when it's new, its
// notebook opened at it when the book shows another), read till it holds the scrap, and the paper slid to show it
// whole, its words under it too, clear of the islands over the paper's edges: a phone's book reads a page's scraps as a
// list, and a stroke on a scrap must start on it, not on the tools.
import { slideTo } from './bookview.js';
import { readAgain } from './booksave.js';
import { loadGroups } from './notebookdata.js';
import { store } from '../../util.js';

// room left of a scrap shown when the paper must pan to it (screen px: as much zoomed out to show a note with what
// hangs beside it, clear of the book's lip.)
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
// A group on a page shown slid into sight, then() once it's there, or stopped() once a hand stops the slide on the way:
// false when it isn't drawn on it (also bookforyou.js's, and bookarrive.js's: what arrives from the store.)
export function bringIntoSight(v, id, then = () => {}, stopped = () => {}) {
  const r = reachOf(v, id);
  if (!r) return false;
  slideTo(
    book,
    inSight(r),
    () => {
      book.remember();
      then();
    },
    stopped,
  );
  return true;
}
// A scrap's page turned to: read into the book first when it's new; its own notebook (the store's: a scrap can go to
// one other than My journal, notebookscraps.ts) opened at it when the book shows another
async function turnTo(pages, page) {
  if (book.views.some(v => v.page.id === page)) return pages.made(page);
  const { notebook } = await loadGroups(pages.dev, page);
  return notebook === book.notebook ? pages.made(page) : pages.find({ page, notebook });
}
// A unit's place with what hangs under it (bookunits.js places both, beside it on a sketch page: sketchcanvas.js), the
// box round both, in the page's px. bookforyou.js reads it too.
export function reachOf(v, id) {
  const p = v.page.places?.find(q => q.id === id),
    under = v.el.querySelector(`:scope > .bk-groups > .bk-under[data-g="${id}"]`);
  if (!p) return null;
  if (!under) return { x: p.x, y: p.y, w: p.w, h: p.h };
  const x = Math.min(p.x, under.offsetLeft),
    y = Math.min(p.y, under.offsetTop);
  return {
    x,
    y,
    w: Math.max(p.x + p.w, under.offsetLeft + under.offsetWidth) - x,
    h: Math.max(p.y + p.h, under.offsetTop + under.offsetHeight) - y,
  };
}
// Where the paper shows a group: zoomed out (never in) till it fits the paper with a little room,
// and panned only as far as it must to show it there with that room, its top a quarter down (less, if its foot would be
// hidden)
function inSight(r) {
  const paper = book.size,
    s = Math.min(book.scale, (paper.w - 2 * ROOM) / r.w, (paper.h - 2 * ROOM) / r.h),
    room = ROOM / s,
    seen = { x0: book.pan.x, x1: book.pan.x + paper.w / s, h: paper.h / s },
    { y } = book.pan;
  const across = r.x - room >= seen.x0 && r.x + r.w + room <= seen.x1 ? book.pan.x : r.x - room,
    down = r.y - room >= y && r.y + r.h + room <= y + seen.h ? y : r.y - Math.min(seen.h / 4, seen.h - r.h - room);
  return { pan: { x: across, y: down }, scale: s };
}
