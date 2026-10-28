// A horizontal drag on an element, the book's cover's edge's and its pull tab's (book.js, bookswing.js). (out of book.js:

// A press that moves less than this is a tap; a flick's speed is read over its last moves, this long
const TAP_PX = 8,
  FLICK_MS = 100;

// A horizontal drag on an element: start(dx) once it's held past TAP_PX, move(dx) while it is, end(dx, v) as it's let go
// (v in px per ms, over its last FLICK_MS: a flick is how fast it was going as it left, whatever came before). A press
// that never moves that far stays a tap.
export function follow(node, { start = () => {}, move, end }) {
  node.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button > 0) return;
    const x0 = e.clientX,
      trail = [[e.timeStamp, x0]];
    let dragging = false;
    const onMove = m => {
      if (m.pointerId !== e.pointerId) return;
      const dx = m.clientX - x0;
      trail.push([m.timeStamp, m.clientX]);
      if (trail.length > 6) trail.shift();
      if (!dragging && Math.abs(dx) < TAP_PX) return;
      if (!dragging) {
        node.setPointerCapture?.(e.pointerId);
        start(dx);
      }
      dragging = true;
      move(dx);
    };
    const onUp = u => {
      if (u.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      if (!dragging) return;
      // (moves can share a timestamp: a millisecond at least, so a quick flick reads fast, not still)
      const [t0, xa] = trail.find(([t]) => t >= u.timeStamp - FLICK_MS) ?? trail.at(-1),
        dt = Math.max(1, u.timeStamp - t0);
      // a drag ends on its own pointerup, never on the click that may follow it
      const swallow = c => c.stopPropagation();
      node.addEventListener('click', swallow, true);
      setTimeout(() => node.removeEventListener('click', swallow, true));
      end(u.clientX - x0, (u.clientX - xa) / dt);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  });
}
