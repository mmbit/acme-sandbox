// A page of the book as one picture, drawn here, with no browser: the paper, its scraps taped on (each in a white border
// with a strip of tape, turned by its tilt), its ink on top, ink.js's own outline() as an SVG path (a highlighter's
// under the rest), the words typed on it, each scrap's words on a post-it under it, the agents' answers and the board's
// replies slipped under their groups or written at their spots, set by sharp's text (Pango, wrapping each box at its
// width as the book does), all rasterised with sharp. The book (HQ), the agents (hq sketch) and calls (the voice line's
// sketch tool) all see a page through this.
import { readFileSync } from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { outline } from '../../../../shared/review/ink.js';
import { pathsOf } from '../../../hq/shell/ink/bookanswerart.js';
import type { Stroke, Typed } from '../pagechecks.ts';
import type { Scrap } from '../pagescraps.ts';
import {
  block,
  escaped,
  faceDisc,
  HAND_FONT,
  paper,
  pictureAt,
  setMarkup,
  TEXT,
  WORDS,
  FACE_LINE,
} from './bookrendertext.ts';
import type { Face, Layer } from './bookrendertext.ts';
import { asked, formed, type Asked, type Form } from './bookrenderasks.ts';
import { versioned, type Tried } from './bookrenderversions.ts';

// The paper as the book shows it (as bookpaperdraw.js PAPER), and the tape across a scrap
const PAPER = '#fffdf8',
  TAPE = 'rgb(246,236,200)',
  TAPE_ALPHA = 0.8;
// Twice the page's size, or at most `side` px wide and `pixels` px in all: the page whole, however long; drawn again
// smaller, `again` of the scale that fits, as its words set anew wrap and round anew
const PICTURE = { side: 2400, pixels: 40_000_000, again: 0.98 };
// The paper left under the last words when the picture grows down to them, in page px
const BELOW_PX = 24;
// An answer slipped under its group (shared/review/slip.js): 12 px below what's over it, on paper, its agent's name
// over its typed words; the board's reply under it 8 px down and 18 in, its words after "You" (bookgroups.js .bk-reply)
const SLIP = {
  ...{ gap: 12, pad: { top: 14, x: 12, bottom: 10 }, paper: '#fffdf6', shadow: 0.14, picture: 8 },
  name: { size: 12, line: 1.45, gap: 3, ink: '#5a5478' },
  text: { size: 13.5, line: 1.45, font: 'Courier Prime, Courier New, DejaVu Sans Mono, monospace' },
  reply: { gap: 8, x: 18 },
};
// An answer written at its spot (bookanswers.css .bk-answer): its face and name on a 26 px head, its words in the hand
// under it in its agent's ink (the book's hand where the machine has it, else a narrow face), a picture taped in under
// them
const HAND = {
  ...{ pad: 4, head: 26, face: 22, gap: 6, below: 2 },
  name: { size: 13, line: 1.17 },
  text: { size: 23, line: 26 / 23, font: HAND_FONT },
  picture: { x: 6, top: 10, frame: 5, bottom: 4 },
};

