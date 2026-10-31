// Where a call's floating parts go (the small call, callbubble.js, and its cards, callcards.js): the layer over
// everything on the page they go in, the room they have on the screen, and the spot there clear of the page's own
// controls (marked data-keep-clear) and over as little as can be of what the board reads (marked data-keep-in-sight).
// HQ's call and the join link's page both use it. (was callbubble.js's)
const MARGIN_PX = 12;
// A step up or down off where it would go counts for less than one sideways: a part keeps to its side of the screen
const SIDEWAYS = 3;

// The room a call's floating parts have: the visible viewport (an on-screen keyboard, a phone's bars) off the safe areas
// and, unless whole, within the page (HQ's narrows beside its book)
export function room({ whole = false } = {}) {
  const vv = visualViewport,
    safe = safeArea();
  const x0 = vv?.offsetLeft ?? 0,
    y0 = vv?.offsetTop ?? 0,
    right = x0 + (vv?.width ?? innerWidth);
  return {
    left: x0 + MARGIN_PX + safe.left,
    top: y0 + MARGIN_PX + safe.top,
    right: (whole ? right : Math.min(right, document.body.clientWidth)) - MARGIN_PX - safe.right,
    bottom: y0 + (vv?.height ?? innerHeight) - MARGIN_PX - safe.bottom,
  };
}

// The layer a call's floating parts go in, over everything on the page (the book beside HQ's too): the top layer, which
// a page's own stacking (HQ's page is contained) can't reach. It stays in the page's tree, so the look still draws what's
// in it. Asked for again, it comes back on top.
// It's no page to write on (data-no-ink): review mode's ink stays on the page under it, and so under HQ's spread book.
// Once its parts are gone (the small call hung up, the last card answered) it closes.
// It's a box of no size in the screen's corner, none of a popover's own look: it takes no taps, its parts (each placed
// fixed on the screen) do. Set here, so no page's stylesheet copies it.
const LAYER = {
  position: 'fixed',
  inset: '0 auto auto 0',
  width: '0',
  height: '0',
  margin: '0',
  padding: '0',
  border: '0',
  background: 'none',
  color: 'inherit',
  overflow: 'visible',
};
export function floating() {
  let layer = document.querySelector('#floating');
  if (!layer) {
    layer = Object.assign(document.createElement('div'), { id: 'floating', popover: 'manual' });
    Object.assign(layer.style, LAYER);
    layer.setAttribute('data-no-ink', '');
    new MutationObserver(() => {
      if (layer.matches(':popover-open') && ![...layer.children].some(part => part.getClientRects().length))
        layer.hidePopover();
    }).observe(layer, { childList: true, subtree: true });
    document.body.append(layer);
  }
  if (layer.matches(':popover-open')) layer.hidePopover();
  layer.showPopover();
  return layer;
}

// The boxes of the page's controls a call's floating part keeps clear of (marked data-keep-clear): those shown and
// taking taps (not HQ's, inert under its open book on a phone), and not the part's own
export function keptClear(own) {
  return [...document.querySelectorAll('[data-keep-clear]')]
    .filter(el => !own.contains(el) && !el.closest('[inert]'))
    .map(el => el.getBoundingClientRect())
    .filter(box => box.width && box.height);
}

// The boxes on the screen of what the board reads (marked data-keep-in-sight: the book's page heading, dates and scraps)
export const inSight = () =>
  [...document.querySelectorAll('[data-keep-in-sight]')]
    .map(el => el.getBoundingClientRect())
    .filter(b => b.width && b.height && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight);

// Where a box of { w, h } goes: in the first of places ({ room, at }: a room and the spot it'd take there) with a spot
// clear of every box in avoid, the clear spot over the least of the boxes in seen, then the nearest at; else null. The
// spots tried are at's, the room's edges and those just past each box to avoid or keep in sight.
export function clearSpot({ w, h }, places, avoid, seen = []) {
  const over = (s, b) =>
      Math.max(0, Math.min(s.x + w, b.right) - Math.max(s.x, b.left)) *
      Math.max(0, Math.min(s.y + h, b.bottom) - Math.max(s.y, b.top)),
    clear = s => avoid.every(b => !over(s, b)),
    cost = (s, at) => Math.abs(s.y - at.y) + SIDEWAYS * Math.abs(s.x - at.x),
    edges = [...avoid, ...seen];
  for (const { room: box, at } of places) {
    const xs = [at.x, box.left, box.right - w, ...edges.flatMap(b => [b.left - MARGIN_PX - w, b.right + MARGIN_PX])],
      ys = [at.y, box.top, box.bottom - h, ...edges.flatMap(b => [b.top - MARGIN_PX - h, b.bottom + MARGIN_PX])];
    const spots = xs
      .flatMap(x => ys.map(y => ({ x, y })))
      .filter(s => s.x >= box.left && s.x + w <= box.right && s.y >= box.top && s.y + h <= box.bottom && clear(s))
      .map(s => ({ ...s, covers: seen.reduce((sum, b) => sum + over(s, b), 0), cost: cost(s, at) }));
    if (spots.length)
      return spots.reduce((best, s) =>
        s.covers < best.covers || (s.covers === best.covers && s.cost < best.cost) ? s : best,
      );
  }
  return null;
}

// The screen's safe areas (a notch, the home indicator), in px: env() reads only in a property that takes a length
let probe = null;
function safeArea() {
  if (!probe?.isConnected) {
    probe = document.createElement('div');
    Object.assign(probe.style, {
      position: 'fixed',
      visibility: 'hidden',
      pointerEvents: 'none',
      padding:
        'env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)',
    });
    probe.setAttribute('data-watchalong-hide', '');
    document.body.append(probe);
  }
  const css = getComputedStyle(probe);
  return {
    top: parseFloat(css.paddingTop),
    right: parseFloat(css.paddingRight),
    bottom: parseFloat(css.paddingBottom),
    left: parseFloat(css.paddingLeft),
  };
}
