// The page's title on the view (README, The book's frame: the title on the view): fixed at the top left of the paper's
// content, below the status bar's blur, never zoomed or panned with the page, and the day of what's showing under it.
// It takes no press: the page under it is drawn on as anywhere, and the title is renamed from the dots menu's Rename
// page (bookcontrols.js, booktitle.js). A page turn's picture carries it with the page it shows (bookflip.js).
import { dayWords, nameOf } from './bookhead.js';
import { viewOf } from './bookview.js';

// book (bookpages.js). Returns { el, update() }: el, the head, where the rename's field is written (booktitle.js);
// update() shows the shown page's title and the day at the view's top, as the view moves or the page changes.
export function mountHead(book) {
  const el = document.createElement('div'),
    title = document.createElement('h2'),
    day = document.createElement('p');
  el.className = 'bk-view-head';
  title.className = 'bk-page-title';
  title.append(document.createElement('span'));
  day.className = 'bk-view-day';
  // (no day until a page with one shows: a call's page has none)
  day.hidden = true;
  // (what the board reads: a minimised call covers as little of it as it can, by their own boxes.)
  for (const words of [title, day]) words.setAttribute('data-keep-in-sight', '');
  el.append(title, day);
  book.desk.append(el);
  const shown = { title: null, day: null, h: 0 };
  return {
    el,
    update() {
      const view = viewOf(book),
        page = view?.page,
        far = book.far();
      el.hidden = !page || far;
      if (el.hidden) return;
      // (what's showing starts below the head: what's under it is out of sight)
      const words = nameOf(page),
        top = dayShown(book, page, Math.max(book.size.top, shown.h)),
        on = top.day;
      if (words !== shown.title) title.firstChild.textContent = shown.title = words;
      if (on !== shown.day) {
        shown.day = on;
        day.textContent = on ? dayWords(on) : '';
        day.hidden = !on;
      }
      // (its height read again only as its words change, never as the page moves under it)
      if (`${words} ${on}` !== shown.measured || !shown.h)
        Object.assign(shown, { measured: `${words} ${on}`, h: el.offsetHeight });
      // (scrolled from the page's corner, with something of the page under it: its band frosted, bookdesk.css; at rest
      // what lies under the title shows as it is, drawn on and seen)
      const scrolled = book.pan.y + book.size.top / book.scale > 1 || book.pan.x > 1;
      el.toggleAttribute('data-over', scrolled && under(book, page, shown.h));
      handedOver(book, view, shown.h, top);
    },
  };
}

// Whether anything on the page lies under the head (h: its height on the screen, from its top): a unit (a scrap, the
// board's own drawing), what hangs under one (its answers, an agent's card: the place's hung, bookunits.js) or a date
// between days
function under(book, page, h) {
  const s = book.scale,
    box = {
      x0: book.pan.x,
      x1: book.pan.x + (book.size.w - book.size.right) / s,
      y0: book.pan.y,
      y1: book.pan.y + h / s,
    },
    dates = (page.headers ?? []).map(d => ({ x: d.x ?? box.x0, w: d.w ?? box.x1 - box.x0, y: d.y, h: DATE_H }));
  const places = page.places ?? [],
    hung = places.flatMap(p => (p.hung?.h ? [p.hung] : []));
  return [...places, ...hung, ...dates].some(
    p => p.y < box.y1 && p.y + p.h > box.y0 && p.x < box.x1 && p.x + p.w > box.x0,
  );
}

// A date between days hands its day to the head, out of sight on the page (data-under), so no second date peeks under
// the head's own: once it's scrolled up to the head's foot (into its fade, bookdesk.css --bk-head-fade), or once it
// heads the units the head's day already names (top: dayShown's). The dates are drawn in page.headers' order
// (bookunitcards.js).
const FADE = 16,
  // (a date's words: 14 px down its line, 12 high: bookgroups.css .bk-day)
  DATE_TOP = 14,
  DATE_H = 26;
function handedOver(book, view, h, top) {
  const line = book.pan.y + (h + FADE) / book.scale,
    dates = view.el.querySelectorAll(':scope > .bk-units > .bk-day');
  (view.page.headers ?? []).forEach((d, i) =>
    dates[i]?.toggleAttribute('data-under', d.y + DATE_TOP < line || (d.day === top.day && d.y < top.y)),
  );
}

// The day of what's showing ({ day, y: where its unit starts on the page }): the topmost unit on screen below the head
// (foot: the head's height, the blur's at least; a scrap, the board's own drawing), else the page's first day; none on
// a call's page, whose title starts with its date and time, or on a page with nothing on it
function dayShown(book, page, foot) {
  if (page.kind === 'call') return { day: null, y: -Infinity };
  const days = new Map((page.laid?.units ?? []).map(u => [u.id, u.day])),
    s = book.scale,
    top = book.pan.y + foot / s,
    box = { x0: book.pan.x, x1: book.pan.x + book.size.w / s, y1: book.pan.y + book.size.h / s };
  let first = null;
  for (const p of page.places ?? []) {
    if (!days.get(p.id) || p.y + p.h <= top || p.y >= box.y1 || p.x + p.w <= box.x0 || p.x >= box.x1) continue;
    if (!first || p.y < first.y || (p.y === first.y && p.x < first.x)) first = p;
  }
  return { day: (first && days.get(first.id)) ?? page.day ?? null, y: first?.y ?? -Infinity };
}
