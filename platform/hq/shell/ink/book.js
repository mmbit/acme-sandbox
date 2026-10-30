// The Notebook beside HQ's page: a black hardcover open on the screen, resting a margin in from its edges (book.css),
// its spine by the screen's right edge, its pages on the cover with the black board showing round them; shut, it's past
// the screen's right edge with only its pull tab showing there (over the page, which keeps its whole width); where HQ
// would be too narrow beside it (a phone), it lies on top of the screen (the spread). HQ's page is <body>: it lays
// itself out in the room the book leaves (--book-room on <html>, style.css), so the open book never covers it, and
// fades quickly into its new room as the book lands. The book lives outside <body>, in #book.
// The layout's maths is booklayout.js; the rail's Undo and Redo bookrail.js; the pages bookpages.js; its look booklook.css. One
// object: its cover and paper under one shadow, its controls floating over its paper (bookui.js). Two controls, one
// job each: the pull tab (bookhandle.js) opens and closes it, the cover's outer edge resizes it and never closes it. It
// moves by transforms alone, laid out again only once it's let go or has landed; the room it leaves while it moves is
// the table's (book.css). It opens and shuts as a heavy hardcover swinging round its spine (bookswing.js), and slides
// only from one open width to another. (handle and motion: job #19861) (the hardcover, its tab and edge) (the swing)
import { store, stylesheet } from '../../util.js';
import * as world from '../../world/world.js';
import { EDGE, BOOK, layout, shapeOf, released, pulled, recall, keep, bookWidth } from './booklayout.js';
import { mountRail } from './bookrail.js';
import { mountHandle } from './bookhandle.js';
import * as swing from './bookswing.js';
import { mountLanding } from './booklanding.js'; // (a mark lifted into the book.)
import { showGroup } from './bookgroupshow.js';
import { aimAt, mountNewest, openNewest } from './booknewest.js';
import { island } from './bookui.js';
import { mountPages } from './bookpages.js';
import { PAPER } from '/__review/paper.js';
import { mountSearch } from './booksearch.js';
import { follow } from './bookfollow.js';
import { setScope, word } from './bookscope.js';
import { useFaces } from './bookfaces.js';
import { STYLES } from './bookstyles.js';
import { mountTones, tones, cover } from './booktable.js';

// How long the book takes to slide from one open width to another: a notebook pushed aside on a desk, quick and soft
// at the end. (Opening and shutting is the swing's: bookswing.js.)
const SLIDE_MS = 240,
  SLIDE_EASE = 'cubic-bezier(0.2, 0.75, 0.25, 1)';
// HQ's page going to its new room as the book lands: dimmed this quickly to this much (never to black: HQ's ground is
// dark), laid out, and back in, never an instant jump
const ROOM_MS = { out: 70, in: 130 },
  ROOM_DIM = 0.35;
// With reduced motion the book fades in or out instead, this quickly
const FADE_MS = 140;

let root, parts, pages;
let state, drawn; // state: what's asked for (mode, the book's width); drawn: the layout on screen now
let placed = null; // where the parts are on the screen now (placeOf's shape), mid-drag or mid-slide too
let laid = null; // where they're laid out ({ x, width, room }, the leaf's width as set): a move is a transform from it
let moving = []; // the slide or fade under way: its animations
// HQ's viewer has the open book lie over its frames, the board's pick there: HQ's page then gives up no room for it,
// and the viewer's bar keeps clear of it by --book-over (viewer.js's viewer:over.)
let over = false;

export async function initBook({ scope = null } = {}) {
  setScope(scope);
  if (!scope) {
    const stage = await import('../stage.js');
    useFaces({
      look: () => stage.look,
      draw: id => (world.agents.has(id) ? stage.scene?.portrait?.({ kind: 'agent', id }) : null),
    });
  }
  await Promise.all(STYLES.map(href => stylesheet(href)));
  mountRoot();
  state = recall(store, shape());
  if (scope) state.mode = 'open';
  mountRail(parts.rail, {
    undo: () => pages.undo(),
    redo: () => pages.redo(),
  });
  const calls = scope ? null : await import('../calldrop.js');
  pages = mountPages(parts.paper, { dev: world.dev, shape, scope, calls });
  // (Search, in the overview's head: a find opens its page at its note.)
  if (!scope) mountSearch(island('overview'), { dev: world.dev, find: at => pages.find(at) });
  // (a note or page asked from elsewhere, the desk phone's Open in the book: the book lands on it as on a find, its day's
  // row turned to its note, the number lit.)
  document.addEventListener('book:find', e => pages.find(e.detail));
  mountTones(parts.table); // (the table's ground: booktable.js)
  // (a page made or thrown away outside the book, a call's: calldraw.js, markpage.js, which send book:paged: the
  // notebook's pages read again, at that page if it's new.)
  document.addEventListener('book:paged', e => pages.made(e.detail?.page));
  document.addEventListener('viewer:over', e => {
    over = e.detail === true;
    if (drawn && !moving.length) show(drawn);
  });
  show(layout(innerWidth, innerHeight, state));
  undoKeys();
  dragEdge();
  mountSwing();
  mountHandle(parts.lip, { open: openBook, fold: foldBook, openOn, shut: shutOrShutting });
  mountLanding({ pages, lip: parts.lip, paper: parts.paper, layout: bookLayout });
  if (!scope) mountNewest(pages, openBook); // (the note the board just pinned, shown as the book opens)
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
    const acting = moving.length > 0 || swing.swinging();
    swing.cancel();
    state = recall(store, shape());
    show(layout(innerWidth, innerHeight, state), { act: acting });
  }).observe(document.documentElement);
}

