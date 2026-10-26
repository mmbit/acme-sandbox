// The book beside HQ's page: its cloth spine, its paper and its rail, open beside the page, folded away past the
// screen's right edge with only its lip showing there (over the page, which keeps its whole width), or spread over the
// screen. HQ's page is <body>: it lays itself out in the room the book leaves (--book-room on <html>, style.css), so the
// open book never covers it. The book lives outside <body>, in #book. (the lip)
// The layout's maths is booklayout.js; the rail's faces bookrail.js; the pages bookpages.js; its look booklook.css.
import { store, stylesheet } from '../util.js';
import * as world from '../world/world.js';
import { RAIL, SPINE, layout, shapeOf, released, pulled, recall, keep, bookWidth, outOfSpread } from './booklayout.js';
import { mountRail } from './bookrail.js';
import { mountPages } from './bookpages.js';
import { PAPER } from '/__review/paper.js';
import { mountSearch } from './booksearch.js';

// How long the book takes to slide: a sketchbook pushed aside on a desk, quick and soft at the end
const SLIDE_MS = 260;
// A press that moves less than this is a tap
const TAP_PX = 8;
// A flick's speed is read over its last moves, this long
const FLICK_MS = 100;

let root, parts, pages;
let state, drawn; // state: what's asked for (mode, the book's width); drawn: the layout on screen now
let slide = null; // the slide under way: { from, to, start }

export async function initBook() {
  // (and the sheets' notes on its pages)
  await Promise.all([
    stylesheet('shell/book.css'),
    stylesheet('shell/booklook.css'),
    stylesheet('shell/booksheet.css'),
    stylesheet('shell/booksearch.css'), // (Search)
  ]);
  mountRoot();
  state = recall(store, shape());
  mountRail(parts.rail, parts.lip, {
    dev: world.dev,
    toggle,
    open: () => go({ ...state, mode: 'open' }),
    undo: () => pages.undo(),
  });
  pages = mountPages(parts.paper, { dev: world.dev, shape });
  // (Search, over the paper: a find opens its page at its note.)
  mountSearch(parts.leaf, { dev: world.dev, open: openBook, find: at => pages.find(at) });
  // (a page made or thrown away outside the book, a call's: calldraw.js, markpage.js, which send book:paged: today's read
  // again, at that page if it's new; the rail reads its sheets again too. Not book:changed, which an answer or a slip
  // sends and which must leave the page the board is on.)
  document.addEventListener('book:paged', e => {
    pages.made(e.detail?.page);
    document.dispatchEvent(new CustomEvent('book:changed'));
  });
  show(layout(innerWidth, innerHeight, state));
  dragSpine();
  dragLip();
  parts.lip.addEventListener('click', openBook);
  // A turn or a new window size: the shape's own remembered state, laid out at once (nothing slides). Watched on
  // <html>'s box, which follows the window whether or not a resize event comes with it.
  let size = `${innerWidth}x${innerHeight}`;
  new ResizeObserver(() => {
    if (`${innerWidth}x${innerHeight}` === size) return;
    size = `${innerWidth}x${innerHeight}`;
    slide = null;
    state = recall(store, shape());
    show(layout(innerWidth, innerHeight, state));
  }).observe(document.documentElement);
}

// The book's table, spine, leaf (its paper), rail and lip, on <html>
function mountRoot() {
  root = document.createElement('div');
  root.id = 'book';
  root.style.cssText = PAPER;
  root.innerHTML = `<div class="bk-table"></div><div class="bk-spine" role="separator" aria-orientation="vertical"
    aria-label="The book's spine: drag it right to put the book away, left to spread it"><i></i></div>
    <section class="bk-leaf" aria-label="The book"><div class="bk-paper"></div></section><nav class="bk-rail" aria-label="The book's rail"></nav>
    <button class="bk-lip" title="The book: tap or pull it in"><span class="sr">The book</span></button>`;
  document.documentElement.append(root);
  parts = Object.fromEntries(
    ['table', 'spine', 'leaf', 'paper', 'rail', 'lip'].map(k => [k, root.querySelector(`.bk-${k}`)]),
  );
}
// What the book shows now: { mode, shape, page, spine, book, rail }
export const bookLayout = () => drawn;
// Open the book (a face's tap, Search), fold it away, or the spread
export const openBook = () => go({ ...state, mode: 'open' });
export const foldBook = () => go({ ...state, mode: 'folded' });
// A page of the day shown turned to (a second screen's turn: pair.js.)
export const showBookPage = id => pages?.show(id);

const shape = () => shapeOf(innerWidth, innerHeight);
// The rail's arrow: open folds it, folded opens it, the spread goes back to open (folded where there's no room for a page)
const toggle = () =>
  go({
    ...state,
    mode:
      drawn.mode === 'open' ? 'folded' : drawn.mode === 'spread' ? outOfSpread(innerWidth, innerHeight, state) : 'open',
  });

