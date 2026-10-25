// A scene's items as flat shapes on the isometric view, each with the role the palette paints, and their outlines as
// SVG path data that a page and a canvas (Path2D) both draw.

const COS = Math.cos(Math.PI / 6);

// A point in 3D on the view, in the scene's units: x and y lie at 30 degrees, z straight up.
export const project = ([x, y, z]) => [(x - y) * COS, (x + y) * 0.5 - z];

// The flat shapes, in drawing order: { kind: 'poly' | 'line' | 'ellipse' | 'cylinder', role, ... }. A role is 'accent',
// 'accent-side', 'shadow', 'pool', 'line', 'thin', or a tone and the face it's on: 'plain-top', 'glass-left', 'leaf-ball'.
export function shapesOf(items) {
  const shapes = [];
  for (const item of items) shapes.push(...(FLATTEN[item.kind] ?? unknown)(item));
  return shapes;
}
const unknown = item => {
  throw new Error(`lineart: no shape called ${item.kind}`);
};
const roleOf = (item, face) => (item.accent === face || item.accent === true ? 'accent' : `${item.tone}-${face}`);
const poly = (pts, role) => ({ kind: 'poly', pts: pts.map(project), role });

const FLATTEN = {
  box(item) {
    const { x, y, z, w, d, h } = item;
    const faces = {
      left: [
        [x, y + d, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      right: [
        [x + w, y, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x + w, y, z + h],
      ],
      top: [
        [x, y, z + h],
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
    };
    return Object.entries(faces)
      .map(([face, pts]) => poly(pts, roleOf(item, face)))
      .filter(shape => Math.abs(area(shape.pts)) > 1e-6);
  },
  cylinder(item) {
    const [cx, cy] = project([item.x, item.y, item.z]);
    const top = project([item.x, item.y, item.z + item.h])[1];
    const [rx, ry] = [item.r * 2 * COS * Math.SQRT1_2, item.r * Math.SQRT1_2];
    const side = item.accent ? 'accent-side' : `${item.tone}-right`;
    return [
      { kind: 'cylinder', cx, cy, top, rx, ry, role: side },
      { kind: 'ellipse', cx, cy: top, rx, ry, role: item.accent ? 'accent' : `${item.tone}-top` },
    ];
  },
  ball(item) {
    const [cx, cy] = project([item.x, item.y, item.z]);
    return [{ kind: 'ellipse', cx, cy, rx: item.r, ry: item.r, role: item.accent ? 'accent' : `${item.tone}-ball` }];
  },
  quad: item => [poly(item.pts, roleOf(item, item.face))].filter(shape => Math.abs(area(shape.pts)) > 1e-6),
  line: item => [
    { kind: 'line', pts: item.pts.map(project), role: item.thin ? 'thin' : 'line', onAccent: item.onAccent },
  ],
  shadow: item => [poly(item.pts, 'shadow')],
  pool: item => [poly(item.pts, 'pool')],
};

const area = pts =>
  pts.reduce((sum, [x, y], i) => sum + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0) / 2;

// The box round shapes on the view: [x0, y0, x1, y1]. Ground (pools and shadows) may run past what it frames.
export function bounds(shapes) {
  const xs = [],
    ys = [];
  for (const shape of shapes.filter(s => s.role !== 'pool' && s.role !== 'shadow')) {
    const pts = shape.pts ?? [
      [shape.cx - shape.rx, (shape.top ?? shape.cy) - shape.ry],
      [shape.cx + shape.rx, shape.cy + shape.ry],
    ];
    for (const [x, y] of pts) {
      xs.push(x);
      ys.push(y);
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Where the shapes go in a W x H frame: { k, ox, oy }, a point (x, y) on the view lands at (ox + x k, oy + y k).
// pad: the margin on each side, a share of the frame; focus: a nudge, in shares of W and H; zoom: past the fit.
export function fit(shapes, { W, H, pad = 0.08, focus = [0, 0], zoom = 1 }) {
  const [x0, y0, x1, y1] = bounds(shapes);
  const k = Math.min((W * (1 - 2 * pad)) / (x1 - x0), (H * (1 - 2 * pad)) / (y1 - y0)) * zoom;
  return { k, ox: W / 2 - ((x0 + x1) / 2) * k + focus[0] * W, oy: H / 2 - ((y0 + y1) / 2) * k + focus[1] * H };
}

// A shape's outline as SVG path data, placed by { k, ox, oy } (the view's own units without one), to two decimals.
export function pathOf(shape, { k = 1, ox = 0, oy = 0 } = {}) {
  const n = v => +v.toFixed(2);
  const at = ([x, y]) => `${n(ox + x * k)} ${n(oy + y * k)}`;
  if (shape.pts) return `M${shape.pts.map(at).join('L')}${shape.kind === 'poly' ? 'Z' : ''}`;
  const [cx, cy, rx, ry] = [ox + shape.cx * k, oy + shape.cy * k, shape.rx * k, shape.ry * k];
  const arc = (sweep, x, y) => `A${n(rx)} ${n(ry)} 0 0 ${sweep} ${n(x)} ${n(y)}`;
  if (shape.kind === 'ellipse') return `M${n(cx - rx)} ${n(cy)}${arc(1, cx + rx, cy)}${arc(1, cx - rx, cy)}Z`;
  // a cylinder's side: down its left edge, round the front of its foot, up its right edge, back round its top's front
  const top = oy + shape.top * k;
  return `M${n(cx - rx)} ${n(top)}L${n(cx - rx)} ${n(cy)}${arc(0, cx + rx, cy)}L${n(cx + rx)} ${n(top)}${arc(1, cx - rx, top)}Z`;
}
