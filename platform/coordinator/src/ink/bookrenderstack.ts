// A page's pictures and ink as layers of its picture (bookrender.ts): each unit's in their stack, as HQ lays them
// (booklayers.js), the last unit first, as the book lays each unit's canvas over the units after it.
import { readFileSync } from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { svgInk } from '../../../../shared/review/ink.js';
import { runsOf } from '../../../hq/shell/ink/booklayers.js';
import type { Scrap } from '../pagescraps.ts';
import type { Drawn, Inked } from './bookrender.ts';

// The tape across a scrap
const TAPE = 'rgb(246,236,200)',
  TAPE_ALPHA = 0.8;
type Run = { pictures?: Drawn['scraps']; ink?: Inked[] };

// The page's pictures and ink on its W × H picture from its corner, k picture px a page px; a picture drawn side px on
// its long side at most; its files in dir
export async function stackLayers(
  page: Drawn,
  {
    corner,
    k,
    W,
    H,
    side,
    dir,
  }: { corner: { x: number; y: number }; k: number; W: number; H: number; side: number; dir: string },
) {
  const layers: OverlayOptions[] = [];
  // (a place on the page counted from its top-left, as the picture's px are)
  const from = <T extends { x: number; y: number }>(o: T): T => ({ ...o, x: o.x - corner.x, y: o.y - corner.y });
  const units = [...new Set([...page.ink, ...page.scraps].map(x => x.unit))].reverse(),
    of = <T extends { unit?: number }>(list: T[], u?: number) => list.filter(x => x.unit === u);
  for (const run of units.flatMap(u => runsOf(of(page.scraps, u), of(page.ink, u))) as Run[])
    if (run.ink)
      layers.push({ input: Buffer.from(inkSvg(run.ink, corner, { w: page.w, h: H / k }, W, H)), left: 0, top: 0 });
    else
      for (const s of run.pictures!) {
        // (drawn side px on its long side at most, then brought to its size there: a scrap three times the page's
        // size is the page's picture's size at most until only the part on the page is kept)
        const d = Math.min(k, side / Math.max(s.w, s.h));
        const placed = await clipped(await scrapAt(s, d, `${dir}/${s.file}`), k / d, from(s), k, W, H);
        if (placed) layers.push(placed);
      }
  return layers;
}

// A run of a unit's ink as an SVG picture of the picture's size, showing the page's box from its corner: in its stack
// already (its highlighter under the rest unless moved), the pieces the eraser cut from one see-through stroke filled as
// one (ink.js svgInk)
const inkSvg = (ink: Inked[], at: { x: number; y: number }, { w, h }: { w: number; h: number }, W: number, H: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${at.x} ${at.y} ${w} ${h}">${svgInk(ink)}</svg>`;

// A scrap as the book tapes it (HQ's drawScrap) at k picture px a page px: its picture in a white border, the tape
// across its top edge (an agent's drawing neither: its lines straight on the page.), turned by its tilt about its middle
async function scrapAt(s: Scrap, k: number, file: string) {
  const w = Math.max(1, Math.round(s.w * k)),
    h = Math.max(1, Math.round(s.h * k)),
    m = Math.round(Math.max(3, Math.min(s.w, s.h) * 0.035) * k);
  const picture = await sharp(readFileSync(file))
    .resize(Math.max(1, w - 2 * m), Math.max(1, h - 2 * m), { fit: 'fill' })
    .toBuffer();
  const tape = { w: Math.min(s.w * 0.36, 70) * k, h: Math.max(9, Math.min(16, s.h * 0.09)) * k };
  const tapeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${(w - tape.w) / 2}" y="${-tape.h / 2}" width="${tape.w}" height="${tape.h}" fill="${TAPE}" fill-opacity="${TAPE_ALPHA}" transform="rotate(-4 ${w / 2} 0)"/></svg>`;
  const ground = s.drawing ? { r: 0, g: 0, b: 0, alpha: 0 } : '#fff';
  const matted = await sharp({ create: { width: w, height: h, channels: 4, background: ground } })
    .composite([
      { input: picture, left: m, top: m },
      ...(s.drawing ? [] : [{ input: Buffer.from(tapeSvg), left: 0, top: 0 }]),
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
