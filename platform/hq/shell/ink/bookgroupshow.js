// A scrap just saved, shown in the book (the pin flow): its page turned to (read into the book first when it's new, its
// notebook opened at it when the book shows another), read till it holds the scrap, and the paper slid to show it
// whole, its words under it too, clear of the islands over the paper's edges: a phone's book reads a page's scraps as a
// list, and a stroke on a scrap must start on it, not on the tools. A zoom out it took to fit is the board's again at
// its next touch.
import { contentOf, halt, panTo, placeOf, setView, slideTo, viewOf } from './bookview.js';
import { zoomAt } from './bookrow.js';
import { readAgain } from './booksave.js';
import { island } from './bookui.js';
import { loadGroups } from './notebookdata.js';
import { boxRound } from './notebookstack.js';
import { store } from '../../util.js';
import { LISTS } from './bookunits.js';
import { boxOf } from './bookunitbox.js';
import { GAP } from './masonry.js';

// room left of a scrap shown when the paper must pan to it (screen px: as much zoomed out to show a note with what
// hangs beside it, clear of the book's lip.)
const ROOM = 24;

let book = null; // (bookpages.js's, once the groups are mounted: bookgroups.js)
// The zoom the board was at when a slide here zoomed out to show a group, given back as its hands come to the paper
// again: { view, scale: the board's, slid: the zoom the slide left }. Gone once the board zooms or turns the page
// itself.
let lent = null;
// (whether the zoom on v is still the one a slide lent: none slid yet, or none moved it since)
const lentOn = v => lent?.view === v && (lent.slid ?? book.scale) === book.scale;
// The newest group this screen has shown, by id: one newer the book shows as it opens (booknewest.js)
const SHOWN = 'book.shownGroup';
export const lastShown = () => store.get(SHOWN, 0);
export function mountShow(b) {
  book = b;
  for (const type of ['pointerdown', 'wheel'])
    book.desk.addEventListener(type, handsBack, { capture: true, passive: true });
}

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
  const boardScale = lentOn(v) ? lent.scale : book.scale,
    to = inSight(r, boardScale);
  lent = to.scale < boardScale ? { view: v, scale: boardScale } : null;
  // (the zoom this slide left noted on its own loan, where it ends or a hand stops it)
  const loan = lent,
    there = () => {
      if (loan) loan.slid = book.scale;
    };
  slideTo(
    book,
    to,
    () => {
      there();
      book.remember();
      then();
    },
    () => {
      there();
      stopped();
    },
  );
  return true;
}
// The board's hands on the paper again (a press, or a wheel's turn): the zoom a slide lent given back at once, about
// the point it touches, so what's under its pen or finger stays there, and before the press is anything else's: a
// stroke draws at the board's own zoom. A native shell gives it back as its Pencil touches the paper. The stroke it
// drew plays here (untrusted) at the zoom it was drawn at (booknative.js).
const handsBack = e => e.isTrusted && giveBack(e.clientX, e.clientY);
// The zoom the board's next touch on the paper leaves it at: its own, a zoom a slide lent given back then (booknative.js:
// the shell's Pencil draws at it from its first point)
export const boardScale = () => (lentOn(viewOf(book)) ? lent.scale : book.scale);
// The zoom a slide lent given back about a point on the screen (CSS px)
export function giveBack(x, y) {
  if (!lent) return;
  // (a slide on its way stopped where it is, as the hand stops it: its stopped() notes the zoom it left, read next)
  halt(book);
  const was = lent,
    still = lentOn(viewOf(book));
  lent = null;
  if (!still) return;
  const r = book.desk.getBoundingClientRect(),
    at = { x: x - r.left, y: y - r.top };
  setView(book, { pan: zoomAt(book.pan, book.scale, was.scale, at), scale: was.scale });
  book.remember();
}
// A scrap's page turned to: read into the book first when it's new; its own notebook (the store's: a scrap can go to
// one other than My journal, notebookscraps.ts) opened at it when the book shows another
async function turnTo(pages, page) {
  if (book.views.some(v => v.page.id === page)) return pages.made(page);
  const { notebook } = await loadGroups(pages.dev, page);
  return notebook === book.notebook ? pages.made(page) : pages.find({ page, notebook });
}
// A unit's place and what hangs under it (bookunits.js places both), each its box in the page's px, the unit's first
// (bookforyou.js rings each).
export function boxesOf(v, id) {
  const p = v.page.places?.find(q => q.id === id),
    under = v.el.querySelector(`:scope > .bk-groups > .bk-under[data-g="${id}"]`);
  if (!p) return [];
  const unit = { x: p.x, y: p.y, w: p.w, h: p.h };
  if (!under?.offsetHeight) return [unit];
  return [unit, { x: under.offsetLeft, y: under.offsetTop, w: under.offsetWidth, h: under.offsetHeight }];
}
// The box round a unit and what hangs under it, in the page's px (null: not on the page). bookforyou.js reads it too.
export function reachOf(v, id) {
  const boxes = boxesOf(v, id);
  return boxes.length ? boxRound(boxes) : null;
}
// Where the paper shows a group: zoomed out (never in past boardScale, the zoom the board chose) till it fits the paper
// the board sees with a little room, and panned only as far as it must to show it there with that room, its top a
// quarter down (less, if its foot would be hidden)
function inSight(r, boardScale) {
  const paper = seenPaper(),
    s = Math.min(boardScale, (paper.w - 2 * ROOM) / r.w, (paper.h - 2 * ROOM) / r.h),
    room = ROOM / s,
    { x, y } = placeOf(book),
    seen = { x0: x, x1: x + paper.w / s, h: paper.h / s };
  const across = r.x - room >= seen.x0 && r.x + r.w + room <= seen.x1 ? x : r.x - room,
    down = r.y - room >= y && r.y + r.h + room <= y + seen.h ? y : r.y - Math.min(seen.h / 4, seen.h - r.h - room);
  return { pan: panTo(book, { x: across, y: down }, s), scale: s };
}
// The paper the board sees (screen px): its content's part (bookview.js contentOf), ending left of the tools' island
// where it floats upright over the paper's right (bookstrip.css; while it's hidden, the whole content's, and while its
// stylesheet is still on its way as the book opens on a newer scrap too: unstyled, it lies flat across the whole paper.
function seenPaper() {
  const paper = contentOf(book),
    tools = island('tools').closest('.bk-strip').getBoundingClientRect();
  if (!tools.width || !tools.height) return paper;
  return { w: Math.min(paper.w, tools.left - book.desk.getBoundingClientRect().left), h: paper.h };
}
