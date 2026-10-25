// Keys the board sorts by dragging: a press held still on one ([data-sort], in a .pj-sortable grid) lifts it, it
// follows the finger or the mouse while the others make way, and letting go sets it down there and hands the grid's new
// order on. A press that moves first is a scroll or a swipe, a short one a tap; but a mouse's press that moves lifts its
// key at once, as a mouse drags, and never swipes the level.

const HOLD_MS = 380; // how long a press stays still before its key lifts: past a tap, short of a long wait
const STILL = 8; // how far (CSS px) a press may wander and still lift

let pressed = null,
  lifted = null,
  // the click that ends a drag isn't a tap
  dropped = false;
export const sorting = () => !!(lifted || pressed?.mouse);
export const sortGesture = () => !!(pressed || lifted);

// root: where the sortable grids are drawn; onSorted(ids): the grid's keys' ids in their new order, after a drop that
// moved one
export function sortable(root, { onSorted }) {
  root.addEventListener('pointerdown', e => {
    const key = e.button === 0 && e.target.closest('.pj-sortable > [data-sort]');
    if (!key) return;
    pressed = { key, x: e.clientX, y: e.clientY, id: e.pointerId, mouse: e.pointerType === 'mouse' };
    pressed.timer = setTimeout(() => lift(e.pointerId), HOLD_MS);
  });
  root.addEventListener('pointermove', e => {
    if (lifted?.id === e.pointerId) return follow(e);
    if (pressed?.id !== e.pointerId || Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) <= STILL) return;
    if (!pressed.mouse) return letGo();
    clearTimeout(pressed.timer);
    lift(e.pointerId);
    follow(e);
  });
  root.addEventListener('pointerup', e => drop(e, onSorted));
  root.addEventListener('pointercancel', e => drop(e, onSorted));
  root.addEventListener('click', e => dropped && (e.stopImmediatePropagation(), (dropped = false)), { capture: true });
  // (a lifted key's finger mustn't scroll the page, nor a long press open the browser's menu)
  root.addEventListener('touchmove', e => lifted && e.preventDefault(), { passive: false });
  root.addEventListener('contextmenu', e => (pressed || lifted) && e.preventDefault());
}

function lift(pointerId) {
  const { key, x, y } = pressed;
  pressed = null;
  key.setPointerCapture?.(pointerId);
  lifted = { key, id: pointerId, x, y, from: order(key.parentElement) };
  key.classList.add('pj-lifted');
  navigator.vibrate?.(8);
}
// The key under the finger, and the one it's over making way: it takes that one's place, the others sliding along.
// Keys are placed by where the grid lays them out, never where a slide shows them on the way.
function follow(e) {
  const { key } = lifted,
    grid = key.parentElement,
    finger = inGrid(key, e);
  const over = [...grid.children].find(k => {
    if (k === key || !k.dataset.sort) return false;
    const box = placeOf(k);
    return finger.x > box.x && finger.x < box.x + box.w && finger.y > box.y && finger.y < box.y + box.h;
  });
  if (over) {
    const keys = [...grid.children],
      before = new Map(keys.map(k => [k, placeOf(k)]));
    grid.insertBefore(key, keys.indexOf(over) > keys.indexOf(key) ? over.nextSibling : over);
    for (const k of keys) {
      const was = before.get(k),
        now = placeOf(k);
      if (k !== key && (was.x !== now.x || was.y !== now.y))
        k.animate([{ transform: `translate(${was.x - now.x}px, ${was.y - now.y}px)` }, { transform: 'none' }], {
          duration: 180,
          easing: 'ease-out',
        });
    }
    // (the key moved in the grid: it stays under the finger)
    lifted.x += placeOf(key).x - before.get(key).x;
    lifted.y += placeOf(key).y - before.get(key).y;
  }
  key.style.transform = `translate(${e.clientX - lifted.x}px, ${e.clientY - lifted.y}px)`;
}
// where the grid lays a key out (its offset parent's coordinates), and a pointer in the same ones
const placeOf = k => ({ x: k.offsetLeft, y: k.offsetTop, w: k.offsetWidth, h: k.offsetHeight });
function inGrid(key, e) {
  const parent = key.offsetParent,
    r = parent.getBoundingClientRect();
  return {
    x: e.clientX - r.left - parent.clientLeft + parent.scrollLeft,
    y: e.clientY - r.top - parent.clientTop + parent.scrollTop,
  };
}
function drop(e, onSorted) {
  if (pressed?.id === e.pointerId) return letGo();
  if (lifted?.id !== e.pointerId) return;
  const { key, from } = lifted,
    to = order(key.parentElement);
  lifted = null;
  dropped = true;
  setTimeout(() => (dropped = false));
  const at = key.style.transform;
  key.style.transform = '';
  key.classList.remove('pj-lifted');
  key.animate([{ transform: at }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
  if (to.join() !== from.join()) onSorted(to);
}
function letGo() {
  clearTimeout(pressed?.timer);
  pressed = null;
}
const order = grid => [...grid.querySelectorAll(':scope > [data-sort]')].map(k => k.dataset.sort);
