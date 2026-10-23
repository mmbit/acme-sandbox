// A box's four corners in another picture, and the perspective that takes the box there: the photo studio's kept boxes
// in an edit the model squared up (corners.ts, retouch.ts). Plain geometry and sampling, no pictures read here.

export type Point = { x: number; y: number };
// top-left, top-right, bottom-right, bottom-left
export type Quad = [Point, Point, Point, Point];
// a perspective transform, row by row, its last entry 1
export type Homography = number[];

// The box's own corners, from its top-left
export const rectangle = (w: number, h: number): Quad => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

// The perspective that takes each corner of `from` to the same corner of `to`: eight equations, solved by elimination
export function homography(from: Quad, to: Quad): Homography {
  const rows: number[][] = [];
  from.forEach(({ x, y }, i) => {
    const { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  });
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const by = rows[r][col] / rows[col][col];
      for (let c = col; c < 9; c++) rows[r][c] -= by * rows[col][c];
    }
  }
  return [...rows.map((row, i) => row[8] / row[i]), 1];
}

export function mapped(h: Homography, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

// the transform the other way (its adjugate, scaled to end in 1)
export function inverse(h: Homography): Homography {
  const [a, b, c, d, e, f, g, i, j] = h,
    out = [
      e * j - f * i,
      c * i - b * j,
      b * f - c * e,
      f * g - d * j,
      a * j - c * g,
      c * d - a * f,
      d * i - e * g,
      b * g - a * i,
      a * e - b * d,
    ];
  return out.map(v => v / out[8]);
}

// The corners' bounding box, in whole pixels
export function around(quad: Quad) {
  const xs = quad.map(p => p.x),
    ys = quad.map(p => p.y),
    x = Math.floor(Math.min(...xs)),
    y = Math.floor(Math.min(...ys));
  return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
}

// A channel's value between pixel centres (x, y: 0 is the first pixel's centre), or NaN outside the picture
export function bilinear(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  channel: number,
  x: number,
  y: number,
) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return NaN;
  const x0 = Math.min(Math.floor(x), width - 2),
    y0 = Math.min(Math.floor(y), height - 2),
    fx = x - x0,
    fy = y - y0,
    at = (y0 * width + x0) * channels + channel,
    below = at + width * channels;
  const top = pixels[at] + (pixels[at + channels] - pixels[at]) * fx,
    bottom = pixels[below] + (pixels[below + channels] - pixels[below]) * fx;
  return top + (bottom - top) * fy;
}

// The same, sharper for an enlargement: Catmull-Rom over the 4 × 4 pixels about it (the edge's pixels repeated)
export function bicubic(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  channel: number,
  x: number,
  y: number,
) {
  if (x < -0.5 || y < -0.5 || x > width - 0.5 || y > height - 0.5) return NaN;
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    wx = weights(x - x0),
    wy = weights(y - y0);
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const row = Math.min(height - 1, Math.max(0, y0 - 1 + j)) * width;
    let line = 0;
    for (let i = 0; i < 4; i++)
      line += wx[i] * pixels[(row + Math.min(width - 1, Math.max(0, x0 - 1 + i))) * channels + channel];
    sum += wy[j] * line;
  }
  return sum;
}
const weights = (t: number) => [
  ((-t + 2) * t - 1) * t * 0.5,
  ((3 * t - 5) * t * t + 2) * 0.5,
  ((-3 * t + 4) * t + 1) * t * 0.5,
  (t - 1) * t * t * 0.5,
];
