// The pen's live line on its canvases (ink.js's pen): what each pointer event repaints, in one box of whole device px,
// filled from the stroke's own shapes (inkshape.js's, which draw() fills too) so the live line is the dry one, and the
// tail drawn ahead of it.
import { HALO, HALO_ALPHA, band, disc, outline, radius } from './inkshape.js';

// What a pointer event repaints, for a canvas k device px to the CSS px: one box of whole device px around the new
// points' discs and bands, the tail drawn last time (was) and the one drawn now (tail), and their white edge (grow);
// in it, the stroke's every disc and band that reaches into it, as outline() has them, and the new tail. Inside the
// box the canvas is cleared and those are filled again together, so each pixel there is filled once, by the very
// shapes and in the very way draw() fills the whole stroke: pieces filled one over another would add up their soft
// edges, and the line would thin and lighten as it goes dry. A tail's pixels are wiped by the next event's box. Only
// a few shapes are filled, each found by a box test over the stroke's points (cheap, though it grows with the line).
// (one box per event, and the tail)
function piece(stroke, kept, { was = null, tail = null, grow = 0, k = 1 } = {}) {
  const pts = stroke.points,
    size = stroke.size,
    // (a soft edge reaches a device px past its shape)
    reach = 1 / k;
  const boxOf = ([x, y, p], g) => {
    const r = radius(size, p) + g + reach;
    return [x - r, y - r, x + r, y + r];
  };
  const joined = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const meets = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const near = [...kept.flatMap(i => (i ? [pts[i - 1], pts[i]] : [pts[i]])), ...(was ?? []), ...(tail ?? [])]
    .map(q => boxOf(q, grow))
    .reduce(joined);
  const box = [Math.floor(near[0] * k), Math.floor(near[1] * k), Math.ceil(near[2] * k), Math.ceil(near[3] * k)];
  const inBox = box.map(v => v / k);
  const shapes = g => {
    let d = '';
    for (let j = 0; j < pts.length; j++) {
      const own = boxOf(pts[j], g),
        [x, y, p] = pts[j],
        r = radius(size, p) + g;
      if (meets(own, inBox)) d += disc(x, y, r);
      if (j && meets(joined(boxOf(pts[j - 1], g), own), inBox))
        d += band(pts[j - 1], radius(size, pts[j - 1][2]) + g, x, y, r);
    }
    return tail ? d + outline({ size, points: tail }, g) : d;
  };
  return { box, ink: shapes(0), halo: grow ? shapes(grow) : '' };
}

// The line's new points on its canvases, and its tail (ahead) in place of the last (null: all of it again, a
// rectangle's)
export function show(line, kept, tail = null) {
  if (!kept) return paint(line, null, outline(line.stroke), line.halo ? outline(line.stroke, HALO) : '');
  const was = line.tail;
  line.tail = tail;
  if (!kept.length && !was && !tail) return;
  const k = line.g.getTransform().a,
    p = piece(line.stroke, kept, { was, tail, grow: line.halo ? HALO : 0, k });
  paint(line, p.box, p.ink, p.halo);
}

// The samples a pointer event brings: those a fast hand left between two frames, else the event itself. The list can
// be there and empty (Chromium's pointerdown, and an event a script made in any browser), which is no samples at all.
// (ink.js's line follows them, and the tail starts at the last)
export const samples = e => {
  const c = e.getCoalescedEvents?.();
  return c?.length ? c : [e];
};

// Where the pen is about to be: the browser's predicted points (getPredictedEvents, in Chromium and in Safari where
// it has them), drawn as a tail from the line's end through the pen's last sample to them, with the end's pressure.
// It's drawn only until the next event (show), never kept in the stroke; with no predicted points there's none.
// Only a pen's: a mouse's or a finger's are guessed from a jerkier hand, and overshoot in odd directions past it
export function ahead(line, e) {
  const next = e.getPredictedEvents?.(),
    end = line.stroke.points.at(-1);
  if (line.rect || line.kind !== 'pen' || !next?.length) return null;
  return [end, ...[samples(e).at(-1), ...next].map(s => [s.clientX - line.left, s.clientY - line.top, end[2]])];
}
// A tail the pen leaves standing, where it stopped, goes after about three frames, or it would stand past the line's
// end. current(): the pen's line by then, so a line that ended or a newer one keeps what it has.
const TAIL_MS = 50;
export function dropTail(line, current) {
  clearTimeout(line.tailTimer);
  if (line.tail) line.tailTimer = setTimeout(() => current() === line && show(line, [], null), TAIL_MS);
}

// Ink, and its white edge, filled once in a box of whole device px (null: the whole canvas), what was there wiped.
// The edge goes on the under canvas, opaque (the canvas has draw's opacity), else under the ink on the wet one.
function paint(line, box, ink, halo) {
  const inked = [ink, line.stroke.color, 1];
  if (!halo) fill(line.g, box, [inked]);
  else if (line.u) {
    fill(line.u, box, [[halo, '#fff', 1]]);
    fill(line.g, box, [inked]);
  } else fill(line.g, box, [[halo, '#fff', HALO_ALPHA], inked]);
}

// A rasteriser fills a soft edge a little differently where a clip or the canvas's own edge cuts the path (Skia, in
// Chromium and WebKit, a few px in): a box is filled on a scratch canvas this many device px bigger all round, and
// only the box is copied, pixel for pixel. With 8, the live line is the dry one but for a stray pixel; with none, a
// few hundred per line differ. Each canvas has its own scratch, of its own kind (drawn on the CPU when it is), so both
// fill paths the same way.
const SPARE = 8;
const scratches = new WeakMap();
function fill(c, box, layers) {
  const m = c.getTransform(),
    paths = g => {
      for (const [d, color, alpha] of layers) {
        g.globalAlpha = alpha;
        g.fillStyle = color;
        g.fill(new Path2D(d));
      }
    };
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (!box) {
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(m);
    paths(c);
    return c.restore();
  }
  const [x0, y0, x1, y1] = box,
    w = x1 - x0,
    h = y1 - y0;
  let scratch = scratches.get(c.canvas);
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.getContext('2d', { willReadFrequently: !!c.getContextAttributes?.().willReadFrequently });
    scratches.set(c.canvas, scratch);
  }
  if (scratch.width < w + 2 * SPARE) scratch.width = w + 2 * SPARE;
  if (scratch.height < h + 2 * SPARE) scratch.height = h + 2 * SPARE;
  const g = scratch.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w + 2 * SPARE, h + 2 * SPARE);
  g.setTransform(m.a, m.b, m.c, m.d, m.e + SPARE - x0, m.f + SPARE - y0);
  paths(g);
  c.clearRect(x0, y0, w, h);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.drawImage(scratch, SPARE, SPARE, w, h, x0, y0, w, h);
  c.restore();
}
