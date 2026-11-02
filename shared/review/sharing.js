// Temporary marks shared through HQ's viewer, anchored to the same element at another screen size.
import { anchorOf, placer } from './anchor.js';
import { draw, fit } from './ink.js';
import { holderOf } from './mark.js';

// how often standing marks are sent again (HQ's viewmarks.js lets a device's marks expire after three missed)
const REFRESH_MS = 5000;

export function setupViewmarks(r) {
  if (!r.framed || r.outside) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'remote';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  canvas.setAttribute('aria-hidden', 'true');
  r.ui.prepend(canvas);
  const viewmarks = { r, canvas, dry: [], wet: null, queued: 0, remote: [] };
  document.addEventListener('ink:stroke', e => changed(viewmarks, e.detail));
  addEventListener('viewmarks', e => {
    viewmarks.remote = e.detail;
    paint(viewmarks);
  });
  addEventListener('scroll', () => paint(viewmarks), { capture: true, passive: true });
  addEventListener('resize', () => paint(viewmarks));
  addEventListener('pagehide', () => {
    viewmarks.dry = [];
    viewmarks.wet = null;
    send(viewmarks);
  });
  addEventListener('hashchange', () => send(viewmarks));
  // Refresh standing marks so a newly opened device sees them and disconnected senders' ink can expire.
  setInterval(() => {
    if (viewmarks.dry.length || viewmarks.wet) send(viewmarks);
  }, REFRESH_MS);
  send(viewmarks);
}

function changed(viewmarks, event) {
  const { r } = viewmarks;
  if (event.phase === 'shown' && event.canvas === r.inkCanvas) {
    viewmarks.dry = event.strokes;
    return send(viewmarks);
  }
  if (event.canvas !== r.wet) return;
  viewmarks.wet = ['start', 'move'].includes(event.phase) ? event.stroke : null;
  viewmarks.queued ||= requestAnimationFrame(() => send(viewmarks));
}

function send(viewmarks) {
  cancelAnimationFrame(viewmarks.queued);
  viewmarks.queued = 0;
  const { dry, wet, r } = viewmarks;
  const strokes = wet ? [...dry, wet] : dry;
  const el = strokes.length ? holderOf(r, strokes) : null;
  const view = { w: innerWidth, h: innerHeight, x: scrollX, y: scrollY, dpr: devicePixelRatio };
  const ink = strokes.map(s => ({
    ...s,
    points: s.points.map(([a, b, ...rest]) => [a + scrollX, b + scrollY, ...rest]),
  }));
  const anchor = anchorOf(el, { url: location.href, view, ink });
  if (anchor.el) anchor.el.text = ''; // (the element's words stay off the live feed)
  r.toHq({ marks: anchor });
}

function paint({ canvas, remote }) {
  const g = fit(canvas);
  for (const anchor of remote) {
    const place = placer(anchor, document, { x: scrollX, y: scrollY });
    const strokes = anchor.ink.map(s => ({
      ...s,
      points: s.points.map(p => {
        const [x, y, ...rest] = place(p);
        return [x - scrollX, y - scrollY, ...rest];
      }),
    }));
    draw(g, strokes, { halo: true });
  }
}