// The book's table, its cover's edge, leaf (the cover with its paper and spine), rail and pull tab (the lip), on <html>
function mountRoot() {
  root = document.createElement('div');
  root.id = 'book';
  root.style.cssText = PAPER;
  root.innerHTML = `<div class="bk-table"></div><div class="bk-edge" role="separator" aria-orientation="vertical"
    aria-label="${word("The Notebook's edge: drag it to make the Notebook wider or narrower")}"></div>
    <section class="bk-leaf" aria-label="${word('The Notebook')}"><div class="bk-paper"></div><nav class="bk-rail" aria-label="${word(
      "The Notebook's controls",
    )}"></nav></section>
    <button class="bk-lip" aria-label="${word('The Notebook: tap or pull it to open')}"></button>`;
  document.documentElement.append(root);
  parts = Object.fromEntries(
    ['table', 'edge', 'leaf', 'paper', 'rail', 'lip'].map(k => [k, root.querySelector(`.bk-${k}`)]),
  );
}
// What the book shows now: { mode, shape, page, edge, book, room }
export const bookLayout = () => drawn;
// Open the book (a face's tap, Search, the pull tab), or shut it (the pull tab)
export const openBook = () => go({ ...state, mode: 'open' });
export const foldBook = () => go({ ...state, mode: 'folded' });
// Open the book, at a place to land on ({ page, notebook }: a desk-phone card's Open in the book), turned to once its
// pages are laid out for the paper's new width: a turn before that would be undone by the pages laid out again.
// (desk.js's bookAt, the lip.: was desk.js's) (an owner's sheet gone with the sheets) (notebook)
export function openAt(at = null) {
  if (!at?.page) return openNewest();
  openTo(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('book:find', { detail: at }))),
    ),
  );
}
// Open the book on a note of today's (the handle's tap after a mark landed in it), found once its pages are laid out for
// the paper's width; a Notebook scrap's (group) on its page, slid into view. (group)
export const openOn = ({ page, id, group = false }) =>
  openTo(() => (group ? showGroup(pages, { page, id }) : pages.find({ page, note: id })));
// The book opened at a place of its own, found once it's laid out (book:layout)
function openTo(find) {
  aimAt('place');
  document.addEventListener('book:layout', find, { once: true });
  openBook();
}
// A page of the day shown turned to (a second screen's turn: pair.js.)
export const showBookPage = id => pages?.show(id);

const shape = () => shapeOf(innerWidth, innerHeight);

