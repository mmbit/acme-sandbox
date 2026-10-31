// A try's versions on a page's picture, under the board's scrap as HQ draws them (bookversions.js, bookversions.css)
//: one block, the trying agent's face and name in its ink "· on staging", then a
// frame per version wrapping 1 to 4 across, each its picture with its letter and two-word name under it and what's
// different, CHOSEN stamped on the chosen one, the others greyed as they're crossed out or cleared, and what's become of
// them; the board's ink over the frame it was written on; a frame of pencil dots in the agent's ink for each still
// coming; or, once a try ended with none, why, in the hand.
import sharp, { type OverlayOptions } from 'sharp';
import { DOTS, inkBox, pathsOf } from '../../../hq/shell/ink/bookanswerart.js';
import { LETTERS } from '../../../hq/shell/ink/bookversionsof.js';
import type { Stroke } from '../pagechecks.ts';
import { block, column, escaped, faceDisc, HAND_FONT, layered, type Part } from './bookrendertext.ts';

// A try under a unit: its agent (name, its ink: color), its versions in order, how many are still coming, and why it
// ended with none (null: it didn't)
export type Tried = { name: string; color: string; versions: Version[]; coming: number; ended: string | null };
// A version: its letter (A, B…), its name, what's different, its picture's file, chosen, or greyed (crossed out or
// cleared), what's become of it (bookversionsof.js versionsOf: null for nothing yet), and the board's replies on it, each
// its ink with the box its picture showed in as it was written (page px)
export type Version = {
  letter: string;
  name: string;
  text: string;
  picture?: string;
  chosen: boolean;
  greyed: boolean;
  fate: string | null;
  marks: { frame: { x: number; y: number; w: number; h: number }; ink: Stroke[] }[];
};

// The block (bookversions.css .bk-versions): 16 px under what's over it (bookanswers.js VERSIONS.gap), its padding,
// paper, border and frames (250 px at most, 124 at least, 12 apart and 18 down), its head
const BLOCK = { gap: 16, pad: 12, top: 10, paper: '#fbf8f2', border: 'rgba(29,26,47,0.82)', line: 1.5 };
const FRAMES = { most: 250, least: 124, gap: 12, rows: 18, ratio: 3 / 4, edge: '#2b2733', round: 9, under: 8 };
const HEAD = { top: 4, face: 28, gap: 8, below: 12, size: 16, line: 1.2, quiet: '#2b2733b3' };
const LETTER = { size: 20, line: 1.2 },
  NAME = { size: 14, line: 1.2, ink: '#2b2733bf' },
  DIFFERENT = { size: 13, line: 1.3, ink: '#2b2733a6', weight: 400 },
  FATE = { size: 14, line: 1.3, ink: '#2b273380', weight: 500 },
  ENDED = { size: 21, line: 1.25, font: HAND_FONT };
// CHOSEN (bookversions.js STAMP): across the picture's middle, 84% of it and 220 px at most, a little crooked
const STAMP = { share: 0.84, most: 220, fill: '#d6ea3c' };

// The block under a unit from top (picture px), as wide as its frames need within the unit's width (x, w in page px),
// with the board's ink over its frames, where it reaches past them too (as HQ's ink layer over the frames): the block's
// layer has room round it for that ink, its foot the block's
export async function versioned(t: Tried, at: { x: number; w: number }, top: number, k: number, dir: string) {
  const px = (n: number) => Math.round(n * k),
    count = Math.max(1, t.versions.length + t.coming),
    w = Math.min(at.w, count * FRAMES.most + (count - 1) * FRAMES.gap + 2 * BLOCK.pad),
    inner = w - 2 * BLOCK.pad;
  const said = await head(t, inner, k),
    shown =
      t.ended !== null
        ? { ...(await block(`<span foreground="${t.color}">${escaped(t.ended)}</span>`, inner, k, ENDED)), marks: [] }
        : await frames(t, inner, k, dir);
  const all = await column([said, shown], px(inner), px(HEAD.below)),
    W = px(w),
    H = px(BLOCK.top + HEAD.top + BLOCK.pad) + all.height;
  const s = BLOCK.line * k,
    box = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${s / 2}" y="${s / 2}" width="${W - s}" height="${H - s}" rx="${4 * k}" fill="${BLOCK.paper}" stroke="${BLOCK.border}" stroke-width="${s}"/></svg>`;
  // (the frames' marks in the block's px: the frames are under the head, in its padding)
  const marks = shown.marks.map(m => ({
    ...m,
    left: m.left + px(BLOCK.pad),
    top: m.top + px(BLOCK.top + HEAD.top) + said.tall + px(HEAD.below),
  }));
  const room = roomFor(marks, W, H),
    ink = `<svg xmlns="http://www.w3.org/2000/svg" width="${room.W}" height="${room.H}"><g transform="translate(${room.left} ${room.top})">${marks.map(inkOn).join('')}</g></svg>`;
  const input = await sharp(Buffer.from(box))
    .composite([{ input: all.input, left: px(BLOCK.pad), top: px(BLOCK.top + HEAD.top) }])
    .png()
    .toBuffer();
  const y = top + px(BLOCK.gap),
    inked = await layered(
      [
        { input, left: room.left, top: room.top },
        { input: Buffer.from(ink), left: 0, top: 0 },
      ],
      room.W,
      room.H,
    );
  return {
    input: inked.input,
    left: px(at.x) - room.left,
    top: y - room.top,
    width: room.W,
    height: room.H,
    foot: y + H,
  };
}
// A reply's ink on a frame: its picture's top-left (picture px) and how many picture px a page px of the box it was
// written over (frame) is there, as bookversions.js fitInk moves and sizes it
type Mark = { left: number; top: number; scale: number; frame: { x: number; y: number }; ink: Stroke[] };
const inkOn = (m: Mark) =>
  `<g transform="translate(${m.left} ${m.top}) scale(${m.scale}) translate(${-m.frame.x} ${-m.frame.y})">${pathsOf(m.ink)}</g>`;
