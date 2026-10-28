// The book's Select tool: a loop drawn round things (a lasso), or a drag from corner to corner (a box), picks the ink,
// pictures and typed words in it; a click picks the one on top, Shift adds or takes away, a click on bare paper lets
// go. What's picked shows in a frame with a handle at each corner: pressed inside and dragged, it moves; a handle
// scales it about the opposite corner. Cut, copy, paste, duplicate and delete are bookselectclip.js's (the keys, the
// clipboard and the bar beside the frame); the live move and resize bookselectlift.js's. Post-its keep their own order
// on their sheet and are never picked (booktools.js sends their presses elsewhere).
//
// booktools.js mounts it and calls press(e) for a mouse's or a Pencil's press on the page in select mode, and settle()
// before Undo or Redo and when the tool changes. Every change is one step through hooks.begin(view) (bookedit.js).
import { stylesheet } from '../../util.js';
import { sfx } from '../audio.js';
import { grownTo } from './bookrow.js';
import { boundsOf, gestureOf, picked, topAt, union, within } from './bookselectmath.js';
import { mountClip } from './bookselectclip.js';
import { drag } from './bookselectlift.js';
import { followPress } from './bookpress.js';
import { clearShown } from './bookui.js';

// a press that moves less than this far (screen px) is a click; a line this near (screen px) is under the pointer
const CLICK_PX = 4,
  NEAR_PX = 5;
// a drag this close to straight (screen px) is a box, whatever its length
const SLOP_PX = 10;
// a second press on a box of words this soon and this near the first edits it
const DOUBLE_MS = 450,
  DOUBLE_PX = 6;
// a Pencil lifted this near the screen's edge (screen px) has slid off the glass; back over an edge within BACK_MS it
// carries on with its loop (about as long as a hand takes to come round).
const EDGE_PX = 24,
  BACK_MS = 2000;
// the frame stands this far (screen px) outside what it holds; a press this near it is still inside
const FRAME_PX = 8;
// the room the bar needs on the paper (screen px): under the frame (the pages' row at the paper's foot too), over it,
// beside it, clear of the islands across its rows (its own size measured), and its gap to the frame (bookselect.css's).
const BAR = { below: 130, above: 70, side: 8, gap: 16 };
// a box of words with no words measured: one line of booktexts.js's TEXT
const LINE_PX = 25;
const LASSO = 'http://www.w3.org/2000/svg';

// book: bookpages.js's. hooks: booktools.js's (lay, changed, redraw, inView, refresh, texts, begin).
export function mountSelect(book, hooks) {
  stylesheet('shell/ink/bookselect.css');
  // (away: a loop gone off the screen's edge, waiting for the Pencil to come back: comingBack)
  const sel = { book, hooks, view: null, ink: [], scraps: [], texts: [], frame: null, last: null, away: null };
  sel.clip = mountClip(sel);
  hovering(sel);
  comingBack(sel);
  return {
    press: e => press(sel, e),
    settle: () => letGo(sel),
    // Things just put on the page shown picked, whatever the tool: a picture taped in moves and scales at once. And
    // whether a press is on what's picked (its frame or a handle), for the other tools to give it here.
    pick: (view, things) => view === book.view() && choose(sel, view, things),
    holds: e => holds(sel, e),
  };
}

// ---- a press

