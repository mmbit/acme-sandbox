// The book beside HQ's page: its cloth spine, its paper and its rail, open beside the page, folded away past the
// screen's right edge with only its lip showing there (over the page, which keeps its whole width), or spread over the
// screen. HQ's page is <body>: it lays itself out in the room the book leaves (--book-room on <html>, style.css), so the
// open book never covers it. The book lives outside <body>, in #book. (the lip)
// The layout's maths is booklayout.js; the rail's faces bookrail.js; the pages bookpages.js; its look booklook.css; its
// cover, swinging open as the book opens, bookcover.js. One object: its spine, cover and paper under one shadow, its
// controls floating over its paper (bookui.js). Folded, its handle (bookhandle.js) is what's left of it at the screen's
// edge. It moves by transforms alone, laid out again only once it's let go or has landed; the room it leaves while it
// moves is the table's (book.css). (handle and motion: job #19861)
import { store, stylesheet } from '../util.js';
import * as world from '../world/world.js';
import { SPINE, layout, shapeOf, released, pulled, recall, keep, bookWidth } from './booklayout.js';
import { mountRail } from './bookrail.js';
import { mountHandle } from './bookhandle.js';
import { mountLanding } from './booklanding.js'; // (a mark lifted into the book.)
import { island } from './bookui.js';
import { mountPages } from './bookpages.js';
import { PAPER } from '/__review/paper.js';
import { mountSearch } from './booksearch.js';
import { mountCover, openCover, shutCover, hideCover } from './bookcover.js';
import { look } from './stage.js';

// How long the book takes to slide: a sketchbook pushed aside on a desk, quick and soft at the end. Opening, its cover
// starts to swing open this far into the slide, as it lands.
const SLIDE_MS = 240,
  SLIDE_EASE = 'cubic-bezier(0.2, 0.75, 0.25, 1)',
  LANDS = 0.6;
// With reduced motion the book fades in or out instead, this quickly
const FADE_MS = 140;
// A press that moves less than this is a tap
const TAP_PX = 8;
// A flick's speed is read over its last moves, this long
const FLICK_MS = 100;

let root, parts, pages;
let state, drawn; // state: what's asked for (mode, the book's width); drawn: the layout on screen now
let placed = null; // where the parts are on the screen now (placeOf's shape), mid-drag or mid-slide too
let laid = null; // where they're laid out ({ edge, width, room }, the leaf's width as set): a move is a transform from it
let moving = []; // the slide or fade under way: its animations

// The book's styles (and the sheets' notes on its pages). (out of initBook)
const STYLES = [
  'shell/book.css',
  'shell/booklook.css',
  'shell/booksheet.css',
  'shell/bookfaces.css', // (the faces)
  'shell/booksearch.css', // (Search)
  'shell/bookui.css', // (the controls' one style)
  'shell/bookdesk.css', // (the page, its heading, the overview)
  'shell/bookwent.css', // (what a send carries)
  'shell/bookasks.css', // (the desk phone's cards in the book)
];

export async function initBook() {
  await Promise.all(STYLES.map(href => stylesheet(href)));
  mountRoot();
  state = recall(store, shape());
  mountRail(parts.rail, {
    dev: world.dev,
    open: () => go({ ...state, mode: 'open' }),
    undo: () => pages.undo(),
    redo: () => pages.redo(),
  });
  pages = mountPages(parts.paper, { dev: world.dev, shape });
  // (Search, in the overview's head: a find opens its page at its note.)
  mountSearch(island('overview'), { dev: world.dev, find: at => pages.find(at) });
  // (a note or page asked from elsewhere, the desk phone's Open in the book: the book lands on it as on a find, its day's
  // row turned to its note, the number lit.)
  document.addEventListener('book:find', e => pages.find(e.detail));
  // (a page made or thrown away outside the book, a call's: calldraw.js, markpage.js, which send book:paged: today's read
  // again, at that page if it's new; the rail reads its sheets again too. Not book:changed, which an answer or a slip
  // sends and which must leave the page the board is on.)
  document.addEventListener('book:paged', e => {
    pages.made(e.detail?.page);
    document.dispatchEvent(new CustomEvent('book:changed'));
  });
  // (the cover, its name the owner's)
  mountCover(root, parts.leaf);
  show(layout(innerWidth, innerHeight, state));
  if (drawn.mode !== 'folded') openCover();
  undoKeys();
  dragSpine();
  dragLip();
  mountHandle(parts.lip, { open: openBook, openOn });
  mountLanding({ pages, lip: parts.lip, paper: parts.paper, layout: bookLayout });
  watchSize();
}
// A turn or a new window size: the shape's own remembered state, laid out at once (nothing slides). Watched on <html>'s
// box, which follows the window whether or not a resize event comes with it. One that lands mid-slide or mid-fade
// settles the board's move: still the board's act (the pin's summon).
function watchSize() {
  let size = `${innerWidth}x${innerHeight}`;
  new ResizeObserver(() => {
    if (`${innerWidth}x${innerHeight}` === size) return;
    size = `${innerWidth}x${innerHeight}`;
    state = recall(store, shape());
    show(layout(innerWidth, innerHeight, state), { act: moving.length > 0 });
  }).observe(document.documentElement);
}

