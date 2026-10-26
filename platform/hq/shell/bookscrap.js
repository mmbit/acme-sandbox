// A picture taped into the book, as plain numbers: how big it lands, where, and how askew. No DOM, so node tests it
// (bookscrap.test.js); booktape.js tapes it.

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

// A picture of nw × nh px taped on a page { w, h } (its px), centred on `at` ([x, y] on the page) or the middle of the
// band of it the paper shows (view: { x0, y0, x1, y1 } on the page), kept on the page. i: its place among several
// taped at once. Returns the scrap's place { x, y, w, h, tilt } (its box, white border included, as sketchscraps.js
// draws it).
export function placeScrap({ nw, nh }, page, { at = null, view, i = 0, rand = Math.random() }) {
  const viewH = Math.max(1, view.y1 - view.y0),
    f = Math.min(1, (page.w * OF_WIDTH) / nw, (viewH * OF_HEIGHT) / nh),
    w = round(Math.max(MIN, nw * f)),
    h = round(Math.max(MIN, nh * f));
  const [cx, cy] = at ?? [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2];
  const keep = (c, side, room) => Math.min(Math.max(c, side / 2), Math.max(side / 2, room - side / 2));
  const x = keep(cx + i * DEALT[0], w, page.w) - w / 2,
    y = keep(cy + i * DEALT[1], h, page.h) - h / 2;
  return { x: round(x), y: round(y), w, h, tilt: tiltOf(rand) };
}
const round = n => Math.round(n * 100) / 100;

// The band of a page the paper shows: { x0, y0, x1, y1 } in the page's px, the page's place on the table `r` ({ x, y,
// w, h }), the pan and the paper's size as bookpages.js keeps them. Nothing of it showing: the page's top
export function viewOn(r, pan, size) {
  const x0 = Math.max(0, pan.x - r.x),
    y0 = Math.max(0, pan.y - r.y),
    x1 = Math.min(r.w, pan.x + size.w - r.x),
    y1 = Math.min(r.h, pan.y + size.h - r.y);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: r.w, y1: Math.min(r.h, size.h || r.h) };
}