// Slide to a state, and remember it for this shape
function go(next) {
  state = next;
  keep(store, shape(), state);
  const to = layout(innerWidth, innerHeight, state);
  if (to.mode === drawn.mode && to.book === drawn.book) return show(to);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return show(to);
  slide = { from: placeOf(drawn), to, start: performance.now() };
  requestAnimationFrame(step);
}
function step(t) {
  if (!slide) return;
  const k = Math.min(1, (t - slide.start) / SLIDE_MS),
    eased = 1 - (1 - k) ** 3,
    { from, to } = slide,
    target = placeOf(to);
  if (k >= 1) {
    slide = null;
    return show(to);
  }
  const between = Object.fromEntries(
    Object.keys(from).map(key => [key, from[key] + (target[key] - from[key]) * eased]),
  );
  place(between, to.mode);
  requestAnimationFrame(step);
}

// Where the parts sit: edge, the spine's left (x px); width, the paper's; room, what HQ's page gives up; rail, the
// rail's left. Folded, the book keeps its open width and lies past the screen's right edge, its rail beyond it; the
// spread starts at the screen's left edge with its spine (to drag it back), and HQ's page keeps its open width under it.
function placeOf(l) {
  const w = innerWidth,
    open = bookWidth(w, state.book);
  if (l.mode === 'folded') return { edge: w, width: open, room: 0, rail: w + SPINE + open };
  if (l.mode === 'spread') return { edge: 0, width: w - RAIL - SPINE, room: l.room, rail: w - RAIL };
  return { edge: l.page, width: l.book, room: l.room, rail: w - RAIL };
}
function place({ edge, width, room, rail }, mode) {
  const html = document.documentElement.style;
  html.setProperty('--book-room', `${Math.round(room)}px`);
  root.dataset.mode = mode;
  parts.table.style.width = `${Math.round(room)}px`;
  parts.spine.style.left = `${edge}px`;
  parts.leaf.style.left = `${edge + SPINE}px`;
  parts.leaf.style.width = `${Math.max(width, innerWidth - RAIL - edge - SPINE)}px`;
  parts.rail.style.left = `${rail}px`;
  // folded right past the edge, the book is out of sight, its shadows too, and only its lip is left
  root.classList.toggle('bk-away', mode === 'folded' && edge >= innerWidth);
}
// The layout settled: placed, told to the page (data-book on <html>, and a book:layout event for whoever lays out by it)
function show(l) {
  drawn = l;
  place(placeOf(l), l.mode);
  document.documentElement.dataset.book = l.mode;
  root.toggleAttribute('data-facing', l.facing);
  parts.leaf.inert = parts.rail.inert = l.mode === 'folded';
  parts.lip.inert = l.mode !== 'folded';
  // in the spread the book covers HQ's page on purpose: it can't be tapped through
  document.body.inert = l.mode === 'spread';
  document.dispatchEvent(new CustomEvent('book:layout', { detail: { ...l } }));
}

// The spine: a flick right puts the book away, a drag left past half the screen spreads it, anywhere else it's the
// book's new width. It follows the finger (or the mouse) while held; HQ's page lays itself out once it's let go.
function dragSpine() {
  follow(parts.spine, {
    move: dx => {
      const from = placeOf(drawn),
        edge = Math.min(innerWidth - RAIL, Math.max(0, from.edge + dx));
      place({ ...from, edge, width: drawn.mode === 'spread' ? from.width : from.width - dx }, drawn.mode);
    },
    end: (dx, v) => {
      const next = released(innerWidth, innerHeight, state, dx, v);
      place(placeOf(drawn), drawn.mode);
      go(next);
    },
  });
}
// The lip pulled left brings the folded book back, peeking out under the finger as it comes
function dragLip() {
  follow(parts.lip, {
    when: () => drawn.mode === 'folded',
    move: dx => {
      const from = placeOf(drawn),
        edge = innerWidth + Math.min(0, dx);
      place({ ...from, edge, rail: Math.max(innerWidth - RAIL, edge + SPINE + from.width) }, 'folded');
    },
    end: (dx, v) => {
      place(placeOf(drawn), drawn.mode);
      go(pulled(innerWidth, innerHeight, state, dx, v));
    },
  });
}
// A horizontal drag on an element: move(dx) while it's held past TAP_PX, end(dx, v) as it's let go (v in px per ms,
// over its last FLICK_MS: a flick is how fast it was going as it left, whatever came before). A press that never moves that far stays a tap (the lip's). when(): whether to follow.
function follow(node, { when = () => true, move, end }) {
  node.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button > 0 || !when()) return;
    const x0 = e.clientX,
      trail = [[e.timeStamp, x0]];
    let dragging = false;
    const onMove = m => {
      if (m.pointerId !== e.pointerId) return;
      const dx = m.clientX - x0;
      trail.push([m.timeStamp, m.clientX]);
      if (trail.length > 6) trail.shift();
      if (!dragging && Math.abs(dx) < TAP_PX) return;
      if (!dragging) node.setPointerCapture?.(e.pointerId);
      dragging = true;
      move(dx);
    };
    const onUp = u => {
      if (u.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      if (!dragging) return;
      // (moves can share a timestamp: a millisecond at least, so a quick flick reads fast, not still)
      const [t0, xa] = trail.find(([t]) => t >= u.timeStamp - FLICK_MS) ?? trail.at(-1),
        dt = Math.max(1, u.timeStamp - t0);
      // a drag ends on its own pointerup, never on the click that may follow it
      const swallow = c => c.stopPropagation();
      node.addEventListener('click', swallow, true);
      setTimeout(() => node.removeEventListener('click', swallow, true));
      end(u.clientX - x0, (u.clientX - xa) / dt);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  });
}
