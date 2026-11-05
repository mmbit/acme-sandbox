// HQ's viewer's More options: one quiet key on the bar whose menu holds what needn't always show there, the notebook's
// layout as a small picture of each arrangement the screen offers, and Share.
import { icon } from './icons.js';

// The pictures' height (px): the screen's own shape drawn round it, as wide as that makes it
const PICTURE_H = 40;
const NAMES = { over: 'Notebook over the page', beside: 'Notebook beside the page' };

// The key and its menu in the viewer v: the key after the bar's Note, the menu dropping from it. layouts(): the
// arrangements to draw as the menu opens (pictureOf's, each with book: 'over' | 'beside' and on), none where the screen
// offers no choice. pick(button): a picture tapped; share(): Share tapped. Returns { close }.
export function mountMore(v, { layouts, pick, share }) {
  const key = Object.assign(document.createElement('button'), { type: 'button', className: 'glyph more' }),
    menu = Object.assign(document.createElement('div'), { className: 'options', hidden: true });
  key.setAttribute('aria-label', 'More options');
  key.setAttribute('aria-haspopup', 'menu');
  key.setAttribute('aria-expanded', 'false');
  key.innerHTML = icon('more');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'More options');
  v.querySelector('.bar .pin').after(key);
  v.append(menu);
  const me = { key, menu, layouts, off: null };
  key.addEventListener('click', () => (menu.hidden ? open(me) : close(me)));
  menu.addEventListener('click', e => {
    const item = e.target.closest('[role^=menuitem]');
    if (!item) return;
    close(me);
    if (item.dataset.book) pick(item);
    else share();
  });
  menu.addEventListener('keydown', e => arrows(me, e));
  return { close: () => close(me) };
}

// Open: the pictures drawn for the screen as it is now, the picked one focused (or the first), and closed again by a tap
// outside, Escape, or the preview's frame taking the focus
function open(me) {
  const { key, menu } = me,
    pictures = me.layouts();
  menu.innerHTML =
    (pictures.length
      ? `<div class="layouts" role="group" aria-label="Notebook layout">${pictures.map(tile).join('')}</div>`
      : '') +
    `<button type="button" role="menuitem" class="share" tabindex="-1">${icon('share', 'ico')}<span>Share</span></button>`;
  menu.hidden = false;
  key.setAttribute('aria-expanded', 'true');
  (menu.querySelector('[aria-checked=true]') ?? menu.querySelector('[role^=menuitem]')).focus();
  const tap = e => !menu.contains(e.target) && !key.contains(e.target) && close(me, false),
    esc = e => e.key === 'Escape' && close(me),
    away = () => setTimeout(() => document.activeElement?.tagName === 'IFRAME' && close(me, false));
  addEventListener('pointerdown', tap, true);
  addEventListener('keydown', esc);
  addEventListener('blur', away);
  me.off = () => {
    removeEventListener('pointerdown', tap, true);
    removeEventListener('keydown', esc);
    removeEventListener('blur', away);
  };
}
// Closed, the focus back on the key unless something else took it
function close(me, refocus = true) {
  if (me.menu.hidden) return;
  me.off();
  me.menu.hidden = true;
  me.key.setAttribute('aria-expanded', 'false');
  if (refocus) me.key.focus();
}
// The menu's own keys: the arrows and Home and End go round its items, Tab leaves it closed
function arrows(me, e) {
  const items = [...me.menu.querySelectorAll('[role^=menuitem]')],
    at = items.indexOf(document.activeElement),
    step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (e.key === 'Tab') return close(me, false);
  const to = step ? (at + step + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null;
  if (to === null) return;
  e.preventDefault();
  items.at(to).focus();
}

// One layout's tile: its picture, its name for screen readers, the picked one checked
const tile = l =>
  `<button type="button" role="menuitemradio" data-book="${l.book}" aria-checked="${l.on}" aria-label="${NAMES[l.book]}" tabindex="-1">${pictureOf(l)}</button>`;

// A layout drawn in HQ's thin lines on the screen's shape: the screen, the page's frames in the room the page has (two
// side by side, two taking turns as tabs, or staging alone) and the notebook at the right, pinned beside the frames or
// lying over them, lower than their tops and cut out of them, so it reads on any look's tile. l: { book, aspect: the
// screen's width over its height, frames: 1 | 2, columns: whether two sit side by side, page: the page's share of the
// screen's width, notebook: the open notebook's share }. Its lines sit on whole pixels, crisp in every look.
function pictureOf(l) {
  const h = PICTURE_H,
    w = Math.round(h * Math.min(2, Math.max(1.3, l.aspect))),
    over = l.book === 'over',
    top = 9,
    bottom = h - 4,
    pageRight = (over ? w : Math.round(w * l.page)) - 4,
    bookLeft = Math.round(w - w * l.notebook),
    mid = Math.round((4 + pageRight) / 2),
    cut = `viewer-layout-${l.book}`;
  const frames =
    l.frames === 2 && l.columns
      ? [rect(4, top, mid - 2, bottom, 'frame'), rect(mid + 1, top, pageRight, bottom, 'frame')]
      : [
          // (two taking turns: the tabs over the one frame, the front one filled)
          ...(l.frames === 2 ? [rect(5, top - 4, 12, top - 1, 'tab on'), rect(14, top - 4, 21, top - 1, 'tab')] : []),
          rect(4, top, pageRight, bottom, 'frame'),
        ];
  const book = over ? { top: top + 4, bottom: h - 2 } : { top, bottom },
    ruled = [0.25, 0.42, 0.59, 0.76].map(f => {
      const y = Math.round(book.top + (book.bottom - book.top) * f) + 0.5;
      return `<line x1="${bookLeft + 4}" y1="${y}" x2="${w - 8}" y2="${y}"/>`;
    }),
    mask = over
      ? `<defs><mask id="${cut}"><rect width="${w}" height="${h}" fill="#fff"/><rect x="${bookLeft - 3}" y="${book.top - 2}" width="${w}" height="${h}"/></mask></defs>`
      : '',
    shadow = over
      ? `<rect class="shadow" x="${bookLeft - 2}" y="${book.top + 2}" width="2" height="${book.bottom - book.top - 1}"/>`
      : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${mask}${rect(0, 0, w - 1, h - 1, 'screen')}<g${over ? ` mask="url(#${cut})"` : ''}>${frames.join('')}</g>${shadow}${rect(bookLeft, book.top, w - 4, book.bottom, 'book')}<g class="ruled">${ruled.join('')}</g></svg>`;
}
// A rectangle from (x1, y1) to (x2, y2), its 1 px line on the pixels' middles
const rect = (x1, y1, x2, y2, cls) =>
  `<rect class="${cls}" x="${x1 + 0.5}" y="${y1 + 0.5}" width="${x2 - x1}" height="${y2 - y1}" rx="1.5"/>`;