// The room a W × H block needs round it for its marks' ink (picture px): left and top of it, and the whole's W × H
function roomFor(marks: Mark[], W: number, H: number) {
  const boxes = marks.flatMap(m => {
    const b = inkBox(m.ink),
      at = (x: number, y: number) => [m.left + (x - m.frame.x) * m.scale, m.top + (y - m.frame.y) * m.scale];
    return b ? [[...at(b.x0, b.y0), ...at(b.x1, b.y1)]] : [];
  });
  const left = Math.ceil(Math.max(0, ...boxes.map(b => -b[0]))),
    top = Math.ceil(Math.max(0, ...boxes.map(b => -b[1]))),
    right = Math.ceil(Math.max(0, ...boxes.map(b => b[2] - W))),
    bottom = Math.ceil(Math.max(0, ...boxes.map(b => b[3] - H)));
  return { left, top, W: left + W + right, H: top + H + bottom };
}

// The agent's face (its initial on its ink), its name, "· on staging"
async function head(t: Tried, w: number, k: number): Promise<Part> {
  const px = (n: number) => Math.round(n * k),
    f = HEAD.face;
  const words = await block(
    `<span weight="bold" foreground="${t.color}">${escaped(t.name)}</span> <span foreground="${HEAD.quiet}">· on staging</span>`,
    w - f - HEAD.gap,
    k,
    HEAD,
  );
  const disc = faceDisc(t.name, t.color, f, 13, k);
  const H = Math.max(px(f), words.height);
  const on: OverlayOptions[] = [
    { input: disc, left: 0, top: Math.round((H - px(f)) / 2) },
    { input: words.input, left: px(f + HEAD.gap), top: Math.round((H - words.height) / 2) },
  ];
  return { ...(await layered(on, px(w), H)), lead: 0 };
}

