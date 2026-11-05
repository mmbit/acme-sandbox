// A page's things drawn on a canvas as the page shows them (its pictures taped on, its ink, its typed words): the whole
// page as a picture to share (bookshare.js), or a few things on their own, the picture a crumple plays on
// (bookpaper.js). The same order and look as the page's tiles (bookpage.js) and the store's picture (bookrender.ts).
import { draw } from '/__review/ink.js';
import { layered } from '/__review/inkshape.js';
import { drawScrap } from './bookscrapdraw.js';
import { picture } from '../../util.js';
import { pageBox } from './bookrow.js';
import { TEXT } from './booktexts.js';
import { wrapLines } from './bookpapermath.js';
import { inkBox } from './bookanswerart.js';
import { VOICE_SLIP, shadowColor } from './bookvoiceslip.js';

// The paper as the store's picture has it (bookrender.ts PAPER), and that picture's longest side at most (PICTURE_PX)
const PAPER = '#fffdf8',
  PICTURE_PX = 2400;
// the room round things drawn on their own (screen px), so no edge of their ink is cut
const ROOM_PX = 4;

// The whole page as a picture: a canvas twice its size, or PICTURE_PX on its long side at most, once its pictures are in
export async function pagePicture(page) {
  const box = pageBox(page),
    w = box.x1 - box.x0,
    h = box.y1 - box.y0,
    k = Math.min(2, PICTURE_PX / Math.max(w, h));
  const canvas = canvasOf(w * k, h * k),
    g = canvas.getContext('2d');
  g.fillStyle = PAPER;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.setTransform(k, 0, 0, k, -box.x0 * k, -box.y0 * k);
  const things = { ink: page.ink ?? [], scraps: withPictures(page.scraps ?? []), texts: page.texts ?? [] };
  await Promise.all(things.scraps.map(s => s.img.decode().catch(() => {}))); // (one that fails stays a blank card)
  paint(g, things);
  return canvas;
}

// Strokes on their own as a picture to send with a desk-phone card's answer (bookasks.js), as the store draws a reply's
// snip (bookrender.ts): on the paper, a little room round the ink (SNIP_PAD, page px), at twice its px. A PNG Blob, or
// null for no ink.
export const SNIP_PAD = 24;
export async function inkPicture(strokes) {
  const box = inkBox(strokes);
  if (!box) return null;
  const [x, y] = [Math.floor(box.x0) - SNIP_PAD, Math.floor(box.y0) - SNIP_PAD],
    [w, h] = [Math.ceil(box.x1) + SNIP_PAD - x, Math.ceil(box.y1) + SNIP_PAD - y];
  const canvas = canvasOf(w * 2, h * 2),
    g = canvas.getContext('2d');
  g.fillStyle = PAPER;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.setTransform(2, 0, 0, 2, -x * 2, -y * 2);
  paint(g, { ink: strokes, scraps: [], texts: [] });
  return new Promise(done => canvas.toBlob(done, 'image/png'));
}

// Things on a page view (v: bookpages.js's) as a canvas over where they show on the screen, sharp at its pixel ratio.
// extent: their box in the page's px, scale: the book's zoom. Returns [rect (on the screen), canvas]: crumple()'s.
export function thingsPicture(v, things, extent, scale) {
  const room = ROOM_PX / scale,
    box = { x0: extent.x0 - room, y0: extent.y0 - room, x1: extent.x1 + room, y1: extent.y1 + room },
    at = v.el.getBoundingClientRect(),
    k = scale * (devicePixelRatio || 1);
  const rect = new DOMRect(
    at.left + box.x0 * scale,
    at.top + box.y0 * scale,
    (box.x1 - box.x0) * scale,
    (box.y1 - box.y0) * scale,
  );
  const canvas = canvasOf((box.x1 - box.x0) * k, (box.y1 - box.y0) * k),
    g = canvas.getContext('2d');
  g.setTransform(k, 0, 0, k, -box.x0 * k, -box.y0 * k);
  paint(g, { ink: things.ink ?? [], scraps: withPictures(things.scraps ?? []), texts: things.texts ?? [] });
  return [rect, canvas];
}

// Pictures under the ink (a highlighter's strokes under the rest, as on paper), the typed words over it
function paint(g, { ink, scraps, texts }) {
  for (const s of scraps) drawScrap(g, s);
  draw(g, layered(ink));
  const face = getComputedStyle(document.querySelector('#book .bk-typed-words') ?? document.body).fontFamily,
    line = TEXT.size * TEXT.line;
  g.font = `${TEXT.size}px ${face}`;
  g.textBaseline = 'middle';
  for (const t of texts) {
    const lines = wrapLines(t.text, t.w, words => g.measureText(words).width);
    if (t.voice) slip(g, t, lines.length * line);
    g.fillStyle = t.color ?? '#1d1a2f';
    lines.forEach((words, i) => g.fillText(words, t.x, t.y + line * (i + 0.5)));
  }
}
// A voice note's slip under its words, h tall: its paper, shadows and tape (bookvoiceslip.js). Each shadow is cast by
// the slip grown by its spread, under the paper; a canvas blurs by half its shadowBlur, as CSS by half its blur. A
// canvas's shadow ignores its transform, so its blur and offset are scaled to the canvas's k device px a page px.
function slip(g, t, h) {
  const { x, y, paper, radius, shadow, tape } = VOICE_SLIP,
    [x0, y0, w] = [t.x - x, t.y - y, t.w + 2 * x],
    k = g.getTransform().a;
  g.save();
  g.fillStyle = paper;
  for (const l of shadow.layers) {
    Object.assign(g, { shadowColor: shadowColor(l), shadowBlur: l.blur * k, shadowOffsetY: l.y * k });
    g.beginPath();
    g.roundRect(x0 - l.spread, y0 - l.spread, w + 2 * l.spread, h + 2 * y + 2 * l.spread, radius);
    g.fill();
  }
  g.shadowColor = 'transparent';
  g.beginPath();
  g.roundRect(x0, y0, w, h + 2 * y, radius);
  g.fill();
  g.translate(t.x + t.w / 2, y0);
  g.rotate((tape.tilt * Math.PI) / 180);
  g.fillStyle = tape.color;
  g.fillRect(-tape.w / 2, -tape.h / 2, tape.w, tape.h);
  g.restore();
}
// A page's pictures with their images (the page's own, loaded once: util.js picture())
const withPictures = scraps => scraps.map(s => (s.img ? s : { ...s, img: picture(s.url) }));
const canvasOf = (w, h) =>
  Object.assign(document.createElement('canvas'), {
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
  });
