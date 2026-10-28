// A scrap just saved, shown in the book (the pin flow): its page turned to (read into the book first when it's new),
// read till it holds the scrap, and the paper slid to show it whole, its words under it too, clear of the islands over
// the paper's right edge: a phone's book reads a page's scraps as a list, and a stroke on a scrap must start on it, not
// on the tools.
import { slideTo } from './bookview.js';
import { stackLeft } from './bookui.js';
import { readAgain } from './booksave.js';

// room left of a scrap shown when the paper must pan to it (page px), and on screen between it and the islands (px)
const ROOM = 24,
  RAIL_GAP = 12;

let book = null; // (bookpages.js's, once the groups are mounted: bookgroups.js)
export const mountShow = b => (book = b);

// The page a group is on, as the book has it read (null: not open in the book, or not read yet)
export const pageOf = id => book?.views.find(v => v.page.id === id && v.page.groups)?.page ?? null;

// pages: bookpages.js's answer; { page, id }: the scrap's page and its group
export async function showGroup(pages, { page, id }) {
  if (pages.page()?.id !== page) await pages.made(page);
  const v = book.views[book.cur];
  if (v?.page.id !== page) return;
  await v.reading;
  if (!v.page.groups?.has(id)) await readAgain(book, v.page);
  const r = reach(v, id);
  if (r && book.views[book.cur] === v) slideTo(book, inSight(r), () => book.remember());
}
// A group's box with its words and answers under it (bookgroups.js draws them there), in the page's px
function reach(v, id) {
  const box = v.page.groups.get(id)?.box,
    under = v.el.querySelector(`:scope > .bk-groups > .bk-under[data-g="${id}"]`);
  if (!box || !under) return box ?? null;
  return {
    x: box.x,
    y: box.y,
    w: Math.max(box.w, under.offsetLeft + under.offsetWidth - box.x),
    h: under.offsetTop + under.offsetHeight - box.y,
  };
}
// Where the paper shows a group: zoomed out (never in) till its column fits the paper left of the islands, and panned
// only as far as it must to show it there, its top a quarter down
function inSight(r) {
  const column = r.x + r.w + Math.max(0, r.x),
    clear = clearWidth(),
    s = Math.min(book.scale, clear / Math.max(column, 1)),
    seen = { w: clear / s, h: book.size.h / s },
    { x, y } = book.pan;
  const across = r.x >= x && r.x + r.w <= x + seen.w ? x : Math.min(r.x - ROOM, column - seen.w),
    down = r.y >= y && r.y + Math.min(r.h, seen.h) <= y + seen.h ? y : r.y - seen.h / 4;
  return { pan: { x: across, y: down }, scale: s };
}
// The paper's width left of the islands floating over its right edge (bookui.js), with a little room: its share of the
// paper on screen, so a book still swinging open measures the same
function clearWidth() {
  const left = stackLeft();
  if (left === null) return book.size.w;
  const desk = book.desk.getBoundingClientRect();
  return book.size.w * Math.min(1, (left - desk.left) / desk.width) - RAIL_GAP;
}