// Go to a state, and remember it for this shape: opened or shut, the board swings (from where it is, mid-swing too);
// from one open width to another, the book slides from where it is on the screen (where a drag left it), never from
// where it was before. The book opens straight onto its page. With reduced motion it fades in or out. (from where it
// is: job #19861)
function go(next) {
  stop();
  state = next;
  keep(store, shape(), state);
  const to = layout(innerWidth, innerHeight, state);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    swing.cancel();
    return fade(to);
  }
  const shutting = to.mode === 'folded';
  if (swing.swinging() || (drawn.mode === 'folded') !== shutting) return shutting ? swing.shut() : swing.open();
  if (same(placed, placeOf(to))) return show(to, { act: true });
  glide(to);
}
// The book shut, or swinging shut: the pull tab's tap opens it then (bookhandle.js)
const shutOrShutting = () => (swing.heading() ?? (drawn.mode === 'folded' ? 'shut' : 'open')) === 'shut';
// The swing's side of the book (bookswing.js): where the open book lies, laid out there, and its landing or shutting
// laid out and remembered, HQ's page put in its new room at once (the swing's dissolve hides it meanwhile)
function mountSwing() {
  swing.mountSwing(root, parts, {
    board() {
      const l = drawn.mode !== 'folded' ? drawn : layout(innerWidth, innerHeight, { ...state, mode: 'open' }),
        at = placeOf(l);
      return { x: at.x, width: at.width, over: l.mode === 'spread' };
    },
    lay(at) {
      stop();
      placed = { ...at, room: drawn.room };
      laid = { ...placed, leaf: Math.max(at.width, reach(at)) };
      parts.edge.style.left = `${at.x}px`;
      parts.leaf.style.left = `${at.x + EDGE}px`;
      leafTo(laid.leaf);
      parts.lip.style.left = `${at.x}px`;
      shift(0);
      away(false);
      if (at.over) cover(parts.table, true);
    },
    widen,
    laidOpen: () => drawn.mode === 'open',
    landed(dx) {
      const open = { ...state, mode: state.mode === 'folded' ? 'open' : state.mode };
      state = dx ? released(innerWidth, innerHeight, open, dx) : open;
      keep(store, shape(), state);
      show(layout(innerWidth, innerHeight, state), { act: true, fade: false });
    },
    shut() {
      state = { ...state, mode: 'folded' };
      keep(store, shape(), state);
      show(layout(innerWidth, innerHeight, state), { act: true, fade: false });
    },
    edge: { start: tones, move: edgeMove, end: edgeEnd },
    pulled: (dx, v) => go(pulled(innerWidth, innerHeight, state, dx, v)),
  });
}
// (the book already where it's going: HQ's page lays itself out in its new room at once, never sliding)
const same = (a, b) => a && ['x', 'width'].every(k => Math.abs(a[k] - b[k]) < 0.5);

