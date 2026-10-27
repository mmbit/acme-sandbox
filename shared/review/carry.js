// Ring and carry: something the Pencil has just ringed on HQ's page, or a note's ring kept as a hairline (its snip from
// the book), lifted by a finger pressed inside the ring and dragged. A cut-out of what's inside (the screenshot's pixels in the ring's box) follows the finger; let go over the
// book's paper it's taped on today's page there, anywhere else it goes back. A finger anywhere else still works the page,
// and a finger's tap inside the ring is still the page's.
//
// The book hears it as document events, never through its DOM: 'book:tape' (cancelable), detail { phase, x, y,
// picture }. phase 'over' as the finger moves (the book cancels it while the point is over its paper), 'drop' as it lets
// go (the book cancels it if it takes the picture: a promise of a PNG blob). platform/hq/shell/booktape.js answers.

// a finger moves this far inside the ring before the cut-out lifts (less is a tap, the page's)
const LIFT_PX = 8;
// the cut-out's white edge, as a taped picture has
const MAT = 4;

// ---- the maths

// Whether a point is inside a ring's line, the line closed from its last point back to its first (even-odd crossings)
export function insideRing(points, [x, y]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i],
      [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// The box round a line's points
export function boxOfPoints(points) {
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
// A box of the screen (CSS px) on a screenshot of W×H CSS px at k device px each: whole device px, within it, or null
// when nothing of it is on the screenshot
export function cutOf(box, k, W, H) {
  const x0 = Math.max(0, Math.floor(box.x * k)),
    y0 = Math.max(0, Math.floor(box.y * k)),
    x1 = Math.min(Math.round(W * k), Math.ceil((box.x + box.w) * k)),
    y1 = Math.min(Math.round(H * k), Math.ceil((box.y + box.h) * k));
  return x1 - x0 >= 2 && y1 - y0 >= 2 ? { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 } : null;
}

// ---- the finger

// ring(at): the ring that can be carried from a point now, or null: { then: its points on the screenshot, now: on the
// screen now, shot: the screenshot { c, k } }, or a note's { now, snip: its picture's URL }. carried(): the cut-out was taped in the book. onPage(e): whether a touch is HQ's page's
export function setupCarry(r, { ring, carried, onPage }) {
  const st = { r, ring, carried, onPage, c: null }; // c: the press, { id, from, target, ring, lifted, el, at, picture }
  addEventListener('pointerdown', e => pressed(st, e), true);
  // (Safari scrolls under a finger until its first touchmove says no: a press inside the ring never scrolls)
  addEventListener('touchmove', e => touched(st, e), { capture: true, passive: false });
  addEventListener('pointermove', e => moved(st, e), true);
  addEventListener('pointerup', e => lifted(st, e), true);
  addEventListener('pointercancel', e => lifted(st, e), true);
}
function pressed(st, e) {
  st.c = null;
  if (e.pointerType !== 'touch' || !e.isPrimary || st.r.covered || !st.onPage(e)) return;
  const now = st.ring([e.clientX, e.clientY]);
  if (now && insideRing(now.now, [e.clientX, e.clientY]))
    st.c = { id: e.pointerId, from: [e.clientX, e.clientY], target: e.target, ring: now, lifted: false };
}
function touched(st, e) {
  if (!st.c) return;
  if (e.touches.length > 1) {
    // (two fingers: the page's pinch, or undo)
    back(st.c);
    st.c = null;
    return;
  }
  e.preventDefault();
}
function moved(st, e) {
  const { c } = st;
  if (!c || e.pointerId !== c.id) return;
  e.stopPropagation();
  const dx = e.clientX - c.from[0],
    dy = e.clientY - c.from[1];
  if (!c.lifted && Math.hypot(dx, dy) < LIFT_PX) return;
  if (!c.lifted && !lift(c)) return (st.c = null);
  follow(c, dx, dy, ask('over', e) === false);
}
function lifted(st, e) {
  const { c } = st;
  if (!c || e.pointerId !== c.id || c.cancelling) return;
  st.c = null;
  if (!c.lifted) return; // (a tap inside the ring: the page's)
  e.stopPropagation();
  if (e.type === 'pointerup' && ask('drop', e, c.picture) === false) {
    landed(c);
    st.carried();
  } else back(c);
  noClick();
}

// Asks the book about a point: false when it says the point is its (the event cancelled)
const ask = (phase, e, picture = null) =>
  document.dispatchEvent(
    new CustomEvent('book:tape', {
      cancelable: true,
      detail: { phase, x: e.clientX, y: e.clientY, picture },
    }),
  );

// The cut-out lifted from where the ring is now: a canvas of the screenshot's pixels in the ring's box, in a white
// edge, in an element of its own over everything (outside the page, so it can cross onto the book). The page hears its
// touch cancelled, as when the browser takes one to scroll. False when the ring is off the screenshot.
function lift(c) {
  const picture = c.ring.snip ? snipped(c.ring) : cutOut(c.ring);
  if (!picture) return false;
  c.picture = picture.blob;
  const at = picture.at,
    el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    left: `${at.x - MAT}px`,
    top: `${at.y - MAT}px`,
    zIndex: '2147483647',
    pointerEvents: 'none',
    background: '#fff',
    padding: `${MAT}px`,
    borderRadius: '2px',
    boxShadow: '0 10px 28px rgba(40, 30, 50, .32), 0 1px 3px rgba(40, 30, 50, .25)',
    willChange: 'transform',
  });
  el.append(picture.el);
  document.documentElement.append(el);
  Object.assign(c, { el, lifted: true, cancelling: true });
  c.target.dispatchEvent(
    new PointerEvent('pointercancel', {
      pointerId: c.id,
      pointerType: 'touch',
      isPrimary: true,
      clientX: c.from[0],
      clientY: c.from[1],
      bubbles: true,
      composed: true,
    }),
  );
  c.cancelling = false;
  return true;
}
// The screenshot's pixels in a just-drawn ring's box: { el, blob, at }, or null off the screenshot
function cutOut({ shot, then, now }) {
  const cut = cutOf(boxOfPoints(then), shot.k, shot.c.width / shot.k, shot.c.height / shot.k);
  if (!cut) return null;
  const canvas = Object.assign(document.createElement('canvas'), { width: cut.sw, height: cut.sh });
  canvas.getContext('2d').drawImage(shot.c, cut.sx, cut.sy, cut.sw, cut.sh, 0, 0, cut.sw, cut.sh);
  Object.assign(canvas.style, { display: 'block', width: `${cut.sw / shot.k}px`, height: `${cut.sh / shot.k}px` });
  return { el: canvas, blob: new Promise(res => canvas.toBlob(res, 'image/png')), at: boxOfPoints(now) };
}
// A note's snip from the book, over its ring (the snip is the ring with a margin round it): { el, blob, at }
function snipped({ snip, now }) {
  const ring = boxOfPoints(now),
    img = Object.assign(new Image(), { src: snip, alt: '' }),
    w = Math.max(ring.w + 48, 160);
  Object.assign(img.style, { display: 'block', width: `${w}px` });
  const blob = fetch(snip, { credentials: 'same-origin' }).then(r => {
    if (!r.ok) throw new Error(`the note's snip: ${r.status}`);
    return r.blob();
  });
  return { el: img, blob, at: { x: ring.x + ring.w / 2 - w / 2, y: ring.y - 24 } };
}
// ...following the finger, lifted a little, and over the book's paper tilted as it will be taped
function follow(c, dx, dy, over) {
  c.at = [dx, dy];
  c.el.style.transform = `translate(${dx}px, ${dy}px) rotate(${over ? -3 : -1.5}deg) scale(${over ? 0.92 : 1.04})`;
}
// Taken: it settles onto the paper and goes (the book draws it taped)
function landed(c) {
  const [dx, dy] = c.at;
  c.el.style.transition = 'transform .2s ease-in, opacity .2s ease-in';
  c.el.style.transform = `translate(${dx}px, ${dy}px) rotate(-3deg) scale(.8)`;
  c.el.style.opacity = '0';
  setTimeout(() => c.el.remove(), 260);
}
// Not taken: it goes back where it came from, and the ring is still there to carry
function back(c) {
  if (!c.el) return;
  c.el.style.transition = 'transform .28s cubic-bezier(.3, 1.3, .5, 1), opacity .2s .2s';
  c.el.style.transform = 'none';
  c.el.style.opacity = '0';
  setTimeout(() => c.el.remove(), 440);
}
// (the browser's click after a carry is no tap on what the finger let go over)
const stopClick = c => c.isTrusted && c.stopPropagation();
function noClick() {
  addEventListener('click', stopClick, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', stopClick, true), 400);
}
