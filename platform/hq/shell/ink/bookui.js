// The book's controls, one style for all of them (bookui.css): a button with its icon or its word and the book's own
// tooltip, and the islands floating over the paper (README, The book's frame): the tools on the right, upright and
// centred (bookstrip.js), one bar along the foot between the screen's corners, the overview's key at its left, the
// page's arrows and "3 / 12" in its middle, its dots menu at its right with whatever there's no room for
// (bookcontrols.js), a guest's Undo of its send in Send's place (bookrail.js). The tools are an
// opened scrap's, and what's written there ends left of them (--bk-rail-width), the paper running on under them to
// the screen's edge. Every part of the book makes its controls here, so they look and answer alike. Only the page is
// paper; the controls are HQ's.
import { esc } from '../../util.js';
import { icon } from '../icons.js';
import { word } from './bookscope.js';

// The islands and their groups: the tools; on the bar the page's own keys (keys: the overview at its left, New page in
// the dots), the page's arrows and where it is (pages), a guest's Send and its Undo (history); the dots
// menu's own rows (menu: the page's, book: the book's, Preferences to Close); the overview's tools in its head
// (bookzoom.js).
const BAR = ['history', 'pages', 'keys', 'send', 'menu', 'book'],
  OVERVIEW = 'overview';
// A tooltip shows after the pointer rests this long on a control (at once on a keyboard's focus, and on the next
// control while one is showing)
const TIP_MS = 350;

// ⌘ on Apple's keyboards, Ctrl elsewhere: for keys = `${MOD}+` and the like
export const MOD = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

// A control: <button class="bk-btn"> with icon (an SVG string) or text (a word: the variant with its label on it),
// named label for a screen reader and in its tooltip (keys after it, quieter; a new aria-label is the tooltip's too). pressed (true or false) makes it a
// toggle (aria-pressed: setPressed). onClick(e) when it's pressed, heard as every press in the book is (booksounds.js:
//).
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

