// A picture full size over everything, to look closely: a pinch or the wheel zooms where it points, a drag pans, a
// double tap zooms in and back out. Escape or the close button closes it.
import { esc, clamp, stylesheet } from '../util.js';
import { sfx } from './audio.js';

// the zoom a double tap goes to, and how far past the picture's own pixels a pinch may go
const CLOSER = 3,
  PAST_PIXELS = 3;

export async function zoom(src, label) {
  await stylesheet('shell/zoom.css');
  const box = document.createElement('dialog');
  box.className = 'zoom';
  box.setAttribute('aria-label', label);
  box.innerHTML = `<img src="${esc(src)}" alt="${esc(label)}" draggable="false"><button class="zoom-close" aria-label="Close">✕</button>`;
  document.body.append(box);
  const img = box.querySelector('img');
  const view = placing(box, img);
  fingers(box, view);
  wheel(box, view);
  // (the box follows the page, which the book's slide resizes as the window does.)
  const fitting = new ResizeObserver(() => img.complete && view.fit());
  const close = () => {
    sfx.close();
    fitting.disconnect();
    box.close();
    box.remove();
  };
  box.querySelector('.zoom-close').onclick = close;
  box.addEventListener('cancel', e => {
    e.preventDefault();
    close();
  });
  // (Escape closes this alone, not the tool under it)
  box.addEventListener('keydown', e => e.key === 'Escape' && e.stopPropagation());
  // (fitted once open, when the box has its size)
  box.showModal();
  fitting.observe(box);
  if (img.complete) view.fit();
  else img.onload = view.fit;
  sfx.open();
}

// The picture's place in the box: s its scale over the size that fits, x and y its top left corner
function placing(box, img) {
  let fitted = { w: 1, h: 1 },
    s = 1,
    x = 0,
    y = 0;
  const most = () => Math.max(CLOSER, (img.naturalWidth / fitted.w) * PAST_PIXELS);
  const show = () => {
    const w = fitted.w * s,
      h = fitted.h * s;
    // (smaller than the box: centred; larger: no gap at its edges)
    x = w <= box.clientWidth ? (box.clientWidth - w) / 2 : clamp(x, box.clientWidth - w, 0);
    y = h <= box.clientHeight ? (box.clientHeight - h) / 2 : clamp(y, box.clientHeight - h, 0);
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  };
  return {
    zoomed: () => s > 1,
    // by factor about the point (px, py), which stays where it is
    zoomAt(px, py, factor) {
      const to = clamp(s * factor, 1, most());
      x = px - ((px - x) * to) / s;
      y = py - ((py - y) * to) / s;
      s = to;
      show();
    },
    panBy(dx, dy) {
      x += dx;
      y += dy;
      show();
    },
    whole() {
      s = 1;
      show();
    },
    fit() {
      const by = Math.min(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight) || 1;
      fitted = { w: img.naturalWidth * by, h: img.naturalHeight * by };
      Object.assign(img.style, { width: `${fitted.w}px`, height: `${fitted.h}px` });
      s = 1;
      show();
    },
  };
}

// One finger drags, two pinch (about their middle, which follows them), a double tap goes closer or back to the whole
function fingers(box, view) {
  const pointers = new Map();
  let pinch = null,
    moved = 0,
    pinched = false,
    lastTap = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  box.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    box.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) [moved, pinched] = [0, false];
    if (pointers.size === 2) [pinched, lastTap] = [true, null];
    pinch = pointers.size === 2 ? spread() : null;
  });
  box.addEventListener('pointermove', e => {
    const was = pointers.get(e.pointerId);
    if (!was) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);
    if (!pinch) {
      moved += Math.hypot(now.x - was.x, now.y - was.y);
      return view.panBy(now.x - was.x, now.y - was.y);
    }
    const next = spread();
    view.panBy(next.x - pinch.x, next.y - pinch.y);
    view.zoomAt(next.x, next.y, next.d / pinch.d);
    pinch = next;
  });
  const up = e => {
    if (!pointers.delete(e.pointerId)) return;
    pinch = pointers.size === 2 ? spread() : null;
    if (pointers.size || pinched || moved > 10 || e.type === 'pointercancel') return;
    // (a second tap close by within 300 ms)
    const tap = { at: e.timeStamp, x: e.clientX, y: e.clientY };
    const twice = lastTap && tap.at - lastTap.at < 300 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 30;
    lastTap = twice ? null : tap;
    if (twice && view.zoomed()) view.whole();
    else if (twice) view.zoomAt(tap.x, tap.y, CLOSER);
  };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
  // (Safari's own pinch would zoom the page)
  box.addEventListener('gesturestart', e => e.preventDefault());
}

// The wheel zooms where the pointer is: a trackpad's pinch comes as the wheel with Ctrl, in small steps; a mouse's in
// lines or pixels
function wheel(box, view) {
  box.addEventListener(
    'wheel',
    e => {
      e.preventDefault();
      const step = e.deltaY * (e.deltaMode === 1 ? 16 : 1) * (e.ctrlKey ? 0.01 : 0.002);
      view.zoomAt(e.clientX, e.clientY, Math.exp(-step));
    },
    { passive: false },
  );
}
