// The book's controls, one style for all of them (bookui.css): a button with its icon or its word and the book's own
// tooltip, and the small islands the controls float on over the paper's right edge (Undo and Redo), the row at its
// foot, and the overview's own tools (Search). Every part of the book makes its controls here, so they look and answer
// alike. (the column cut to faces, tools and Undo: job #19861; the faces gone: job #20780)
import { esc } from '../../util.js';
import { CONTROLS } from './booklayout.js';

// The islands, top to bottom over the paper's right edge, the tool strip down it beside them (bookstrip.js), the pages'
// row at its foot, and the overview's tools (in its head, bookzoom.js). Each part appends its controls to its own. (the
// strip: the board's tools, by Undo's on every device, so the page keeps its width) (the faces gone with the sheets) (Send at the stack's top)
const ISLANDS = ['send', 'book'],
  STRIP = 'tools',
  FOOT = 'pages',
  OVERVIEW = 'overview';
// A tooltip shows after the pointer rests this long on a control (at once on a keyboard's focus, and on the next
// control while one is showing)
const TIP_MS = 350;

// ⌘ on Apple's keyboards, Ctrl elsewhere: for keys = `${MOD}+` and the like
export const MOD = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

// A control: <button class="bk-btn"> with icon (an SVG string) or text (a word: the variant with its label on it),
// named label for a screen reader and in its tooltip (keys after it, quieter; a new aria-label is the tooltip's too). pressed (true or false) makes it a
// toggle (aria-pressed: setPressed). onClick(e) when it's pressed.
export function button({ icon = '', text = '', label = text, keys = '', onClick, pressed } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = text ? 'bk-btn bk-text' : 'bk-btn';
  b.setAttribute('aria-label', label);
  b.innerHTML = text ? `${icon}<span>${esc(text)}</span>` : icon;
  if (pressed != null) setPressed(b, pressed);
  if (onClick) b.addEventListener('click', onClick);
  // a word's button says itself: its tooltip is only for its keys
  if (!text || keys) tip(b, () => b.getAttribute('aria-label'), keys);
  return b;
}
export const setPressed = (b, on) => b.setAttribute('aria-pressed', on ? 'true' : 'false');
// An icon in the controls' own line (d: its shapes, on a 24 px square)
export const lineIcon = d =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</g></svg>`;

// The island named (send or book in the stack at the right, tools the strip beside it, pages the row at the foot,
// overview the overview's head): made once, in its place (islands(), which the rail puts over the paper; the overview's own, bookzoom.js). An
// island with nothing in it doesn't show. (overview)
let controls;
const made = new Map();
export function island(name) {
  if (!ISLANDS.includes(name) && ![STRIP, FOOT, OVERVIEW].includes(name))
    throw new Error(`No island ${name} in the book`);
  islands();
  return made.get(name);
}
// All the islands over the paper, for the rail to place (bookrail.js)
export function islands() {
  if (controls) return controls;
  controls = document.createElement('div');
  controls.className = 'bk-controls';
  const stack = document.createElement('div');
  stack.className = 'bk-islands';
  const one = (name, across) => {
    const el = document.createElement('div');
    el.className = 'bk-island';
    el.dataset.island = name;
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-orientation', across ? 'horizontal' : 'vertical');
    made.set(name, el);
    return el;
  };
  stack.append(...ISLANDS.map(name => one(name, false)));
  // (the strip: its island, and the tool in use named beside it.)
  const strip = document.createElement('div');
  strip.className = 'bk-strip';
  strip.append(one(STRIP, false));
  controls.append(stack, strip, one(FOOT, true));
  one(OVERVIEW, true).classList.add('bk-far-tools');
  // A screen too short for one column even with the faces at their least: a second (bk-two, book.css). The stack's
  // width, one column or two, goes on the book as --bk-islands, for the strip beside it (bookstrip.css). The controls'
  // width, the stack's and the strip's, goes on it as --bk-controls-width for what lies beside them: the pairing card,
  // answers; and the width of the ones beside the pages' row as --bk-foot, which
  // the row keeps clear of.
  const fit = new ResizeObserver(() => {
    const shown = shownIslands();
    if (!shown.length) return;
    const gaps = parseFloat(getComputedStyle(stack).rowGap) * (shown.length - 1);
    stack.classList.toggle('bk-two', shown.reduce((h, el) => h + least(el), gaps) > stack.clientHeight);
    // (in layout px, never the screen's: the book's parts are turned and scaled while it swings, and nothing resizes as
    // it comes to rest.)
    const book = stack.closest('#book'),
      right = laid(stack).right,
      own = Math.min(...shown.map(el => laid(el).left));
    book.style.setProperty('--bk-islands', `${Math.round(right - own)}px`);
    const foot = laid(made.get(FOOT)),
      besideFoot = controlsLeft([foot.top, foot.bottom], laid) ?? right;
    if (foot.bottom > foot.top) book.style.setProperty('--bk-foot', `${Math.round(right - besideFoot)}px`);
    // (told when it changes: the answers lie left of it, drawn again.)
    const width = `${Math.round(right - controlsLeft(null, laid))}px`;
    if (book.style.getPropertyValue('--bk-controls-width') === width) return;
    book.style.setProperty('--bk-controls-width', width);
    book.dispatchEvent(new Event('bk:controls-width'));
  });
  for (const el of [stack, ...stack.children, made.get(STRIP), made.get(FOOT)]) fit.observe(el);
  return controls;
}
// A card of the tool strip's (the colours, the preferences) on the paper beside it, level with the strip's island at
// its top or its foot (end: 'top' | 'bottom') and inside the strip's height. It hangs on the strip, never in the
// island: a short screen's island scrolls, and its scrolling cuts off whatever sticks out of it. Placed again while
// it's open whenever the strip resizes (the iPad turning moves the island).
export function besideStrip(card, end) {
  const tools = made.get(STRIP),
    strip = tools.parentElement;
  strip.append(card);
  const place = () => {
    const room = strip.getBoundingClientRect(),
      seen = tools.getBoundingClientRect(),
      top = end === 'top' ? seen.top - room.top : seen.bottom - room.top - card.offsetHeight;
    card.style.top = `${Math.round(Math.max(0, Math.min(top, strip.clientHeight - card.offsetHeight)))}px`;
  };
  place();
  const resized = new ResizeObserver(() => (card.isConnected ? place() : resized.disconnect()));
  resized.observe(strip);
}
// The stack's islands that show: one with nothing in it doesn't
const shownIslands = () => ISLANDS.map(name => made.get(name)).filter(el => el.offsetWidth);
// The controls over the paper's right edge that show: the stack's islands and the tool strip beside them
const shownControls = () => [...shownIslands(), made.get(STRIP)].filter(el => el.offsetWidth);
// An island's height at its least: an island that shrinks (the faces') at its min-height, as it scrolls
function least(el) {
  const style = getComputedStyle(el);
  return (style.flexShrink !== '0' && parseFloat(style.minHeight)) || el.offsetHeight;
}
// The x a paper this wide keeps clear left of the controls at its right edge: their width (--bk-controls-width, as the
// book last measured it on el or an element in it; CONTROLS.width until it has) and CONTROLS.clear from the paper's
// edge. Answers, versions and scraps fitted to the paper keep left of it.
export const clearOf = (el, paper) =>
  paper - (parseFloat(getComputedStyle(el).getPropertyValue('--bk-controls-width')) || CONTROLS.width) - CONTROLS.clear;
// The left edge on the screen of the controls: the islands' stack, one column or two (a short screen's second goes on
// to the left), and the tool strip beside it, or null while none shows. rows ([top, bottom] on the screen): only the
// islands across them. box: where an element is, the screen's by default, or laid's.
export function controlsLeft(rows = null, box = el => el.getBoundingClientRect()) {
  const shown = shownControls()
    .map(box)
    .filter(r => across(r, rows));
  return shown.length ? Math.min(...shown.map(r => r.left)) : null;
}
// Where an element is laid out on the page, as if nothing were transformed
function laid(el) {
  let left = 0,
    top = 0;
  for (let at = el; at; at = at.offsetParent) {
    left += at.offsetLeft;
    top += at.offsetTop;
  }
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
}
// The part of the page shown that the paper shows clear of the islands over its right edge, the stack and the tool
// strip (page px); with rows, of those across them only. The selection's bar keeps to it too (bookselect.js).
export function clearShown(book, rows = null) {
  const view = book.shown(),
    desk = book.desk.getBoundingClientRect(),
    right = Math.max(0, desk.right - (controlsLeft(rows) ?? desk.right));
  return { ...view, x1: view.x1 - right / (book.scale || 1) };
}
const across = (r, rows) => !rows || (r.bottom > rows[0] && r.top < rows[1]);

// The book's tooltip on any element (a button, a face): its label, its keys quieter, beside it on the side with room
// (left of the islands and the strip; above the pages' row), on hover and on a keyboard's focus; never title=. label
// may be a function, read each time.
let tipEl, shown, timer;
export function tip(el, label, keys = '') {
  el.removeAttribute('title');
  // (what showTip opens.)
  el.bkTip = () => [typeof label === 'function' ? label() : label, keys];
  const show = now => {
    clearTimeout(timer);
    timer = setTimeout(() => open(el, typeof label === 'function' ? label() : label, keys), now || shown ? 0 : TIP_MS);
  };
  // (never mid-press: a control dragged under the pointer, the book's handle, says nothing.)
  el.addEventListener('pointerenter', e => e.pointerType === 'mouse' && !e.buttons && show(false));
  el.addEventListener('pointerleave', hide);
  el.addEventListener('pointerdown', hide);
  el.addEventListener('focus', () => el.matches(':focus-visible') && show(true));
  el.addEventListener('blur', hide);
  el.addEventListener('keydown', e => e.key === 'Escape' && hide());
}
export function hide() {
  clearTimeout(timer);
  if (!tipEl || tipEl.hidden) return;
  tipEl.hidden = true;
  // a moment's grace: the next control's tip shows at once
  timer = setTimeout(() => (shown = false), 200);
}
// An element's tooltip at once, wherever the pointer is (a finger sliding along the strip: bookstrip.js).
export function showTip(el) {
  clearTimeout(timer);
  if (el?.bkTip) open(el, ...el.bkTip());
}
function open(el, label, keys) {
  if (!el.isConnected || !label) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'bk-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.id = 'bk-tip';
    (document.getElementById('book') ?? document.body).append(tipEl);
  }
  tipEl.innerHTML = `<span>${esc(label)}</span>${keys ? `<kbd>${esc(keys)}</kbd>` : ''}`;
  tipEl.hidden = false;
  shown = true;
  const r = el.getBoundingClientRect(),
    t = tipEl.getBoundingClientRect(),
    gap = 8,
    row = el.closest('[aria-orientation=horizontal]');
  // in a row (the pages' at the paper's foot), above the whole row, over none of its controls; under it when there's
  // no room above. Left of the stack and the strip where they reach its height, as the islands' tips are
  if (row) {
    const box = row.getBoundingClientRect(),
      above = box.top - gap - t.height >= 4,
      top = above ? box.top - gap - t.height : box.bottom + gap,
      end = Math.min(innerWidth - 4, (controlsLeft([top, top + t.height]) ?? innerWidth) - gap);
    return put(
      Math.max(4, Math.min(end - t.width, r.left + r.width / 2 - t.width / 2)),
      top,
      above ? 'above' : 'below',
    );
  }
  // left of it when there's room (the islands are at the paper's right), and of every control beside it there (the
  // stack's and the strip's: never over a tool), else right of it, else under it
  let y = r.top + r.height / 2 - t.height / 2,
    x =
      (el.closest('.bk-islands, .bk-strip') ? Math.min(r.left, controlsLeft([y, y + t.height]) ?? r.left) : r.left) -
      gap -
      t.width,
    side = 'left';
  if (x < 4 || x + t.width > innerWidth - 4) {
    x = r.right + gap;
    side = 'right';
    if (x + t.width > innerWidth - 4) {
      x = Math.min(innerWidth - 4 - t.width, Math.max(4, r.left + r.width / 2 - t.width / 2));
      y = r.bottom + gap;
      side = 'below';
    }
  }
  put(x, Math.max(4, Math.min(innerHeight - 4 - t.height, y)), side);
}
function put(x, y, side) {
  tipEl.dataset.side = side;
  tipEl.style.left = `${Math.round(x)}px`;
  tipEl.style.top = `${Math.round(y)}px`;
}
