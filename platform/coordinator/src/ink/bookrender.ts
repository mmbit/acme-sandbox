// A page of the book as one picture, drawn here, with no browser: the paper, its scraps taped on (each in a white border
// with a strip of tape, turned by its tilt), its ink on top, ink.js's own outline() as an SVG path (a highlighter's
// under the rest), and the words typed on it, set by sharp's text (Pango, wrapping each box at its width as the book
// does), all rasterised with sharp. The book (HQ), the agents (hq sketch) and calls (the voice line's sketch tool) all see a page through this.
import { readFileSync } from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { outline } from '../../../../shared/review/ink.js';
import type { Stroke, Typed } from '../pagechecks.ts';
import type { Scrap } from '../pagescraps.ts';

// The paper as the book shows it (as sketchpen.js PAPER), and the tape across a scrap
const PAPER = '#fffdf8',
  TAPE = 'rgb(246,236,200)',
  TAPE_ALPHA = 0.8;
// Twice the page's size, or at most PICTURE_PX on its long side: what HQ's own picture of a page was
const PICTURE_PX = 2400;
// Typed words as the book sets them (booktools.js TEXT): the size and the line's height in page px. The book's own face
// is HQ's; here it's the first of these the machine has (DejaVu Sans comes with fontconfig on Debian).
const TEXT = { size: 18, line: 1.4, font: 'Atkinson Hyperlegible, DejaVu Sans, sans-serif' };
// (Pango's own line in these faces is about 1.17 of the size: the rest of the book's line is spacing between lines)
const FACE_LINE = 1.17;

// x, y: the page's top-left (0,0 where it hasn't grown up or left), w × h its size from there. (x, y)
export type Drawn = { x?: number; y?: number; w: number; h: number; ink: Stroke[]; scraps: Scrap[]; texts?: Typed[] };
// A PNG of the page, its whole box. dir: where its scraps' files are. A scrap that can't be drawn fails it: no page
// looks whole without one of its pictures.
export async function render(page: Drawn, dir: string) {
  const k = Math.min(2, PICTURE_PX / Math.max(page.w, page.h)),
    W = Math.max(1, Math.round(page.w * k)),
    H = Math.max(1, Math.round(page.h * k)),
    corner = { x: page.x ?? 0, y: page.y ?? 0 };
  // (a place on the page counted from its top-left, as the picture's px are)
  const from = <T extends { x: number; y: number }>(o: T): T => ({ ...o, x: o.x - corner.x, y: o.y - corner.y });
  const layers: OverlayOptions[] = [];
  for (const s of page.scraps) {
    // (drawn PICTURE_PX on its long side at most, as the page is, then brought to its size there: a scrap three times
    // the page's size is the page's picture's size at most until only the part on the page is kept)
    const d = Math.min(k, PICTURE_PX / Math.max(s.w, s.h));
    const placed = await clipped(await scrapAt(s, d, `${dir}/${s.file}`), k / d, from(s), k, W, H);
    if (placed) layers.push(placed);
  }
  if (page.ink.length) layers.push({ input: Buffer.from(inkSvg(page.ink, corner, page, W, H)), left: 0, top: 0 });
  for (const t of page.texts ?? []) {
    const set = await typed(from(t), k, W, H);
    if (set) layers.push(set);
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: PAPER } })
    .composite(layers)
    .png()
    .toBuffer();
}

// The strokes at the picture's size: the page's units in its viewBox
// (a highlighter's strokes first, so they lie under the ink as the book draws them.)
const inkSvg = (ink: Stroke[], at: { x: number; y: number }, { w, h }: Drawn, W: number, H: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${at.x} ${at.y} ${w} ${h}">${[
    ...ink.filter(s => (s.alpha ?? 1) < 1),
    ...ink.filter(s => (s.alpha ?? 1) >= 1),
  ]
    .map(s => `<path d="${outline(s)}" fill="${s.color}"${(s.alpha ?? 1) < 1 ? ` fill-opacity="${s.alpha}"` : ''}/>`)
    .join('')}</svg>`;

// A box of typed words at its place on the W × H picture (k picture px a page px), wrapped at its width, in its colour,
// only the part inside the picture; null when none of it is.
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function typed(t: Typed, k: number, W: number, H: number): Promise<OverlayOptions | null> {
  const left = Math.round(t.x * k),
    top = Math.round((t.y + ((TEXT.line - FACE_LINE) * TEXT.size) / 2) * k);
  if (left >= W || top >= H) return null;
  const set = await setText(t, k);
  // (a box may start left of the page's top-left: only the part from there in.)
  const x0 = Math.max(0, left),
    y0 = Math.max(0, top),
    width = Math.min(left + set.info.width, W) - x0,
    height = Math.min(top + set.info.height, H) - y0;
  if (width <= 0 || height <= 0) return null;
  if (width === set.info.width && height === set.info.height) return { input: set.data, left, top };
  const cut = { left: x0 - left, top: y0 - top, width, height },
    input = await sharp(set.data).extract(cut).png().toBuffer();
  return { input, left: x0, top: y0 };
}

// A box's words set at k picture px a page px (from typed, for typedHeight)
const setText = (t: Typed, k: number) =>
  sharp({
    text: {
      text: `<span foreground="${t.color}">${escaped(t.text)}</span>`,
      font: `${TEXT.font} ${TEXT.size}`,
      width: Math.max(1, Math.round(t.w * k)),
      dpi: Math.round(72 * k),
      rgba: true,
      wrap: 'word-char',
      spacing: Math.round((TEXT.line - FACE_LINE) * TEXT.size * k),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
// How tall a box's words stand on its page, in page px, as its picture sets them: its lines at the book's line height
// (an answer typed under a question: bookslips.ts.)
export async function typedHeight(t: Typed) {
  const { info } = await setText(t, 1);
  const lines = Math.max(1, Math.round((info.height + (TEXT.line - FACE_LINE) * TEXT.size) / (TEXT.line * TEXT.size)));
  return lines * TEXT.line * TEXT.size;
}

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