// x, y: the page's top-left (0,0 where it hasn't grown up or left), w × h its size from there. under: what's under its
// groups, answers: its answers at their spots. (x, y)
export type Drawn = {
  x?: number;
  y?: number;
  w: number;
  h: number;
  ink: Stroke[];
  scraps: Scrap[];
  texts?: Typed[];
  under?: Under[];
  answers?: Answer[];
};
// What's under a group (bookgroups.js .bk-under), from x, y, w wide: a scrap's words on a post-it (text, '': none), then
// its answers and replies slipped under it in the order they came, the agents' cards clipped under it (asks), and a
// try's versions. A reply is the board's (name null); picture: a file in the page's dir. (asks, tried)
export type Under = { x: number; y: number; w: number; text: string; slips?: Said[]; asks?: Asked[]; tried?: Tried };
// form: an answer's clipped form
export type Said = { name: string | null; text: string; picture?: string; form?: Form };
// An agent's answer at its spot, from x, y, w wide, in its ink (color): its drawing's strokes from its top-left
export type Answer = Said & { x: number; y: number; w: number; name: string; color: string; ink?: Stroke[] };
// A PNG of the page, its whole box grown down to the last line of words set on it. dir: where its scraps' files are.
// A scrap that can't be drawn fails it: no page looks whole without one of its pictures. Words grown past PICTURE.pixels
// draw it again smaller, once (drawn: k picture px a page px, and whether it may); still past it, it fails.
export const render = (page: Drawn, dir: string): Promise<Buffer> => drawn(page, dir, scaleOf(page), true);
async function drawn(page: Drawn, dir: string, k: number, again: boolean): Promise<Buffer> {
  const W = Math.max(1, Math.round(page.w * k)),
    corner = { x: page.x ?? 0, y: page.y ?? 0 };
  // (a place on the page counted from its top-left, as the picture's px are)
  const from = <T extends { x: number; y: number }>(o: T): T => ({ ...o, x: o.x - corner.x, y: o.y - corner.y });
  // (the words are set first: only Pango knows how many lines they wrap to, and the picture grows down to them.
  const words: Layer[] = [];
  for (const t of page.texts ?? []) words.push(await typed(from(t), k));
  for (const u of page.under ?? []) words.push(...(await under(from(u), k, dir)));
  for (const a of page.answers ?? []) words.push(await answered(from(a), k, dir));
  const H = Math.max(1, Math.round(page.h * k), ...words.map(l => l.top + l.height + Math.round(BELOW_PX * k)));
  if (W * H > PICTURE.pixels) {
    if (!again) throw new Error(`a page's picture is past ${PICTURE.pixels} px, even drawn smaller: ${W} × ${H}`);
    return drawn(page, dir, k * Math.sqrt(PICTURE.pixels / (W * H)) * PICTURE.again, false);
  }
  const layers: OverlayOptions[] = [];
  for (const s of page.scraps) {
    // (drawn PICTURE.side on its long side at most, then brought to its size there: a scrap three times the page's
    // size is the page's picture's size at most until only the part on the page is kept)
    const d = Math.min(k, PICTURE.side / Math.max(s.w, s.h));
    const placed = await clipped(await scrapAt(s, d, `${dir}/${s.file}`), k / d, from(s), k, W, H);
    if (placed) layers.push(placed);
  }
  if (page.ink.length) {
    const svg = inkSvg(page.ink, corner, { w: page.w, h: H / k }, W, H);
    layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  for (const l of words) layers.push(...(await inside(l, W, H)));
  return sharp({ create: { width: W, height: H, channels: 3, background: PAPER } })
    .composite(layers)
    .png()
    .toBuffer();
}

const scaleOf = ({ w, h }: Drawn) => Math.min(2, PICTURE.side / w, Math.sqrt(PICTURE.pixels / (w * h)));
// The strokes at the picture's size: the page's units in its viewBox
// (a highlighter's strokes first, so they lie under the ink as the book draws them.)
const inkSvg = (
  ink: Stroke[],
  at: { x: number; y: number },
  { w, h }: { w: number; h: number },
  W: number,
  H: number,
) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${at.x} ${at.y} ${w} ${h}">${[
    ...ink.filter(s => (s.alpha ?? 1) < 1),
    ...ink.filter(s => (s.alpha ?? 1) >= 1),
  ]
    .map(s => `<path d="${outline(s)}" fill="${s.color}"${(s.alpha ?? 1) < 1 ? ` fill-opacity="${s.alpha}"` : ''}/>`)
    .join('')}</svg>`;

// A box of typed words at its place on the picture (k picture px a page px), wrapped at its width, in its colour
async function typed(t: Typed, k: number): Promise<Layer> {
  const set = await setText(t, k);
  return {
    input: set.data,
    left: Math.round(t.x * k),
    top: Math.round((t.y + ((TEXT.line - FACE_LINE) * TEXT.size) / 2) * k),
    ...{ width: set.info.width, height: set.info.height },
  };
}
// A scrap's words on their post-it at its place on the picture (k picture px a page px).
async function posted(p: Under, k: number) {
  const { pad } = WORDS,
    words = await block(`<span foreground="${WORDS.ink}">${escaped(p.text)}</span>`, p.w - 2 * pad.x, k, WORDS);
  const on = [{ input: words.input, left: Math.round(pad.x * k), top: Math.round(pad.y * k) + words.lead }];
  return paper(
    Math.round(p.x * k),
    Math.round(p.y * k),
    Math.round(p.w * k),
    words.tall + Math.round(2 * pad.y * k),
    k,
    {
      ...WORDS,
      on,
    },
  );
}
// How tall what's under a group stands in page px as the picture sets it: the room the store's picture of a page
// leaves it (bookpicture.ts).
export const underHigh = async (u: Under, dir: string) => (await under({ ...u, y: 0 }, 1, dir)).at(-1)?.foot ?? 0;
// What's under a group at its place on the picture: a scrap's words on their post-it, then its slips, its cards and its
// versions, each under the one before (cards, versions)
async function under(u: Under, k: number, dir: string) {
  const layers: (Layer & { foot: number })[] = [];
  let foot = Math.round(u.y * k);
  for (const make of [
    ...(u.text ? [() => posted(u, k)] : []),
    ...(u.slips ?? []).map(
      s => (top: number) => (s.name === null ? replied(s, u, top, k) : slipped(s, u, top, k, dir)),
    ),
    ...(u.asks ?? []).map(a => (top: number) => asked(a, u, top, k)),
    ...(u.tried ? [(top: number) => versioned(u.tried!, u, top, k, dir)] : []),
  ]) {
    const l = await make(foot);
    layers.push(l);
    foot = l.foot;
  }
  return layers;
}
// An agent's answer slipped under its group from top (picture px): its name and words on paper, its picture under them,
// its form under that
async function slipped(s: Said, u: Under, top: number, k: number, dir: string) {
  const { pad, name: face } = SLIP,
    x = Math.round(pad.x * k),
    inner = u.w - 2 * pad.x;
  const name = await block(
      `<span weight="bold" foreground="${face.ink}">${escaped(s.name ?? '')}</span>`,
      inner,
      k,
      face,
    ),
    words = await block(`<span foreground="${WORDS.ink}">${escaped(s.text)}</span>`, inner, k, SLIP.text);
  const at = Math.round(pad.top * k) + name.tall + Math.round(face.gap * k),
    on: OverlayOptions[] = [
      { input: name.input, left: x, top: Math.round(pad.top * k) + name.lead },
      { input: words.input, left: x, top: at + words.lead },
    ];
  let h = at + words.tall;
  if (s.picture) {
    const picture = await pictureAt(`${dir}/${s.picture}`, inner, k);
    on.push({ input: picture.input, left: x, top: h + Math.round(SLIP.picture * k) });
    h += Math.round(SLIP.picture * k) + picture.height;
  }
  if (s.form) {
    const form = await formed(s.form, inner, k);
    on.push({ input: form.input, left: x, top: h + Math.round(SLIP.picture * k) });
    h += Math.round(SLIP.picture * k) + form.height;
  }
  h += Math.round(pad.bottom * k);
  return paper(Math.round(u.x * k), top + Math.round(SLIP.gap * k), Math.round(u.w * k), h, k, { ...SLIP, on });
}
// The board's reply under an answer from top (picture px): "You" and its words
async function replied(s: Said, u: Under, top: number, k: number) {
  const { reply } = SLIP,
    at = top + Math.round(reply.gap * k),
    words = await block(
      `<span foreground="${WORDS.ink}"><b>You</b> ${escaped(s.text)}</span>`,
      u.w - reply.x,
      k,
      WORDS,
    );
  const left = Math.round((u.x + reply.x) * k);
  return {
    input: words.input,
    left,
    top: at + words.lead,
    width: words.width,
    height: words.height,
    foot: at + words.tall,
  };
}
// An agent's answer at its spot on the picture: its face (its initial on its ink) and name, its words in its hand, its
// picture taped in under them, its drawing from its top-left, on the paper as the book writes it
async function answered(a: Answer, k: number, dir: string): Promise<Layer> {
  const { pad, head, face, gap } = HAND,
    px = (n: number) => Math.round(n * k),
    across = a.w - 2 * pad;
  const name = await block(
      `<span weight="bold" foreground="${a.color}">${escaped(a.name)}</span>`,
      across - face - gap,
      k,
      HAND.name,
    ),
    words = await block(`<span weight="500" foreground="${a.color}">${escaped(a.text)}</span>`, across, k, HAND.text);
  const disc = faceDisc(a.name, a.color, face, 12, k);
  const on: OverlayOptions[] = [
    { input: disc, left: px(pad), top: px((head - face) / 2) },
    { input: name.input, left: px(pad + face + gap), top: Math.round((px(head) - name.height) / 2) },
    { input: words.input, left: px(pad), top: px(head + HAND.below) + words.lead },
  ];
  let h = px(head + HAND.below) + words.tall;
  if (a.picture) {
    const { x, top, frame, bottom } = HAND.picture,
      picture = await pictureAt(`${dir}/${a.picture}`, across - 2 * x - 2 * frame, k, true);
    const framed = await sharp({
      create: {
        width: picture.width + px(2 * frame),
        height: picture.height + px(2 * frame),
        channels: 4,
        background: '#fff',
      },
    })
      .composite([{ input: picture.input, left: px(frame), top: px(frame) }])
      .png()
      .toBuffer();
    on.push({ input: framed, left: px(pad + x), top: h + px(top) });
    h += px(top + 2 * frame + bottom) + picture.height;
  }
  const foot = Math.max(0, ...(a.ink ?? []).flatMap(s => s.points.map(([, y]) => y + s.size / 2)));
  if (a.ink?.length) {
    h = Math.max(h, px(foot + 8));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px(a.w)}" height="${h}" viewBox="0 0 ${a.w} ${h / k}">${pathsOf(a.ink)}</svg>`;
    on.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  const input = await sharp({
    create: { width: px(a.w), height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(on)
    .png()
    .toBuffer();
  return { input, left: px(a.x), top: px(a.y), width: px(a.w), height: h };
}
// Only the part of a layer inside the W × H picture (a box may start left of the page's top-left), none when none is
async function inside(l: Layer, W: number, H: number): Promise<OverlayOptions[]> {
  const x0 = Math.max(0, l.left),
    y0 = Math.max(0, l.top),
    width = Math.min(l.left + l.width, W) - x0,
    height = Math.min(l.top + l.height, H) - y0;
  if (width <= 0 || height <= 0) return [];
  if (width === l.width && height === l.height) return [{ input: l.input, left: l.left, top: l.top }];
  const cut = { left: x0 - l.left, top: y0 - l.top, width, height },
    input = await sharp(l.input).extract(cut).png().toBuffer();
  return [{ input, left: x0, top: y0 }];
}

// A box's words set at k picture px a page px, in the typed words' face or another's (from typed and typedHeight)
const setText = (t: Omit<Typed, 'x' | 'y'>, k: number, face: Face = TEXT) =>
  setMarkup(`<span foreground="${t.color}">${escaped(t.text)}</span>`, t.w, k, face);
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