// The slide: the edge, leaf and tab moved together by a transform, on the compositor, from where they are to where
// they're going; the leaf laid out wide enough for both ends first. HQ's page keeps its room till the book has landed:
// whatever the book uncovers on the way is the table's. Laid out where it landed once it's there.
function glide(to) {
  stop();
  const from = placed,
    target = placeOf(to);
  widen(Math.max(reach(from), reach(target)));
  tones();
  away(false);
  const frames = [{ transform: across(from.x - laid.x) }, { transform: across(target.x - laid.x) }],
    timing = { duration: SLIDE_MS, easing: SLIDE_EASE };
  moving = movers().map(el => el.animate(frames, timing));
  shift(target.x - laid.x);
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
  const book = [parts.edge, parts.leaf],
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

// Where the parts sit: x, the cover's edge's left (px); width, the leaf's; room, what HQ's page gives up. Shut, the
// book keeps its open width and lies past the screen's right edge; the spread starts its cover's edge a margin from the
// screen's left edge (upright, just past it, so its page fills the screen), and HQ's page keeps its open width under it.
function placeOf(l) {
  const w = innerWidth;
  if (l.mode === 'folded') return { x: w, width: bookWidth(w, state.book), room: 0 };
  if (l.mode === 'spread') {
    const x = upright() ? -EDGE : margin();
    return { x, width: w - EDGE - x, room: l.room };
  }
  return { x: l.page, width: l.book, room: l.room };
}
// (the spread's margin from the screen's left edge, as the book has at the others: book.css's --bk-gap, none upright)
const margin = () => parseFloat(getComputedStyle(root).getPropertyValue('--bk-gap'));
const upright = () => matchMedia('(orientation: portrait)').matches;
// The parts laid out where they are (the book at rest): the room HQ's page gives up (faded into when the board moved
// the book), the table under it, the cover's edge, the leaf (at least to the screen's right edge) and the pull tab at
// the cover's edge, none moved by a transform
function place(at, mode, act, fade = act) {
  stop();
  const { x, width, room } = at;
  placed = at;
  laid = { ...at, leaf: Math.max(width, reach(at)) };
  toRoom(over ? 0 : Math.round(room), fade);
  document.documentElement.style.setProperty('--book-over', `${over ? Math.round(room) : 0}px`);
  tones(); // (the table shows round the resting book)
  root.dataset.mode = mode;
  cover(parts.table, mode === 'spread', room, fade ? ROOM_MS.out + ROOM_MS.in : 0);
  parts.edge.style.left = `${x}px`;
  parts.leaf.style.left = `${x + EDGE}px`;
  leafTo(laid.leaf);
  parts.lip.style.left = `${x}px`;
  shift(0);
  away(mode === 'folded' && x >= innerWidth);
}
// Shut past the screen's edge, the book is out of sight, its shadows too, and only its pull tab is left; its pages paint
// nothing meanwhile, drawn as they are once it shows (bookpages.js)
function away(on) {
  root.classList.toggle('bk-away', on);
  pages.away(on);
}
// HQ's page in its new room: at once at the start and on a new window size; when the board moved the book, a quick
// fade out, laid out, and in again, so the page never jumps. The page takes input all the while.
let roomFade = null;
function toRoom(px, fade) {
  const html = document.documentElement.style,
    was = html.getPropertyValue('--book-room');
  roomFade?.cancel();
  roomFade = null;
  document.body.getAnimations().forEach(a => a.id === 'bk-room' && a.cancel());
  if (was === `${px}px`) return;
  if (!fade || !was) return html.setProperty('--book-room', `${px}px`);
  const out = (roomFade = fadeBody([1, ROOM_DIM], { duration: ROOM_MS.out, fill: 'forwards' }));
  // (a fade overtaken by the next move leaves the room to that one)
  out.finished.then(
    () => {
      if (roomFade !== out) return;
      html.setProperty('--book-room', `${px}px`);
      out.cancel();
      fadeBody([ROOM_DIM, 1], { duration: ROOM_MS.in, easing: 'ease-out' });
    },
    () => {},
  );
}
const fadeBody = ([from, to], timing) =>
  document.body.animate([{ opacity: from }, { opacity: to }], { id: 'bk-room', ...timing });
// Mid-drag: the parts moved to an edge by a transform from where they're laid out, the leaf laid out wider only when
// the book's pulled wider than it is. width: what the book's paper is then.
function hold(at) {
  stop();
  placed = at;
  widen(Math.max(at.width, reach(at)));
  shift(at.x - laid.x);
  away(drawn.mode === 'folded' && at.x >= innerWidth);
}
// The leaf at least this wide (its one layout mid-move)
function widen(px) {
  if (px <= laid.leaf) return;
  laid.leaf = px;
  leafTo(px);
}
// The leaf this wide, and the book's one shadow with it: the cover's edge casts it for the whole book (book.css), so
// it moves and swings with the book
function leafTo(px) {
  parts.leaf.style.width = `${px}px`;
  parts.edge.style.setProperty('--bk-leaf', `${px}px`);
}
// How wide the leaf must be to reach the screen's right edge from where it is
const reach = at => innerWidth - at.x - EDGE;
const movers = () => [parts.edge, parts.leaf, parts.lip];
const across = dx => (dx ? `translate3d(${dx}px, 0, 0)` : 'none');
const shift = dx => movers().forEach(el => (el.style.transform = dx ? across(dx) : ''));
// The slide or fade under way stopped where it is, which a new one starts from
function stop() {
  if (!moving.length) return;
  const dx = new DOMMatrix(getComputedStyle(parts.edge).transform).m41;
  moving.forEach(a => a.cancel());
  moving = [];
  placed = { ...placed, x: laid.x + dx };
  shift(dx);
}
// The layout settled: placed, told to the page (data-book on <html>, and a book:layout event for whoever lays out by it,
// act true when the board moved the book, not a new window size or HQ's start: the pin's summon, pinsummon.js)
// fade: whether HQ's page fades into its new room (toRoom), as it does when the board moved the book; false where the
// swing's dissolve already hides it
function show(l, { act = false, fade = act } = {}) {
  drawn = l;
  place(placeOf(l), l.mode, act, fade);
  document.documentElement.dataset.book = l.mode;
  parts.leaf.inert = l.mode === 'folded';
  parts.edge.inert = l.mode === 'folded';
  // in the spread the book covers HQ's page on purpose: it can't be tapped through
  document.body.inert = l.mode === 'spread';
  document.dispatchEvent(new CustomEvent('book:layout', { detail: { ...l, act } }));
}

// The cover's outer edge: dragged, it resizes the open book, the edge following the finger (or the mouse) while held
// and the book never narrower than it can be drawn on; let go, the book stays that wide, HQ's page laid out beside it
// (or under it, where it would be too narrow: the spread). It never closes the book (booklayout.js's released).
// (the open book's pull tab pulled left first resizes it the same way: bookswing.js)
function dragEdge() {
  follow(parts.edge, { start: tones, move: edgeMove, end: edgeEnd });
}
function edgeMove(dx) {
  const from = placeOf(drawn),
    x = Math.min(innerWidth - EDGE - BOOK.min, Math.max(0, from.x + dx));
  hold({ ...from, x, width: Math.max(from.width, innerWidth - x - EDGE) });
}
const edgeEnd = dx => go(released(innerWidth, innerHeight, state, dx));
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
