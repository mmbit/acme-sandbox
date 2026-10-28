// A page of the overview's grid dragged to another place (bookshelf.js): held a moment first with a finger, so a
// finger still scrolls, at once with a mouse or a pen; the others slide aside where it would land. And the tiles
// sliding to their new places as the grid changes. s: bookshelf.js's screens.
import { moved, slotAt } from './bookshelfgrid.js';

// a finger held this long, moving no more than SLOP_PX, picks a page up; a mouse or a pen moving DRAG_PX does
const HOLD_MS = 300,
  SLOP_PX = 8,
  DRAG_PX = 6;
// a dragged page this near the overview's top or bottom scrolls it, this much a move
const EDGE_PX = 56,
  SCROLL_PX = 14;
// the tiles sliding to their new places (a page moved or archived): quick, never waited on
const SLIDE_MS = 160;

export function drags(s, dropped) {
  const { far } = s;
  far.addEventListener('pointerdown', e => {
    const tile = e.target.closest('.bk-tile[data-drag]');
    if (!tile || e.target.closest('.bk-tile-act') || e.button > 0 || !e.isPrimary || s.press) return;
    const d = { tile, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, touch: e.pointerType === 'touch' };
    if (d.touch) d.hold = setTimeout(() => lift(s, d), HOLD_MS);
    s.press = d;
  });
  addEventListener('pointermove', e => {
    const d = s.press;
    if (!d || e.pointerId !== d.pointer) return;
    if (!d.lifted) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < (d.touch ? SLOP_PX : DRAG_PX)) return;
      // (a finger moving before it's held is a scroll)
      if (d.touch) return cancel(s);
      lift(s, d);
    }
    follow(s, d, e);
  });
  const up = e => {
    const d = s.press;
    if (!d || e.pointerId !== d.pointer) return;
    if (!d.lifted || e.type === 'pointercancel') return cancel(s);
    const { from, to } = d;
    cancel(s);
    // (the click that follows a drop opens nothing)
    s.swallow = true;
    setTimeout(() => (s.swallow = false));
    dropped(from, to);
  };
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  // (a page picked up by a finger: the finger moves it, never the overview's scroll)
  far.addEventListener('touchmove', e => s.press?.lifted && e.cancelable && e.preventDefault(), { passive: false });
  far.addEventListener('contextmenu', e => s.press && e.preventDefault());
}
// The page picked up: lifted off the grid, the others' places known
function lift(s, d) {
  clearTimeout(d.hold);
  const grid = d.tile.parentElement,
    tiles = [...grid.querySelectorAll('.bk-tile[data-drag]')],
    style = getComputedStyle(grid);
  Object.assign(d, {
    lifted: true,
    grid,
    tiles,
    from: tiles.indexOf(d.tile),
    to: tiles.indexOf(d.tile),
    scroll: s.far.scrollTop,
    geo: {
      cols: Number(grid.style.getPropertyValue('--cols')) || 1,
      w: d.tile.offsetWidth,
      h: d.tile.offsetHeight,
      gap: parseFloat(style.columnGap) || 0,
      rowGap: parseFloat(style.rowGap) || 0,
    },
  });
  grid.classList.add('bk-dragging');
  d.tile.classList.add('bk-lifted');
  navigator.vibrate?.(8);
}
// The lifted page under the pointer, the others making room where it would land
function follow(s, d, e) {
  const { far } = s,
    box = far.getBoundingClientRect();
  if (e.clientY < box.top + EDGE_PX) far.scrollTop -= SCROLL_PX;
  else if (e.clientY > box.bottom - EDGE_PX) far.scrollTop += SCROLL_PX;
  const dx = e.clientX - d.x0,
    dy = e.clientY - d.y0 + far.scrollTop - d.scroll;
  d.tile.style.transform = `translate(${dx}px, ${dy}px) scale(1.04) rotate(-1.5deg)`;
  const { cols, w, h, gap, rowGap } = d.geo,
    // (the middle of the lifted page decides where it lands)
    from = d.tiles[d.from],
    // (its place in the grid: both are placed in the overview)
    x = from.offsetLeft - d.grid.offsetLeft + w / 2 + dx,
    y = from.offsetTop - d.grid.offsetTop + h / 2 + dy;
  const to = slotAt(x, y, d.geo, d.tiles.length);
  if (to === d.to) return;
  d.to = to;
  const order = moved(d.tiles, d.from, to);
  order.forEach((tile, j) => {
    if (tile === d.tile) return;
    const i = d.tiles.indexOf(tile),
      at = k => [(k % cols) * (w + gap), Math.floor(k / cols) * (h + rowGap)],
      [x0, y0] = at(i),
      [x1, y1] = at(j);
    tile.style.transform = x0 === x1 && y0 === y1 ? '' : `translate(${x1 - x0}px, ${y1 - y0}px)`;
  });
}
// The press let go of: nothing lifted, nothing moved
export function cancel(s) {
  const d = s.press;
  s.press = null;
  if (!d) return;
  clearTimeout(d.hold);
  d.grid?.classList.remove('bk-dragging');
  d.tile.classList.remove('bk-lifted');
  for (const tile of d.tiles ?? []) tile.style.transform = '';
}

// The tiles that stay slide from where they were to their new places (transforms only, quick, never waited on); new
// ones fade in. Reduced motion: they're simply there.
export function flip(s, change) {
  const key = el => el.dataset.id ?? el.dataset.book,
    before = new Map([...s.body.querySelectorAll('.bk-tile')].map(el => [key(el), el.getBoundingClientRect()]));
  change();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of s.body.querySelectorAll('.bk-tile')) {
    const was = before.get(key(el)),
      now = el.getBoundingClientRect();
    if (!was)
      el.animate(
        [
          { opacity: 0, transform: 'scale(0.96)' },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: SLIDE_MS,
          easing: 'ease-out',
        },
      );
    else if (was.left !== now.left || was.top !== now.top)
      el.animate(
        [{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)` }, { transform: 'none' }],
        {
          duration: SLIDE_MS,
          easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
        },
      );
  }
}
