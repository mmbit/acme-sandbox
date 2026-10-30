// A picture taped into the book, as plain numbers: how big it lands, where, and how askew. No DOM, so node tests it
// (bookscrap.test.js); booktape.js tapes it.
import { pageBox } from './bookrow.js';

// A taped picture is at most this much of its page's width and of the paper's height, and never smaller than MIN a side
const OF_WIDTH = 0.5,
  OF_HEIGHT = 0.55,
  MIN = 24;
// a touch askew: between -TILT and TILT degrees
export const TILT = 4;
// several at once land a little apart, like photos dealt onto a table
const DEALT = [28, 22];

// A tilt from a random number in [0, 1): -TILT to TILT degrees, to a tenth
export const tiltOf = rand => Math.round((rand * 2 - 1) * TILT * 10) / 10;

// A picture of nw × nh px taped on a page (its box: bookrow.js), centred on `at` ([x, y] on the page) or the middle of the
// band of it the paper shows (view: { x0, y0, x1, y1 } on the page), kept on the page. i: its place among several
// taped at once. Returns the scrap's place { x, y, w, h, tilt } (its box, white border included, as bookscrapdraw.js
// draws it).
export function placeScrap({ nw, nh }, page, { at = null, view, i = 0, rand = Math.random() }) {
  const viewH = Math.max(1, view.y1 - view.y0),
    f = Math.min(1, (page.w * OF_WIDTH) / nw, (viewH * OF_HEIGHT) / nh),
    w = round(Math.max(MIN, nw * f)),
    h = round(Math.max(MIN, nh * f));
  const [cx, cy] = at ?? [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2];
  // (kept on the page, any way from its origin.)
  const on = pageBox(page),
    keep = (c, side, from, to) => Math.min(Math.max(c, from + side / 2), Math.max(from + side / 2, to - side / 2));
  const x = keep(cx + i * DEALT[0], w, on.x0, on.x1) - w / 2,
    y = keep(cy + i * DEALT[1], h, on.y0, on.y1) - h / 2;
  return { x: round(x), y: round(y), w, h, tilt: tiltOf(rand) };
}
const round = n => Math.round(n * 100) / 100;

// ---- moving one (booktools.js).

// The scrap under a point [x, y] of its page (page px), turned as it lies: the one on top (the last drawn), or -1
export function scrapAt(scraps, [x, y]) {
  for (let i = scraps.length - 1; i >= 0; i--) {
    const s = scraps[i],
      a = (-s.tilt * Math.PI) / 180,
      dx = x - (s.x + s.w / 2),
      dy = y - (s.y + s.h / 2);
    const u = dx * Math.cos(a) - dy * Math.sin(a),
      v = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(u) <= s.w / 2 && Math.abs(v) <= s.h / 2) return i;
  }
  return -1;
}
