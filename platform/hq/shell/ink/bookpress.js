// A press on the paper followed until it lifts: its moves, then its lift. A lift that never comes (Apple's handwriting
// took the Pencil's touch, the window lost the focus) ends it as cancelled at the next press of its kind, a blur or the
// page hidden, so no tool's handler outlives its pointer and holds the paper.
//
// down: the press's pointerdown. move(e) for each of its pointermoves; up(e) once, with its pointerup or a
// pointercancel (the browser's, or one made here at the last place it was seen).
export function followPress(down, { move = () => {}, up }) {
  let last = down;
  const moved = e => {
    if (e.pointerId !== down.pointerId) return;
    last = e;
    move(e);
  };
  const lifted = e => e.pointerId === down.pointerId && end(e);
  const lost = () => end(cancelled(down, last));
  const pressed = e => e.pointerType === down.pointerType && lost();
  const hidden = () => document.hidden && lost();
  const on = { pointermove: moved, pointerup: lifted, pointercancel: lifted, pointerdown: pressed };
  function end(e) {
    for (const [type, f] of Object.entries(on)) removeEventListener(type, f, true);
    removeEventListener('blur', lost);
    document.removeEventListener('visibilitychange', hidden);
    up(e);
  }
  for (const [type, f] of Object.entries(on)) addEventListener(type, f, true);
  // (the window's own blur: an element's doesn't reach it uncaptured)
  addEventListener('blur', lost);
  document.addEventListener('visibilitychange', hidden);
}
const cancelled = (down, last) => ({
  type: 'pointercancel',
  pointerId: down.pointerId,
  pointerType: down.pointerType,
  clientX: last.clientX,
  clientY: last.clientY,
  timeStamp: performance.now(),
  shiftKey: false,
});