// The book's table, spine, leaf (its paper), rail and lip, on <html>
function mountRoot() {
  root = document.createElement('div');
  root.id = 'book';
  root.style.cssText = PAPER;
  root.innerHTML = `<div class="bk-table"></div><div class="bk-spine" role="separator" aria-orientation="vertical"
    aria-label="The book's spine: drag it right to put the book away, left to spread it"><i></i></div>
    <section class="bk-leaf" aria-label="The book"><div class="bk-paper"></div><nav class="bk-rail" aria-label="The book's controls"></nav></section>
    <button class="bk-lip" aria-label="The book: tap or pull it in"><i class="bk-loop"></i></button>`;
  document.documentElement.append(root);
  parts = Object.fromEntries(
    ['table', 'spine', 'leaf', 'paper', 'rail', 'lip'].map(k => [k, root.querySelector(`.bk-${k}`)]),
  );
}
// What the book shows now: { mode, shape, page, spine, book, room }
export const bookLayout = () => drawn;
// Open the book (a face's tap, Search), fold it away, or the spread
export const openBook = () => go({ ...state, mode: 'open' });
export const foldBook = () => go({ ...state, mode: 'folded' });
// Open the book at an owner's sheet (null: nobody's, the CEO's), turned to once its pages are laid out for the paper's
// new width: a turn before that would be undone by the row laid out again. (desk.js's bookAt, the lip.: was desk.js's)
// at: a place to land on instead, { day, page, note }: a find of its note on its page of that day, scrolled to and lit,
// or the page alone (a desk-phone card's Open in the book.)
export function openAt(owner, at = null) {
  const [name, detail] = at?.page ? ['book:find', at] : ['book:face', { owner }];
  document.addEventListener(
    'book:layout',
    () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.dispatchEvent(new CustomEvent(name, { detail }))),
      ),
    { once: true },
  );
  openBook();
}
// Open the book on a note of today's (the handle's tap after a mark landed in it), found once its pages are laid out for
// the paper's width.
export function openOn({ page, id }) {
  document.addEventListener('book:layout', () => pages.find({ page, note: id }), { once: true });
  openBook();
}
// A page of the day shown turned to (a second screen's turn: pair.js.)
export const showBookPage = id => pages?.show(id);

const shape = () => shapeOf(innerWidth, innerHeight);

// Slide to a state, and remember it for this shape. The slide starts from where the book is on the screen (where a
// drag left it), never from where it was before. Opening, the book comes in shut, its cover showing, and the cover swings
// open as it lands (bookcover.js); with reduced motion it fades in or out. (from
// where it is; the cover from the start: job #19861)
function go(next) {
  stop();
  state = next;
  keep(store, shape(), state);
  const to = layout(innerWidth, innerHeight, state),
    opening = drawn.mode === 'folded' && to.mode !== 'folded';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return fade(to);
  if (same(placed, placeOf(to))) {
    show(to, { act: true });
    if (opening) openCover();
    return;
  }
  if (opening) shutCover();
  glide(to);
  if (opening) openCover({ wait: SLIDE_MS * LANDS });
}
// (the book already where it's going: HQ's page lays itself out in its new room at once, never sliding)
const same = (a, b) => a && ['edge', 'width'].every(k => Math.abs(a[k] - b[k]) < 0.5);

