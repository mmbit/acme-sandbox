// The book's controls, one style for all of them (bookui.css): a button with its icon or its word and the book's own
// tooltip, and the rail at the paper's right edge, by the spine, that holds every control there is: the tools
// (bookstrip.js), the book's own islands (Send; Tips and invites), the page's controls (bookcontrols.js) and, where
// the rail is too short for them all, More with the rarely used ones. The paper ends left of the rail
// (--bk-rail-width), so no control ever sits over what's written. Every part of the book makes its controls here, so
// they look and answer alike. (one rail at the spine)
import { esc } from '../../util.js';
import { CONTROLS } from './booklayout.js';
import { word } from './bookscope.js';

// The rail's islands top to bottom: the tools, Send, the page's controls, then the book's own (Tips); the overview's
// own tools (in its head, bookzoom.js). Each part appends its controls to its own.
const RAIL = ['tools', 'send', 'pages', 'book'],
  OVERVIEW = 'overview';
// How the rail fits, the roomiest that does (bookstrip.css): the pen and the marker side by side, the one in use alone,
// the rarely used folded into More, the page's arrows in More too, and those left closer together
const FITS = ['roomy', 'full', 'more', 'least', 'tight'];
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

// The island named (on the rail, or overview the overview's head): made once, in its place (islands(), which
// bookrail.js puts over the paper). An island with nothing in it doesn't show.
let controls;
const made = new Map();
export function island(name) {
  if (![...RAIL, OVERVIEW].includes(name)) throw new Error(`No island ${name} in the book`);
  islands();
  return made.get(name);
}
// The rail at the paper's right edge, for bookrail.js to place: its column of islands (.bk-column) and More at its
// foot. Cards, the page's targets and their asks hang on the rail beside the column (.bk-controls), over the paper.
export function islands() {
  if (controls) return controls;
  const div = name => Object.assign(document.createElement('div'), { className: name }),
    one = (name, orientation = 'vertical') => {
      const el = div('bk-island');
      el.dataset.island = name;
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-orientation', orientation);
      made.set(name, el);
      return el;
    };
  controls = div('bk-controls');
  const column = div('bk-column'),
    strip = div('bk-strip');
  column.setAttribute('data-keep-clear', ''); // (a minimised call keeps clear of it.)
  strip.append(one('tools'));
  column.append(strip, ...RAIL.slice(1).map(name => one(name)), moreButton());
  controls.append(column);
  one(OVERVIEW, 'horizontal').classList.add('bk-far-tools');
  watchFit(column);
  return controls;
}
// The rail fitted (data-fit) whenever it or what shows on it changes: the roomiest of FITS that's no taller than it.
function watchFit(column) {
  let frame = 0;
  const fit = () => {
    frame = 0;
    if (!column.offsetHeight) return;
    for (const level of FITS) {
      column.dataset.fit = level;
      if (column.scrollHeight <= column.clientHeight) return;
    }
  };
  // (fitted in the frame after, never in the observer's own call: what fit sets sizes what it watches)
  const soon = () => (frame ||= requestAnimationFrame(fit));
  new ResizeObserver(soon).observe(column);
  new MutationObserver(soon).observe(column, { subtree: true, childList: true, attributeFilter: ['hidden'] });
}
// More: the rarely used controls the rail has folded away (bookstrip.css .bk-rare), on a card beside it, each
// pressing its own on the rail
function moreButton() {
  const more = button({
    icon: lineIcon(
      '<circle cx="12" cy="5.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="18.5" r="1.2"/>',
    ),
    label: word('More'),
    onClick: () => moreCard(more),
  });
  more.classList.add('bk-more');
  more.setAttribute('aria-haspopup', 'menu');
  return more;
}
function moreCard(more) {
  if (more.card) return more.card.close();
  hide();
  const folded = [...controls.querySelectorAll('.bk-column .bk-btn')].filter(
    b => b !== more && b.offsetParent === null && !b.closest('[hidden]') && b.matches(FOLDED),
  );
  const card = Object.assign(document.createElement('div'), { className: 'bk-card bk-menu bk-more-card' });
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', word('More'));
  for (const real of folded) {
    const label = real.getAttribute('aria-label'),
      item = Object.assign(document.createElement('button'), { type: 'button' });
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `${real.querySelector('svg')?.outerHTML ?? ''}<span>${esc(label)}</span>`;
    item.addEventListener('click', () => {
      close();
      real.click();
    });
    card.append(item);
  }
  const away = e => {
    if (e.type === 'keydown' ? e.key === 'Escape' : !(card.contains(e.target) || more.contains(e.target))) close();
  };
  const close = () => {
    card.remove();
    more.card = null;
    more.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', away, true);
    removeEventListener('keydown', away, true);
  };
  more.card = { close };
  more.setAttribute('aria-expanded', 'true');
  besideRail(card, more);
  card.querySelector('button')?.focus({ preventScroll: true });
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', away, true);
}
// What More can fold away (bookstrip.css hides them on the rail as it fits)
const FOLDED = '.bk-rare, .bk-turns, [data-island=book] > *';
// A card of the rail's (a tool's colours and widths, this device's preferences, the pages, More): on the paper left
// of the rail, level with from, the control that opened it (More's, when the rail has folded it away). It hangs on
// the rail, never in an island, and CSS keeps it beside it (bookstrip.css).
export function besideRail(card, from) {
  controls.append(card);
  const at = from.offsetParent ? from : controls.querySelector('.bk-more'),
    rail = controls.getBoundingClientRect(),
    r = at.getBoundingClientRect(),
    middle = r.top + r.height / 2 - rail.top,
    top = Math.max(8, Math.min(rail.height - card.offsetHeight - 8, middle - card.offsetHeight / 2));
  card.style.top = `${Math.round(top)}px`;
}
// The x a paper this wide keeps clear left of the controls at its right edge (--bk-controls-width, as the book last
// measured it on el or an element in it, CONTROLS.width until it has, and CONTROLS.clear from the edge). Answers,
// versions and scraps fitted to the paper keep left of it.
export function clearOf(el, paper) {
  const width = parseFloat(getComputedStyle(el).getPropertyValue('--bk-controls-width'));
  return paper - (Number.isNaN(width) ? CONTROLS.width : width) - CONTROLS.clear;
}

// The book's tooltip on any element (a button, a face): its label, its keys quieter, beside it on the side with room
// (left of the rail; above the overview's row), on hover and on a keyboard's focus; never title=. label
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
  // in a row (the overview's), above it, over none of its controls; under it when there's no room above
  if (row) {
    const box = row.getBoundingClientRect(),
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
