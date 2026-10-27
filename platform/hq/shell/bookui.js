// The book's controls, one style for all of them (bookui.css): a button with its icon or its word and the book's own
// tooltip, and the small islands the controls float on over the paper's right edge (faces at the top, then the tools,
// then Undo and Redo), the row at its foot, and the overview's own tools (Search, the phone). Every part of the book
// makes its controls here, so they look and answer alike. (the column cut to
// faces, tools and Undo: job #19861)
import { esc } from '../util.js';

// The islands, top to bottom over the paper's right edge, the pages' row at its foot, and the overview's tools (in its
// head, bookzoom.js). Each part appends its controls to its own.
const ISLANDS = ['faces', 'tools', 'book'],
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

// The island named (faces, tools or book in the stack at the right, pages the row at the foot, overview the overview's
// head): made once, in its place (islands(), which the rail puts over the paper; the overview's own, bookzoom.js). An
// island with nothing in it doesn't show. (overview)
let controls;
const made = new Map();
export function island(name) {
  if (!ISLANDS.includes(name) && name !== FOOT && name !== OVERVIEW) throw new Error(`No island ${name} in the book`);
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
  controls.append(stack, one(FOOT, true));
  one(OVERVIEW, true).classList.add('bk-far-tools');
  // A screen too short for one column even with the faces at their least: a second (bk-two, book.css). The stack's
  // width, one column or two, goes on the book as --bk-stack for what lies beside it: the page's heading, the pairing
  // card, the pages' row.
  const fit = new ResizeObserver(() => {
    const shown = shownIslands();
    if (!shown.length) return;
    const gaps = parseFloat(getComputedStyle(stack).rowGap) * (shown.length - 1);
    stack.classList.toggle('bk-two', shown.reduce((h, el) => h + least(el), gaps) > stack.clientHeight);
    const width = Math.round(stack.getBoundingClientRect().right - stackLeft());
    stack.closest('#book').style.setProperty('--bk-stack', `${width}px`);
  });
  for (const el of [stack, ...stack.children]) fit.observe(el);
  return controls;
}
// The stack's islands that show: one with nothing in it doesn't
const shownIslands = () => ISLANDS.map(name => made.get(name)).filter(el => el.offsetWidth);
// An island's height at its least: an island that shrinks (the faces') at its min-height, as it scrolls
function least(el) {
  const style = getComputedStyle(el);
  return (style.flexShrink !== '0' && parseFloat(style.minHeight)) || el.offsetHeight;
}
// The left edge on the screen of the islands' stack, one column or two (a short screen's second goes on to the left),
// or null while none shows.
export function stackLeft() {
  const shown = shownIslands();
  return shown.length ? Math.min(...shown.map(el => el.getBoundingClientRect().left)) : null;
}

// The book's tooltip on any element (a button, a face): its label, its keys quieter, beside it on the side with room
// (left of the islands), on hover and on a keyboard's focus; never title=. label may be a function, read each time.
let tipEl, shown, timer;
export function tip(el, label, keys = '') {
  el.removeAttribute('title');
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
    gap = 8;
  // left of it when there's room (the islands are at the paper's right), else right of it, else under it
  let x = r.left - gap - t.width,
    y = r.top + r.height / 2 - t.height / 2,
    side = 'left';
  if (x < 4) {
    x = r.right + gap;
    side = 'right';
    if (x + t.width > innerWidth - 4) {
      x = Math.min(innerWidth - 4 - t.width, Math.max(4, r.left + r.width / 2 - t.width / 2));
      y = r.bottom + gap;
      side = 'below';
    }
  }
  y = Math.max(4, Math.min(innerHeight - 4 - t.height, y));
  tipEl.dataset.side = side;
  tipEl.style.left = `${Math.round(x)}px`;
  tipEl.style.top = `${Math.round(y)}px`;
}
