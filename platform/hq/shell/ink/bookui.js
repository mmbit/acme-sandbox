// The book's controls, one style for all of them (bookui.css): a button with its icon or its word and the book's own
// tooltip, and the lane at the paper's foot that holds every control there is: the tool rail (bookstrip.js) and the
// book's own islands beside it (Send; Tips and invites) where they fit, on a line of their own above the page
// bar where they don't, and the page bar (bookcontrols.js) under them. The page's scroll ends above the lane
// (--bk-foot), so no control ever sits over what's written. Every part of the book makes its controls here, so they
// look and answer alike.
import { esc, resizedNextFrame } from '../../util.js';
import { CONTROLS } from './booklayout.js';

// The book's own islands (Send, then Tips), the tool rail and the page bar in the lane at the foot; the
// overview's own tools (in its head, bookzoom.js). Each part appends its controls to its own.
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

// The island named (send or book beside the rail, tools the rail and pages the bar in the lane at the foot, overview
// the overview's head): made once, in its place (islands(), which bookrail.js puts over the paper). An island with
// nothing in it doesn't show.
let controls;
const made = new Map();
export function island(name) {
  if (!ISLANDS.includes(name) && ![STRIP, FOOT, OVERVIEW].includes(name))
    throw new Error(`No island ${name} in the book`);
  islands();
  return made.get(name);
}
// The lane of controls at the paper's foot, for the rail to place (bookrail.js): a line of the rail (.bk-strip, which
// its cards hang over) and the book's own islands (.bk-islands), wrapping where the paper's too narrow for both, and
// the page bar under it, all across
export function islands() {
  if (controls) return controls;
  const div = name => Object.assign(document.createElement('div'), { className: name }),
    one = name => {
      const el = div('bk-island');
      el.dataset.island = name;
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-orientation', 'horizontal');
      made.set(name, el);
      return el;
    };
  controls = div('bk-controls');
  const lane = div('bk-lane'),
    line = div('bk-lane-line'),
    strip = div('bk-strip'),
    stack = div('bk-islands');
  strip.append(one(STRIP));
  stack.append(...ISLANDS.map(one));
  line.append(strip, stack);
  lane.append(line, one(FOOT));
  controls.append(lane);
  one(OVERVIEW).classList.add('bk-far-tools');
  watchFit(lane);
  return controls;
}
// The lane's height, from its top to the paper's foot, on the book as --bk-foot whenever it resizes: the page's scroll
// area ends above it (bookpages.js). Nothing floats over the paper's right edge any more, so --bk-controls-width, what
// answers and scraps keep clear of there, is 0.
function watchFit(lane) {
  const fit = () => {
    const book = lane.closest('#book');
    // (in layout px, never the screen's: the book's parts are turned and scaled while it swings, and nothing resizes as
    // it comes to rest.)
    if (!book || !lane.offsetHeight) return;
    book.style.setProperty('--bk-foot', `${lane.offsetHeight}px`);
    if (book.style.getPropertyValue('--bk-controls-width') === '0px') return;
    book.style.setProperty('--bk-controls-width', '0px');
    book.dispatchEvent(new Event('bk:controls-width'));
  };
  // (a frame later, never in the observer's own call: what fit sets sizes what it watches.)
  resizedNextFrame([lane], fit);
}
// A card of the rail's (the tool's colours and widths, this device's preferences): over the rail, centred on it, on
// the paper above the lane. It hangs on the rail's wrapper, never in the island, and CSS places it (bookstrip.css).
export function overRail(card) {
  made.get(STRIP).parentElement.append(card);
}
// The x a paper this wide keeps clear left of the controls at its right edge (--bk-controls-width, as the book last
// measured it on el or an element in it, CONTROLS.width until it has, and CONTROLS.clear from the edge). Answers,
// versions and scraps fitted to the paper keep left of it.
export function clearOf(el, paper) {
  const width = parseFloat(getComputedStyle(el).getPropertyValue('--bk-controls-width'));
  return paper - (Number.isNaN(width) ? CONTROLS.width : width) - CONTROLS.clear;
}
// The left edge on the screen of controls over the paper's right edge: null, as none float there now (all are in the
// lane at the foot, which the page ends above). Kept for the parts that keep clear of it (bookgroupshow.js,
// booktools.js, clearShown).
export const controlsLeft = () => null;
// The part of the page shown that the paper shows clear of controls over it (page px): all of it, the controls being
// in their own lane. The selection's bar keeps to it (bookselect.js), and taped pictures (booktape.js).
export const clearShown = book => book.shown();

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
// An element's tooltip at once, wherever the pointer is (a finger sliding along the rail: bookstrip.js).
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
  // in a row (the lane's, the overview's), above the whole lane, over none of its controls; under it when there's no
  // room above
  if (row) {
    const box = (row.closest('.bk-lane') ?? row).getBoundingClientRect(),
      above = box.top - gap - t.height >= 4,
      top = above ? box.top - gap - t.height : box.bottom + gap,
      end = innerWidth - 4;
    return put(
      Math.max(4, Math.min(end - t.width, r.left + r.width / 2 - t.width / 2)),
      top,
      above ? 'above' : 'below',
    );
  }
  // left of it when there's room, else right of it, else under it
  let y = r.top + r.height / 2 - t.height / 2;
  let x = r.left - gap - t.width,
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