// The frames, as many across as fit (1 to 4: the block is as wide as its frames), each row as tall as its tallest, and
// the board's replies on them (marks: in the frames' px, each moved and sized onto its version's picture)
async function frames(t: Tried, w: number, k: number, dir: string): Promise<Part & { marks: Mark[] }> {
  const px = (n: number) => Math.round(n * k),
    count = t.versions.length + t.coming,
    across = Math.max(1, Math.min(count, Math.floor((w + FRAMES.gap) / (FRAMES.least + FRAMES.gap)))),
    fw = (w - (across - 1) * FRAMES.gap) / across;
  const cells = [
    ...(await Promise.all(t.versions.map(v => frame(v, fw, k, dir)))),
    ...(await Promise.all(
      Array.from({ length: t.coming }, (_, i) => coming(LETTERS[t.versions.length + i], fw, k, t.color)),
    )),
  ];
  const on: OverlayOptions[] = [],
    marks: Mark[] = [];
  let y = 0;
  for (let i = 0; i < cells.length; i += across) {
    const row = cells.slice(i, i + across);
    row.forEach((c, j) => {
      const left = px(j * (fw + FRAMES.gap));
      on.push({ input: c.input, left, top: y });
      for (const { frame, ink } of t.versions[i + j]?.marks ?? [])
        marks.push({ left, top: y, scale: Math.round(fw * k) / frame.w, frame, ink });
    });
    y += Math.max(...row.map(c => c.height)) + (i + across < cells.length ? px(FRAMES.rows) : 0);
  }
  return { ...(await layered(on, px(w), y)), lead: 0, marks };
}
// A version's frame: its picture in a rounded dark edge (greyed, or stamped CHOSEN), its letter and name, what's
// different, what's become of it (each centred in the frame, as bookversions.css sets them)
async function frame(v: Version, w: number, k: number, dir: string) {
  const W = Math.round(w * k),
    H = Math.round(w * FRAMES.ratio * k);
  const on: OverlayOptions[] = [];
  if (v.picture) {
    let picture = sharp(`${dir}/${v.picture}`).resize(W, H, { fit: 'cover', position: 'top' });
    if (v.greyed) picture = picture.grayscale().linear(0.45, 255 * 0.55);
    on.push({ input: await picture.png().toBuffer(), left: 0, top: 0 });
  }
  if (v.chosen) on.push({ input: Buffer.from(chosen(W, H, k)), left: 0, top: 0 });
  const parts = [await edged(W, H, k, on), await captioned(v.letter, v.name, v.greyed, w, k)];
  for (const [said, face] of [
    [v.text, DIFFERENT],
    [v.fate, FATE],
  ] as const)
    if (said) {
      const set = await block(`<span weight="${face.weight}" foreground="${face.ink}">${escaped(said)}</span>`, w, k, {
        ...face,
        align: 'centre',
      });
      parts.push({ ...set, input: await centred(set.input, W), lead: 0 });
    }
  return column(parts, W, Math.round(FRAMES.under * k));
}
// A frame's letter (greyed with it) and name under it, in its middle
async function captioned(letter: string, name: string, greyed: boolean, w: number, k: number): Promise<Part> {
  const set = await block(
    `<span size="${LETTER.size * 1024}" weight="bold" foreground="${greyed ? NAME.ink : FRAMES.edge}">${letter}</span>  <span weight="500" foreground="${NAME.ink}">${escaped(name)}</span>`,
    w,
    k,
    { ...NAME, line: LETTER.line },
  );
  return { ...set, input: await centred(set.input, Math.round(w * k)) };
}
// A frame still coming: pencil dots in the agent's ink, its letter under it
async function coming(letter: string, w: number, k: number, color: string) {
  const W = Math.round(w * k),
    H = Math.round(w * FRAMES.ratio * k),
    d = Math.round(34 * 2 * k);
  const dots = DOTS.replace(
    '<svg ',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d / 3.4}" fill="${color}" `,
  );
  const sheet = await edged(W, H, k, [
    { input: Buffer.from(dots), left: Math.round((W - d) / 2), top: Math.round((H - d / 3.4) / 2) },
  ]);
  return column([sheet, await captioned(letter, '', false, w, k)], W, Math.round(FRAMES.under * k));
}
// White paper W × H in its rounded dark edge, what's on it clipped to it
async function edged(W: number, H: number, k: number, on: OverlayOptions[]): Promise<Part> {
  const s = 2 * k,
    r = FRAMES.round * k,
    mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${r}"/></svg>`,
    edge = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${s / 2}" y="${s / 2}" width="${W - s}" height="${H - s}" rx="${r - s / 2}" fill="none" stroke="${FRAMES.edge}" stroke-width="${s}"/></svg>`;
  const input = await sharp({ create: { width: W, height: H, channels: 4, background: '#fff' } })
    .composite([...on, { input: Buffer.from(mask), blend: 'dest-in' }, { input: Buffer.from(edge) }])
    .png()
    .toBuffer();
  return { input, height: H, tall: H, lead: 0 };
}
// CHOSEN across a W × H picture (bookversions.js STAMP, bookversions.css .bk-version-stamp)
function chosen(W: number, H: number, k: number) {
  const w = Math.min(W * STAMP.share, STAMP.most * k),
    s = w / 200;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g transform="translate(${W / 2} ${H * 0.52}) rotate(-8) scale(${s}) translate(-100 -28)"><rect x="3" y="3" width="194" height="50" rx="7" fill="${STAMP.fill}" stroke="${FRAMES.edge}" stroke-width="3"/><rect x="9" y="9" width="182" height="38" rx="4" fill="none" stroke="rgba(43,39,51,0.5)" stroke-width="1.2"/><text x="100" y="39" text-anchor="middle" fill="${FRAMES.edge}" font-family="DejaVu Sans, sans-serif" font-size="30" font-weight="800" letter-spacing="2">CHOSEN</text></g></svg>`;
}
// A line of words set in the middle of W px
async function centred(input: Buffer, W: number) {
  const { width, height } = await sharp(input).metadata();
  return (await layered([{ input, left: Math.max(0, Math.round((W - width!) / 2)), top: 0 }], W, height!)).input;
}