// The slide: spine, leaf and handle moved together by a transform, on the compositor, from where they are to where
// they're going; the leaf laid out wide enough for both ends first. HQ's page keeps its room till the book has landed:
// whatever the book uncovers on the way is the table's. Laid out where it landed once it's there.
function glide(to) {
  stop();
  const from = placed,
    target = placeOf(to);
  widen(Math.max(reach(from), reach(target)));
  tones();
  root.classList.remove('bk-away');
  const frames = [{ transform: across(from.edge - laid.edge) }, { transform: across(target.edge - laid.edge) }],
    timing = { duration: SLIDE_MS, easing: SLIDE_EASE };
  moving = movers().map(el => el.animate(frames, timing));
  shift(target.edge - laid.edge);
  placed = target;
  const mine = moving;
  mine[0].finished.then(
    () => moving === mine && show(to, { act: true }),
    () => {},
  );
}
// Reduced motion: the book shows where it's going at once, fading in; or fades out where it is, then goes
function fade(to) {
  stop();
  const book = [parts.spine, parts.leaf],
    timing = { duration: FADE_MS, easing: 'ease-out' };
  if (to.mode !== 'folded' || drawn.mode === 'folded') {
    const coming = drawn.mode === 'folded';
    show(to, { act: true });
    if (coming) moving = book.map(el => el.animate([{ opacity: 0 }, { opacity: 1 }], timing));
    return;
  }
  moving = book.map(el => el.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, fill: 'forwards' }));
  const mine = moving;
  mine[0].finished.then(
    () => moving === mine && show(to, { act: true }),
    () => {},
  );
}

// Where the parts sit: edge, the spine's left (x px); width, the paper's; room, what HQ's page gives up. Folded, the
// book keeps its open width and lies past the screen's right edge; the spread starts at the screen's left edge with its
// spine (to drag it back), and HQ's page keeps its open width under it.
function placeOf(l) {
  const w = innerWidth;
  if (l.mode === 'folded') return { edge: w, width: bookWidth(w, state.book), room: 0 };
  if (l.mode === 'spread') return { edge: 0, width: w - SPINE, room: l.room };
  return { edge: l.page, width: l.book, room: l.room };
}
// The parts laid out where they are (the book at rest): the room HQ's page gives up, the table under it, the spine, the
// leaf (at least to the screen's right edge) and the handle at the spine's edge, none moved by a transform
function place(at, mode) {
  stop();
  const { edge, width, room } = at;
  placed = at;
  laid = { ...at, leaf: Math.max(width, reach(at)) };
  const html = document.documentElement.style;
  html.setProperty('--book-room', `${Math.round(room)}px`);
  root.dataset.mode = mode;
  parts.table.style.width = `${Math.round(room)}px`;
  parts.spine.style.left = `${edge}px`;
  parts.leaf.style.left = `${edge + SPINE}px`;
  parts.leaf.style.width = `${laid.leaf}px`;
  parts.lip.style.left = `${edge}px`;
  shift(0);
  // folded right past the edge, the book is out of sight, its shadows too, and only its handle is left
  root.classList.toggle('bk-away', mode === 'folded' && edge >= innerWidth);
}
// Mid-drag: the parts moved to an edge by a transform from where they're laid out, the leaf laid out wider only when
// the book's pulled wider than it is. width: what the book's paper is then.
function hold(at) {
  stop();
  placed = at;
  widen(Math.max(at.width, reach(at)));
  shift(at.edge - laid.edge);
  root.classList.toggle('bk-away', drawn.mode === 'folded' && at.edge >= innerWidth);
}
// The leaf at least this wide (its one layout mid-move)
function widen(px) {
  if (px <= laid.leaf) return;
  laid.leaf = px;
  parts.leaf.style.width = `${px}px`;
}
// How wide the leaf must be to reach the screen's right edge from an edge
const reach = at => innerWidth - at.edge - SPINE;
const movers = () => [parts.spine, parts.leaf, parts.lip];
const across = dx => (dx ? `translate3d(${dx}px, 0, 0)` : 'none');
const shift = dx => movers().forEach(el => (el.style.transform = dx ? across(dx) : ''));
// The slide or fade under way stopped where it is, which a new one starts from
function stop() {
  if (!moving.length) return;
  const dx = new DOMMatrix(getComputedStyle(parts.spine).transform).m41;
  moving.forEach(a => a.cancel());
  moving = [];
  placed = { ...placed, edge: laid.edge + dx };
  shift(dx);
}
// The table's two tones, a quiet checkerboard (book.css), from the look on HQ's page: its ground (<html>'s where the
// page has none), and its ink or its paper, whichever stands apart from it. Read when the book starts to move, once per look.
let toned = null;
function tones() {
  if (toned === look) return;
  toned = look;
  const page = getComputedStyle(document.body),
    ground = [page, getComputedStyle(document.documentElement)]
      .map(box => box.backgroundColor)
      .find(c => c !== 'rgba(0, 0, 0, 0)'),
    [r, g, b] = ground.match(/[\d.]+/g).map(Number),
    dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  parts.table.style.setProperty('--bk-ground', ground);
  parts.table.style.setProperty('--bk-check', page.getPropertyValue(dark ? '--paper' : '--ink').trim());
}
// The layout settled: placed, told to the page (data-book on <html>, and a book:layout event for whoever lays out by it,
// act true when the board moved the book, not a new window size or HQ's start: the pin's summon, pinsummon.js)
function show(l, { act = false } = {}) {
  drawn = l;
  place(placeOf(l), l.mode);
  document.documentElement.dataset.book = l.mode;
  parts.leaf.inert = l.mode === 'folded';
  parts.lip.inert = l.mode !== 'folded';
  // in the spread the book covers HQ's page on purpose: it can't be tapped through
  document.body.inert = l.mode === 'spread';
  if (l.mode === 'folded') hideCover();
  document.dispatchEvent(new CustomEvent('book:layout', { detail: { ...l, act } }));
}