// A press on the page: a handle scales, the selection or a thing on the page moves (picked first), Shift adds or takes
// away, bare paper draws a loop. A second click on a box of words edits it.
function press(sel, e) {
  const { book, hooks } = sel,
    at = book.at(e.clientX, e.clientY);
  if (!at?.view.page.ink) return false;
  e.preventDefault();
  sel.clip.away();
  if (!current(sel) || sel.view !== at.view) letGo(sel);
  const target = e.target instanceof Element ? e.target : null;
  // (the bar's own, between its buttons)
  if (target?.closest('.bk-sel-bar')) return true;
  const handle = target?.closest('.bk-sel-handle');
  if (handle) return drag(sel, e, { corner: Number(handle.dataset.corner) });
  const box = target?.closest('.bk-typed');
  if (box && doubled(sel, e, box)) {
    letGo(sel);
    return hooks.texts.press(box, e);
  }
  const p = [at.x, at.y],
    page = at.view.page,
    hit = box ? { kind: 'texts', item: box.typed } : topAt(p, page, t => boxOfText(sel, t), NEAR_PX / book.scale);
  if (e.shiftKey && hit) {
    toggle(sel, at.view, hit);
    return true;
  }
  if (hit && !sel[hit.kind].includes(hit.item)) choose(sel, at.view, { [hit.kind]: [hit.item] });
  if (hit || onFrame(sel, p)) return drag(sel, e, { corner: -1 });
  return lasso(sel, e, at);
}
// A press on the selection's handles or its bar, or a Pencil's inside its frame (a mouse's press moves a picture
// with any tool: booktools.js)
function holds(sel, e) {
  if (!current(sel)) return false;
  const at = sel.book.at(e.clientX, e.clientY),
    target = e.target instanceof Element ? e.target : null,
    inside = e.pointerType !== 'mouse' && at?.view === sel.view && onFrame(sel, [at.x, at.y]);
  return !!target?.closest('.bk-sel-handle, .bk-sel-bar') || inside;
}
const doubled = (sel, e, box) => {
  const last = sel.last;
  sel.last = { t: e.timeStamp, x: e.clientX, y: e.clientY, box };
  const near = last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_PX;
  return !!near && last.box === box && e.timeStamp - last.t < DOUBLE_MS;
};
const onFrame = (sel, p) => {
  const b = sel.view && bounds(sel),
    pad = FRAME_PX / sel.book.scale;
  return !!b && within({ x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, p);
};

// A loop drawn on bare paper, shown as it's drawn (a box once it runs straight from corner to corner, a lasso once it
// strays); let go, what's in it is picked (with Shift, added). A click lets go, and a Pencil's tap offers Paste. A
// Pencil that slides off the screen's edge and comes back carries on with the same loop (comingBack). (the edge)
function lasso(sel, e, at) {
  const svg = document.createElementNS(LASSO, 'svg');
  svg.setAttribute('class', 'bk-lasso');
  svg.append(document.createElementNS(LASSO, 'path'));
  const loop = { view: at.view, path: [[at.x, at.y]], kind: 'box', far: false, svg, down: e };
  return follow(sel, loop, e);
}
// The loop following a pointer from its press until it lifts (lifted(): then)
function follow(sel, loop, e, lifted = () => {}) {
  const { book } = sel,
    { path, svg } = loop;
  const move = m => {
    // (a made-up event has no coalesced ones)
    const all = m.getCoalescedEvents?.() ?? [];
    for (const c of all.length ? all : [m]) path.push(pageOf(book, c));
    if (!loop.far && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < CLICK_PX) return;
    if (!loop.far) loop.view.el.append(svg);
    loop.far = true;
    // (once it strays it's a lasso, however it ends; a box back from the screen's edge stays a box, its corner following)
    if (loop.kind === 'box' && !loop.back) loop.kind = gestureOf(path, SLOP_PX / book.scale).kind;
    drawLoop(loop);
  };
  const up = u => {
    lifted();
    const away = loop.far && u.pointerType === 'pen' && atEdge(u);
    if (!away) svg.remove();
    if (u.type === 'pointercancel' && !away) return;
    if (!loop.far) {
      if (!loop.down.shiftKey) letGo(sel);
      if (u.pointerType === 'pen') sel.clip.offer([loop.down.clientX, loop.down.clientY]);
      return;
    }
    pickIn(sel, loop);
    // (off the edge: what it holds is picked meanwhile, and the loop waits for the Pencil to come back)
    if (!away) return;
    sel.away = { loop, until: u.timeStamp + BACK_MS };
    setTimeout(() => sel.away?.loop === loop && unwait(sel), BACK_MS);
  };
  followPress(e, { move, up });
  return true;
}
function drawLoop({ kind, path, svg }) {
  const [a, b] = [path[0], path.at(-1)];
  svg.firstChild.setAttribute(
    'd',
    kind === 'box' ? `M${a[0]} ${a[1]}H${b[0]}V${b[1]}H${a[0]}Z` : `M${path.map(p => p.join(' ')).join('L')}Z`,
  );
}
// What's in a loop picked (with Shift, added)
function pickIn(sel, { view, kind, path, down }) {
  const poly = kind === 'box' ? gestureOf([path[0], path.at(-1)], Infinity).poly : path;
  const got = picked(poly, view.page, t => boxOfText(sel, t));
  if (down.shiftKey && sel.view === view)
    for (const k of ['ink', 'scraps', 'texts']) got[k] = [...new Set([...sel[k], ...got[k]])];
  choose(sel, view, got);
}
// A Pencil lifted at the screen's edge: it slid off the glass, still drawing the loop
const atEdge = e =>
  e.clientX < EDGE_PX || e.clientY < EDGE_PX || e.clientX > innerWidth - EDGE_PX || e.clientY > innerHeight - EDGE_PX;
// The Pencil back over the screen's edge soon after a loop went off it: the loop carries on from there (its press is
// the loop's, never a control's under it at the edge). Any other press ends the wait.
function comingBack(sel) {
  const swallow = e => e.isTrusted && e.stopPropagation();
  addEventListener(
    'pointerdown',
    e => {
      const away = sel.away;
      unwait(sel);
      if (!away || e.pointerType !== 'pen' || e.timeStamp > away.until || !atEdge(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // (nor the click the browser makes of it as it lifts)
      addEventListener('click', swallow, { capture: true, once: true });
      const { loop } = away;
      letGo(sel);
      if (loop.view !== sel.book.view() || !loop.view.el.isConnected) return;
      loop.view.el.append(loop.svg);
      loop.back = true;
      loop.path.push(pageOf(sel.book, e));
      drawLoop(loop);
      follow(sel, loop, e, () => setTimeout(() => removeEventListener('click', swallow, true)));
    },
    true,
  );
}

// No loop waiting at the screen's edge
function unwait(sel) {
  sel.away?.loop.svg.remove();
  sel.away = null;
}

// A point on screen as the page's px, off the paper too
export function pageOf(book, e) {
  const r = book.desk.getBoundingClientRect();
  return [book.pan.x + (e.clientX - r.left) / book.scale, book.pan.y + (e.clientY - r.top) / book.scale];
}

// ---- the selection

// Things on a view's page picked ({ ink, scraps, texts }, the page's own objects), framed; nothing picked lets go
export function choose(sel, view, { ink = [], scraps = [], texts = [] }) {
  if (!ink.length && !scraps.length && !texts.length) return letGo(sel);
  const fresh = !sel.frame || sel.view !== view;
  if (sel.view !== view) letGo(sel);
  Object.assign(sel, { view, ink, scraps, texts });
  framed(sel);
  if (fresh) sfx.tick();
}
function toggle(sel, view, { kind, item }) {
  if (sel.view !== view) letGo(sel);
  const now = { ink: sel.ink, scraps: sel.scraps, texts: sel.texts },
    has = now[kind].includes(item);
  now[kind] = has ? now[kind].filter(x => x !== item) : [...now[kind], item];
  choose(sel, view, now);
}
// Nothing picked (and no loop waiting at the screen's edge)
export function letGo(sel) {
  unwait(sel);
  sel.clip?.settle();
  sel.frame?.el.remove();
  sel.frame?.bar.remove();
  Object.assign(sel, { view: null, ink: [], scraps: [], texts: [], frame: null });
}
export const picks = sel => sel.ink.length + sel.scraps.length + sel.texts.length;
// The selection still the page's: on the page shown, its things still on it (a step undone, the eraser, words emptied
// away), else let go of what's gone
export function current(sel) {
  const v = sel.view;
  if (!v) return false;
  if (v !== sel.book.view() || !v.el.isConnected) {
    letGo(sel);
    return false;
  }
  const kept = k => sel[k].filter(x => (v.page[k] ?? []).includes(x));
  const was = picks(sel);
  Object.assign(sel, { ink: kept('ink'), scraps: kept('scraps'), texts: kept('texts') });
  if (!picks(sel)) letGo(sel);
  else if (picks(sel) !== was) framed(sel);
  return !!picks(sel);
}
export const bounds = sel => boundsOf(sel, t => boxOfText(sel, t));

// A box of words on its page: its words' own extent (measured on the page), or one line at its place before it shows
export function boxOfText(sel, t) {
  const el = textEl(sel.view ?? sel.book.view(), t),
    words = el?.words;
  const fallback = { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + LINE_PX };
  if (!words?.isConnected) return fallback;
  const range = document.createRange();
  range.selectNodeContents(words);
  const r = range.getBoundingClientRect(),
    page = el.view.el.getBoundingClientRect(),
    s = sel.book.scale;
  if (!r.width) return fallback;
  return {
    x0: (r.left - page.left) / s,
    y0: (r.top - page.top) / s,
    x1: (r.right - page.left) / s,
    y1: (r.bottom - page.top) / s,
  };
}
export const textEl = (view, t) =>
  [...(view?.el.querySelectorAll(':scope > .bk-typed') ?? [])].find(el => el.typed === t);

// ---- the frame

// The frame round what's picked, in the page's px (the book's pan and zoom carry it), its handles and its bar the same
// size on screen at any zoom (bookselect.css, --bk-scale)
export function framed(sel, b = bounds(sel)) {
  if (!sel.frame) {
    const el = document.createElement('div');
    el.className = 'bk-sel';
    el.innerHTML = [0, 1, 2, 3].map(c => `<i class="bk-sel-handle" data-corner="${c}"></i>`).join('');
    sel.frame = { el, bar: sel.clip.bar() };
  }
  const { el, bar } = sel.frame;
  // (appended once: a node put back starts its fade in again)
  if (el.parentNode !== sel.view.el) sel.view.el.append(el, bar);
  Object.assign(el.style, {
    left: `${b.x0}px`,
    top: `${b.y0}px`,
    width: `${b.x1 - b.x0}px`,
    height: `${b.y1 - b.y0}px`,
  });
  // (its bar under it, else over it, else over its foot, always where the paper shows it clear of the islands across
  // its rows: the strip's at its left too)
  const s = sel.book.scale,
    shown = sel.book.shown(),
    under = b.y1 + BAR.below / s < shown.y1,
    y = Math.min(under ? b.y1 : Math.max(b.y0, shown.y0 + BAR.above / s), shown.y1 - BAR.below / s),
    top = sel.book.desk.getBoundingClientRect().top + (y - shown.y0) * s,
    h = bar.offsetHeight,
    clear = clearShown(sel.book, under ? [top + BAR.gap, top + BAR.gap + h] : [top - BAR.gap - h, top - BAR.gap]),
    half = (bar.offsetWidth / 2 + BAR.side) / s,
    x = Math.min(Math.max((b.x0 + b.x1) / 2, clear.x0 + half), clear.x1 - half);
  bar.dataset.side = under ? 'under' : 'over';
  Object.assign(bar.style, { left: `${x}px`, top: `${y}px` });
}
// The frame shown at a box while the selection is held (its bar away), or back as it was
export function frameAt(sel, b) {
  if (!sel.frame) return;
  sel.frame.el.dataset.held = '';
  sel.frame.bar.dataset.held = '';
  Object.assign(sel.frame.el.style, {
    left: `${b.x0}px`,
    top: `${b.y0}px`,
    width: `${b.x1 - b.x0}px`,
    height: `${b.y1 - b.y0}px`,
  });
}
export function frameDown(sel) {
  if (!sel.frame) return;
  delete sel.frame.el.dataset.held;
  delete sel.frame.bar.dataset.held;
  framed(sel);
}

// ---- a change made

// One change to a view's page as a step for Undo (bookedit.js): act(page) replaces its things (swapIn) or adds new
// ones, and returns those to pick after
export function changed(sel, view, act) {
  const change = sel.hooks.begin(view);
  replaced(sel, view, act);
  change.end();
}
// A change made within a step already begun: the page grown to hold what it holds, the boxes it touched drawn again,
// and what act() returns picked (nothing: let go)
export function replaced(sel, view, act) {
  const page = view.page,
    was = view === sel.view && picks(sel) ? bounds(sel) : null;
  const after = act(page),
    now = boundsOf(after, t => boxOfText(sel, t));
  if (now) Object.assign(page, grownTo(page, now));
  redrawn(sel, view, was && now ? union(was, now) : (was ?? now));
  if (now) choose(sel, view, after);
  else letGo(sel);
}
// A page's things replaced by their new selves (a map from each to its new self), each in its place in its list
export function swapIn(page, swap) {
  for (const k of ['ink', 'scraps', 'texts']) {
    const list = (page[k] ??= []);
    list.splice(0, list.length, ...list.map(x => swap.get(x) ?? x));
  }
}
// A page's boxes drawn again after a change: its size laid, its tiles under the box and its words
export function redrawn(sel, view, box) {
  sel.hooks.lay();
  if (box) sel.hooks.redraw(view, box);
  sel.hooks.texts.added(view);
}

// ---- the cursor

// Over the selection or a thing a press would pick, a mouse's cursor shows it moves (bookselect.css, data-pick)
function hovering(sel) {
  const { book } = sel,
    desk = book.desk;
  desk.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || e.buttons || desk.dataset.tool !== 'select') return;
    const at = book.at(e.clientX, e.clientY),
      p = at && [at.x, at.y],
      page = at?.view.page;
    const over =
      !!page?.ink &&
      (onFrame(sel, p) || !!topAt(p, { ...page, texts: [] }, t => boxOfText(sel, t), NEAR_PX / book.scale));
    if (over) desk.dataset.pick = '';
    else delete desk.dataset.pick;
  });
  desk.addEventListener('pointerleave', () => delete desk.dataset.pick);
}