// The island or group named: made once, in its place (islands(), which bookrail.js puts over the paper)
let controls, more;
// The dots at the bar's right end, where the focus goes back to from a row's own card or field (bookcontrols.js)
export const moreKey = () => more;
const made = new Map();
export function island(name) {
  if (!['tools', ...BAR, OVERVIEW].includes(name)) throw new Error(`No island ${name} in the book`);
  islands();
  return made.get(name);
}
// The controls over the paper, for bookrail.js to place: the tools' island (.bk-strip) and the bar along the foot
// (.bk-bar), its three parts laid out so the page's arrows and where it is sit in its very middle. Cards hang beside
// them (beside()), over the paper.
export function islands() {
  if (controls) return controls;
  const div = (className, html = '') => Object.assign(document.createElement('div'), { className, innerHTML: html }),
    one = (name, { role = 'group', orientation = 'horizontal' } = {}) => {
      const el = div('bk-island');
      el.dataset.island = name;
      el.setAttribute('role', role);
      if (role === 'toolbar') el.setAttribute('aria-orientation', orientation);
      made.set(name, el);
      return el;
    };
  controls = div('bk-controls');
  const strip = div('bk-strip'),
    foot = div('bk-foot'),
    bar = div('bk-bar'),
    [start, middle, end] = ['start', 'middle', 'end'].map(part => div(`bk-bar-${part}`)),
    hidden = div('bk-menu-only');
  for (const el of [strip, bar]) {
    el.setAttribute('data-no-ink', '');
    el.setAttribute('data-keep-clear', ''); // (a minimised call keeps clear of them.)
  }
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-orientation', 'horizontal');
  bar.setAttribute('aria-label', word('notebookPages'));
  strip.append(one('tools', { role: 'toolbar', orientation: 'vertical' }));
  hidden.hidden = true;
  hidden.append(one('menu'), one('book'));
  more = moreButton();
  // (the bar as drawn, the Ink README's The book's frame: the overview's key, the arrows and "3 / 12" in the middle, the
  // dots.)
  start.append(one('keys'));
  middle.append(one('pages'));
  end.append(one('send'), one('history'), more, hidden);
  bar.append(start, middle, end);
  foot.append(bar);
  controls.append(strip, foot);
  one(OVERVIEW, { role: 'toolbar' }).classList.add('bk-far-tools');
  return controls;
}
// The dots at the bar's right end: a menu of the page's keys kept off the bar (.bk-rare: New page), then the
// page's own rows (Rename page first, Tear off and send, Archive this page) and the book's (Preferences, Sign in
// another device, Tips), each pressing its own. The pull tab closes the book (bookhandle.js).
function moreButton() {
  const b = button({
    icon: icon('more'),
    label: word('more'),
    onClick: () => moreCard(b),
  });
  b.classList.add('bk-more');
  b.setAttribute('aria-haspopup', 'menu');
  return b;
}
function moreCard(from) {
  if (from.card) return from.card.close();
  hide();
  const usable = b => !b.disabled && !b.hidden,
    folded = [...made.get('keys').querySelectorAll('.bk-rare')].filter(b => usable(b) && b.offsetParent === null),
    // (Rename page first of the page's rows, whatever's put before it: the tear's.)
    page = [...made.get('menu').children].sort((a, b) => b.matches('.bk-rename') - a.matches('.bk-rename')),
    groups = [folded, page, [...made.get('book').children]]
      .map(list => list.filter(usable))
      .filter(list => list.length);
  const card = Object.assign(document.createElement('div'), { className: 'bk-card bk-menu bk-more-card' });
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', word('more'));
  groups.forEach((list, i) => {
    if (i) card.append(document.createElement('hr'));
    for (const real of list) {
      const item = Object.assign(document.createElement('button'), { type: 'button' });
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `${real.querySelector('svg')?.outerHTML ?? ''}<span>${esc(real.getAttribute('aria-label'))}</span>`;
      item.addEventListener('click', () => {
        close();
        real.click();
      });
      card.append(item);
    }
  });
  const away = e => {
    if (e.type === 'keydown' ? e.key === 'Escape' : !(card.contains(e.target) || from.contains(e.target))) close();
  };
  const close = () => {
    card.remove();
    from.card = null;
    from.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', away, true);
    removeEventListener('keydown', away, true);
  };
  from.card = { close };
  from.setAttribute('aria-expanded', 'true');
  beside(card, from);
  card.querySelector('button')?.focus({ preventScroll: true });
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', away, true);
}
// A card of the controls' (a tool's colours and widths, this device's preferences, the pages, the dots menu): on the
// paper beside from, the control that opened it (the dots, when it's one of their rows): left of the tools, level
// with it; above the bar, its right edge at the control's. It stays on the screen, under nothing, placed again while
// it's open as the screen turns, the book's width changes or the card's own size does.
export function beside(card, from) {
  controls.append(card);
  placed(card, from);
  const again = new ResizeObserver(() => (card.isConnected ? placed(card, from) : again.disconnect()));
  again.observe(controls);
  again.observe(card);
}
function placed(card, from) {
  const at = from.offsetParent ? from : more,
    room = controls.getBoundingClientRect(),
    r = at.getBoundingClientRect(),
    gap = 8,
    bar = !at.closest('.bk-strip') && at.closest('.bk-bar').getBoundingClientRect();
  // (a bar's card ends above the bar, scrolling where it's taller than the room there: the control that opened it
  // stays in reach to close it.)
  if (bar) card.style.maxHeight = `${Math.round(bar.top - room.top - 2 * gap)}px`;
  const w = card.offsetWidth,
    h = card.offsetHeight;
  let left, top;
  if (!bar) {
    const tools = at.closest('.bk-strip').getBoundingClientRect();
    left = tools.left - gap - w - room.left;
    top = r.top + r.height / 2 - h / 2 - room.top;
  } else {
    left = r.right + 6 - w - room.left;
    top = bar.top - gap - h - room.top;
  }
  card.style.left = `${Math.round(Math.max(gap, Math.min(room.width - w - gap, left)))}px`;
  card.style.top = `${Math.round(Math.max(gap, Math.min(room.height - h - gap, top)))}px`;
}
// The book's tooltip on any element (a button, a face): its label, its keys quieter, beside it on the side with room
// (left of the tools; above a row: the bar, the overview's), on hover and on a keyboard's focus; never title=. label
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
// An element's tooltip at once, wherever the pointer is (a finger sliding along the tools: bookstrip.js).
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