// The spine: wherever it's let go the book stays, folded only where it's too narrow to draw on and spread only where
// HQ's page would be too narrow; a flick folds or spreads it (booklayout.js). It follows the finger (or the mouse)
// while held: dragged right the book slides off past the screen's edge as it is, dragged left it's wider. HQ's page
// lays itself out once it's let go.
function dragSpine() {
  follow(parts.spine, {
    start: tones,
    move: dx => {
      const from = placeOf(drawn),
        edge = Math.min(innerWidth - SPINE, Math.max(0, from.edge + dx));
      hold({ ...from, edge, width: Math.max(from.width, innerWidth - edge - SPINE) });
    },
    // let go, it stays where it was let go: a new width is laid out there at once; a fold or the spread slides on from
    // there
    end: (dx, v) => go(released(innerWidth, innerHeight, state, dx, v)),
  });
}
// The handle pulled left brings the folded book with it, its cover shut, as wide as it's pulled or its own width; let
// go, it stays there (booklayout.js's pulled).
function dragLip() {
  follow(parts.lip, {
    when: () => drawn.mode === 'folded',
    start: shutCover,
    move: dx => {
      const from = placeOf(drawn),
        edge = Math.max(0, innerWidth + Math.min(0, dx));
      hold({ ...from, edge, width: Math.max(from.width, innerWidth - edge - SPINE) });
    },
    end: (dx, v) => go(pulled(innerWidth, innerHeight, state, dx, v)),
  });
}
// ⌘Z (Ctrl+Z) takes back the book's last step while it's open and nothing being typed into has the keys; with Shift
// (or Ctrl+Y) it makes the last undone again (redo job #19243)
function undoKeys() {
  addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !(key === 'z' || (key === 'y' && e.ctrlKey && !e.shiftKey))) return;
    if (drawn.mode === 'folded' || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    if (e.shiftKey || key === 'y') pages.redo();
    else pages.undo();
  });
}
// A horizontal drag on an element: start() once it's held past TAP_PX, move(dx) while it is, end(dx, v) as it's let go
// (v in px per ms, over its last FLICK_MS: a flick is how fast it was going as it left, whatever came before). A press
// that never moves that far stays a tap (the handle's). when(): whether to follow.
function follow(node, { when = () => true, start = () => {}, move, end }) {
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
      if (!dragging) {
        node.setPointerCapture?.(e.pointerId);
        start();
      }
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
