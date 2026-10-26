// A page of the book as one picture, drawn here, with no browser: the paper, its scraps taped on (each in a white border
// with a strip of tape, turned by its tilt) and its ink on top, ink.js's own outline() as an SVG path, rasterised with
// sharp. The book (HQ), the agents (hq sketch) and calls (the voice line's sketch tool) all see a page through this.
import { readFileSync } from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { outline } from '../../../shared/review/ink.js';
import type { Stroke } from './pagechecks.ts';
import type { Scrap } from './pagescraps.ts';

// The paper as the book shows it (as sketchpen.js PAPER), and the tape across a scrap
const PAPER = '#fffdf8',
  TAPE = 'rgb(246,236,200)',
  TAPE_ALPHA = 0.8;
// Twice the page's size, or at most PICTURE_PX on its long side: what HQ's own picture of a page was
const PICTURE_PX = 2400;

export type Drawn = { w: number; h: number; ink: Stroke[]; scraps: Scrap[] };
// A PNG of the page. dir: where its scraps' files are. A scrap that can't be drawn fails it: no page looks whole
// without one of its pictures.
export async function render(page: Drawn, dir: string) {
  const k = Math.min(2, PICTURE_PX / Math.max(page.w, page.h)),
    W = Math.max(1, Math.round(page.w * k)),
    H = Math.max(1, Math.round(page.h * k));
  const layers: OverlayOptions[] = [];
  for (const s of page.scraps) {
    // (drawn PICTURE_PX on its long side at most, as the page is, then brought to its size there: a scrap three times
    // the page's size is the page's picture's size at most until only the part on the page is kept)
    const d = Math.min(k, PICTURE_PX / Math.max(s.w, s.h));
    const placed = await clipped(await scrapAt(s, d, `${dir}/${s.file}`), k / d, s, k, W, H);
    if (placed) layers.push(placed);
  }
  if (page.ink.length) layers.push({ input: Buffer.from(inkSvg(page.ink, page.w, page.h, W, H)), left: 0, top: 0 });
  return sharp({ create: { width: W, height: H, channels: 3, background: PAPER } })
    .composite(layers)
    .png()
    .toBuffer();
}

// The strokes at the picture's size: the page's units in its viewBox
const inkSvg = (ink: Stroke[], w: number, h: number, W: number, H: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${w} ${h}">${ink
    .map(s => `<path d="${outline(s)}" fill="${s.color}"${(s.alpha ?? 1) < 1 ? ` fill-opacity="${s.alpha}"` : ''}/>`)
    .join('')}</svg>`;

// A scrap as the book tapes it (HQ's drawScrap) at k picture px a page px: its picture in a white border, the tape
// across its top edge, turned by its tilt about its middle
async function scrapAt(s: Scrap, k: number, file: string) {
  const w = Math.max(1, Math.round(s.w * k)),
    h = Math.max(1, Math.round(s.h * k)),
    m = Math.round(Math.max(3, Math.min(s.w, s.h) * 0.035) * k);
  const picture = await sharp(readFileSync(file))
    .resize(Math.max(1, w - 2 * m), Math.max(1, h - 2 * m), { fit: 'fill' })
    .toBuffer();
  const tape = { w: Math.min(s.w * 0.36, 70) * k, h: Math.max(9, Math.min(16, s.h * 0.09)) * k };
  const tapeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${(w - tape.w) / 2}" y="${-tape.h / 2}" width="${tape.w}" height="${tape.h}" fill="${TAPE}" fill-opacity="${TAPE_ALPHA}" transform="rotate(-4 ${w / 2} 0)"/></svg>`;
  const matted = await sharp({ create: { width: w, height: h, channels: 4, background: '#fff' } })
    .composite([
      { input: picture, left: m, top: m },
      { input: Buffer.from(tapeSvg), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  const turned = await sharp(matted)
    .rotate(s.tilt, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: turned.data, w: turned.info.width, h: turned.info.height };
}

// A drawn scrap at its place on the page's W × H picture (k picture px a page px), grown by f to the page's scale, and
// only the part inside the page (a scrap can hang off its edge), or null when none is
async function clipped(
  t: { input: Buffer; w: number; h: number },
  f: number,
  s: Scrap,
  k: number,
  W: number,
  H: number,
) {
  const w = Math.max(1, Math.round(t.w * f)),
    h = Math.max(1, Math.round(t.h * f)),
    left = Math.round((s.x + s.w / 2) * k - w / 2),
    top = Math.round((s.y + s.h / 2) * k - h / 2);
  const x0 = Math.max(0, left),
    y0 = Math.max(0, top),
    x1 = Math.min(W, left + w),
    y1 = Math.min(H, top + h);
  if (x1 <= x0 || y1 <= y0) return null;
  if (x0 === left && y0 === top && x1 - x0 === w && y1 - y0 === h && w === t.w && h === t.h)
    return { input: t.input, left, top };
  const input = await sharp(t.input)
    .resize(w, h, { fit: 'fill' })
    .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
    .png()
    .toBuffer();
  return { input, left: x0, top: y0 };
}
