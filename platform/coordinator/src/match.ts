// Where a box of one picture went in another that scaled and moved it, the photo studio's model edit (retouch.ts):
// coarse to fine, by normalised cross-correlation, to where corners.ts fits its four corners.
// (the corners: job #14464)
import sharp from 'sharp';

// a box in a picture's pixels, as the keeper writes it: x,y,w,h
export type Box = { x: number; y: number; w: number; h: number };
// pixels: RGB, 8 bits a channel; gray: one channel
export type Picture = { width: number; height: number; pixels: Buffer; gray: Buffer };
// grey (one channel) for the search, colour (three) for how sure: a red sticker and a green leaf can be the same grey
export type Plane = { width: number; height: number; channels: 1 | 3; pixels: Float32Array };
export type Template = Plane & { energy: number; grown: Box };
// the box's top-left in the edit, in the edit's own pixels, at a scale (edit pixels for one of the photo's)
export type Spot = { scale: number; x: number; y: number; score: number };
export type Frame = Spot & { margin: Box };
type Range = { min: number; max: number };
// where a top-left may be, in some picture's pixels
type Window = { x: Range; y: Range };

// The search, coarse to fine: the edit first at about COARSE_EDIT pixels a side with the box about COARSE_SIDE (enough
// for its layout, too few for its letters, which the model redraws), then three times finer each step to the edit's
// own pixels, or to the box at FIT_SIDE pixels for a kept box, whose corners corners.ts fits from there (a scaled box
// lines up with a squared-up edit no finer). A box smaller than MIN_SIDE at a step brings that much of its
// surroundings, to have a layout to match. A step is the edit's pixels for one of the search's at that step (1: the
// edit's own).
const COARSE_EDIT = 320,
  COARSE_SIDE = 40,
  MIN_SIDE = 24,
  FINER = 3;
export const FIT_SIDE = 48;
// The model keeps the product in place and scales the picture into its frame, so the whole photo is looked for first
// (its middle, less FRAME_MARGIN of each side, which a frame closer than the photo still holds), to FRAME_SIDE pixels
// a side: a scale between fitting the photo inside the edit and filling it (with SCALE_SLACK either way), within
// WINDOW of the edit from where a centred scale puts it. Where the edit holds it, every box is looked for at its
// place, within NEAR (the model's degree or two of turn, squaring the photo up, moves a box that much). Where it
// doesn't (the product small in a photo whose setting the model changed), each box is looked for as the photo was.
const SCALE_SLACK = 1.35,
  WINDOW = 0.25,
  FRAME_MARGIN = 0.2,
  FRAME_SIDE = 512,
  NEAR = 0.02;
// How sure: the box's correlation with the edit at about CONFIRM_SIDE pixels a side, where a redrawn letter is a blur
// like the one it replaces. A label with its letters retyped still matches about 0.9 there, a box the edit doesn't
// hold well under.
export const CONFIRM_SIDE = 64,
  MATCH_MIN = 0.7;
const PLAIN = 4; // (a box whose grey spreads less than this, of 255, has nothing in it to find)

export const boxText = (b: Box) => `${b.x},${b.y},${b.w},${b.h}`;

export async function pictureOf(file: Buffer): Promise<Picture> {
  const { data: pixels, info: size } = await sharp(file)
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true }),
    raw = { raw: { width: size.width, height: size.height, channels: 3 as const } };
  const gray = await sharp(pixels, raw).greyscale().raw().toBuffer();
  return { width: size.width, height: size.height, pixels, gray };
}

// One box's search: the two pictures, the box, the scales the model could have used, where the photo's top-left sits
// in the edit (null: centred) and how far from there to look, a share of the edit's size
type Search = {
  before: Picture;
  after: Picture;
  box: Box;
  low: number;
  high: number;
  origin: { x: number; y: number } | null;
  window: number;
  channels: 1 | 3;
};
function broad(before: Picture, after: Picture, box: Box): Search {
  const fit = [after.width / before.width, after.height / before.height];
  const low = Math.min(...fit) / SCALE_SLACK,
    high = Math.max(...fit) * SCALE_SLACK;
  return { before, after, box, low, high, origin: null, window: WINDOW, channels: 1 };
}
// (the frame's spot is its box's: the photo's top-left is that box's corner less its margin)
function near(before: Picture, after: Picture, box: Box, frame: Frame): Search {
  const origin = { x: frame.x - frame.scale * frame.margin.x, y: frame.y - frame.scale * frame.margin.y };
  return {
    before,
    after,
    box,
    low: frame.scale / (1 + NEAR),
    high: frame.scale * (1 + NEAR),
    origin,
    window: NEAR,
    channels: 1,
  };
}

// The photo's place in the edit, if the edit surely holds it
export async function frameOf(before: Picture, after: Picture): Promise<Frame | null> {
  const whole = { x: 0, y: 0, w: before.width, h: before.height },
    margin = clip(grow(whole, -FRAME_MARGIN * before.width, -FRAME_MARGIN * before.height), before),
    search = broad(before, after, margin),
    spot = await place(search, (search.low * Math.max(margin.w, margin.h)) / FRAME_SIDE);
  return spot && (await sure(search, spot)) >= MATCH_MIN ? { ...spot, margin } : null;
}

// The box's spot in the edit, near the photo's frame in it if there is one, for corners.ts to fit; or why it can't be
export const find = (before: Picture, after: Picture, box: Box, frame: Frame | null) =>
  spotIn(frame ? near(before, after, box, frame) : broad(before, after, box));

async function spotIn(search: Search): Promise<Spot | string> {
  const { before, after, box } = search,
    plain = await templateOf(before, box, 1, 1, 1);
  if (Math.sqrt(plain.energy / (plain.width * plain.height)) < PLAIN) return 'it is plain, with nothing in it to find';
  const spot = await place(search, Math.max(1, (search.high * Math.max(box.w, box.h)) / FIT_SIDE));
  if (!spot) return 'it is bigger than the edit at any scale the model could have used';
  const at = placed(box, spot);
  if (at.x < 0 || at.y < 0 || at.x + at.w > after.width || at.y + at.h > after.height)
    return `the edit's frame cuts it (it would sit at ${boxText(at)} in a ${after.width} × ${after.height} edit)`;
  return spot;
}

// The search's best spot, coarse down to the finest step, or null if the box fits nowhere
async function place(search: Search, finest: number) {
  let spots = await coarse(search);
  for (let step = coarseStep(search); step > finest;) {
    step = Math.max(finest, step / FINER);
    const atStep = step;
    spots = await Promise.all(spots.map(spot => refine(search, spot, atStep)));
  }
  return spots.sort((a, b) => b.score - a.score)[0] ?? null;
}

// How surely the edit holds the box at the spot: its match in colour at CONFIRM_SIDE
async function sure(search: Search, spot: Spot) {
  const step = Math.max(1, (spot.scale * Math.max(search.box.w, search.box.h)) / CONFIRM_SIDE);
  return (await refine({ ...search, channels: 3 }, spot, step, 1)).score;
}

const coarseStep = (search: Search) =>
  Math.max(
    1,
    (Math.sqrt(search.low * search.high) * Math.max(search.box.w, search.box.h)) / COARSE_SIDE,
    Math.max(search.after.width, search.after.height) / COARSE_EDIT,
  );

// Every scale from low to high, a template pixel apart from their middle, over the window: the three best places
async function coarse(search: Search) {
  const { before, after, box } = search,
    step = coarseStep(search),
    whole = { x: 0, y: 0, w: after.width, h: after.height },
    edit = await planeOf(after, whole, Math.round(after.width / step), Math.round(after.height / step), 1);
  const found: Spot[] = [],
    ratio = 1 + 1 / COARSE_SIDE,
    middle = Math.sqrt(search.low * search.high),
    perSide = Math.floor(Math.log(search.high / search.low) / Math.log(ratio) / 2);
  for (let k = -perSide; k <= perSide; k++) {
    const scale = middle * ratio ** k,
      template = await templateOf(before, box, scale, step, 1),
      within = scaledWindow(forTemplate(windowOf(search, scale), box, template, scale), 1 / step);
    const top = best(template, edit, within);
    if (top) found.push(spotOf(box, template, scale, top.x * step, top.y * step, top.score));
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 3);
}

// One step finer: the place within `reach` of the step's pixels, then the scale a template pixel at a time about the
// box's centre, within the search's scales, for as long as it matches better
async function refine(search: Search, spot: Spot, step: number, reach = FINER + 1) {
  let closest = await around(search, spot, step, reach);
  for (const way of [1, -1])
    for (;;) {
      const scale = closest.spot.scale * (1 + way / closest.side);
      if (scale < search.low || scale > search.high) break;
      const tried = await around(search, rescaled(search.box, closest.spot, scale), step, 1);
      if (tried.spot.score <= closest.spot.score) break;
      closest = tried;
    }
  return closest.spot;
}
const rescaled = (box: Box, spot: Spot, scale: number): Spot => ({
  ...spot,
  scale,
  x: spot.x + ((spot.scale - scale) * box.w) / 2,
  y: spot.y + ((spot.scale - scale) * box.h) / 2,
});

// The best spot within `reach` of this one at a step, with its template's longer side (a scale's pixel at the step)
async function around(search: Search, spot: Spot, step: number, reach: number) {
  const { before, after, box } = search,
    template = await templateOf(before, box, spot.scale, step, search.channels),
    side = Math.max(template.width, template.height, 1),
    grownAt = {
      x: spot.x + spot.scale * (template.grown.x - box.x),
      y: spot.y + spot.scale * (template.grown.y - box.y),
    },
    pad = (reach + 2) * step;
  const region = clip(
      {
        x: grownAt.x - pad,
        y: grownAt.y - pad,
        w: template.width * step + 2 * pad,
        h: template.height * step + 2 * pad,
      },
      after,
    ),
    edit = await planeOf(
      after,
      region,
      Math.max(1, Math.round(region.w / step)),
      Math.max(1, Math.round(region.h / step)),
      search.channels,
    );
  // (the region's own step, a hair from the step's after rounding)
  const regionStep = { x: region.w / edit.width, y: region.h / edit.height },
    inRegion = (w: Window): Window => ({
      x: { min: (w.x.min - region.x) / regionStep.x, max: (w.x.max - region.x) / regionStep.x },
      y: { min: (w.y.min - region.y) / regionStep.y, max: (w.y.max - region.y) / regionStep.y },
    });
  const reachable = inRegion({
      x: { min: grownAt.x - reach * regionStep.x, max: grownAt.x + reach * regionStep.x },
      y: { min: grownAt.y - reach * regionStep.y, max: grownAt.y + reach * regionStep.y },
    }),
    allowed = inRegion(forTemplate(windowOf(search, spot.scale), box, template, spot.scale));
  const top = best(template, edit, both(reachable, allowed));
  if (!top) return { side, spot: { ...spot, score: -1 } };
  const x = region.x + top.x * regionStep.x,
    y = region.y + top.y * regionStep.y;
  return { side, spot: spotOf(box, template, spot.scale, x, y, top.score) };
}

// Where the box's top-left may be in the edit at a scale: the search's window about where its origin puts it
function windowOf(search: Search, scale: number): Window {
  const { before, after, box } = search,
    origin = search.origin ?? {
      x: (after.width - scale * before.width) / 2,
      y: (after.height - scale * before.height) / 2,
    },
    x = origin.x + scale * box.x,
    y = origin.y + scale * box.y,
    dx = search.window * after.width,
    dy = search.window * after.height;
  return { x: { min: x - dx, max: x + dx }, y: { min: y - dy, max: y + dy } };
}
// the same for a template's grown box
function forTemplate(w: Window, box: Box, template: Template, scale: number): Window {
  const dx = scale * (template.grown.x - box.x),
    dy = scale * (template.grown.y - box.y);
  return { x: { min: w.x.min + dx, max: w.x.max + dx }, y: { min: w.y.min + dy, max: w.y.max + dy } };
}
const scaledWindow = (w: Window, by: number): Window => ({
  x: { min: w.x.min * by, max: w.x.max * by },
  y: { min: w.y.min * by, max: w.y.max * by },
});
const both = (a: Window, b: Window): Window => ({
  x: { min: Math.max(a.x.min, b.x.min), max: Math.min(a.x.max, b.x.max) },
  y: { min: Math.max(a.y.min, b.y.min), max: Math.min(a.y.max, b.y.max) },
});

// a template's place (its grown box's top-left, in the edit's pixels) as the kept box's spot
const spotOf = (box: Box, template: Template, scale: number, x: number, y: number, score: number): Spot => ({
  scale,
  x: x - scale * (template.grown.x - box.x),
  y: y - scale * (template.grown.y - box.y),
  score,
});
const placed = (box: Box, spot: Spot): Box => ({
  x: Math.round(spot.x),
  y: Math.round(spot.y),
  w: Math.round(spot.scale * box.w),
  h: Math.round(spot.scale * box.h),
});

// The box at a scale and step, grown to MIN_SIDE there if it is smaller, less each channel's mean
export async function templateOf(
  before: Picture,
  box: Box,
  scale: number,
  step: number,
  channels: 1 | 3,
): Promise<Template> {
  const side = (MIN_SIDE * step) / scale,
    grown = clip(grow(box, Math.max(0, (side - box.w) / 2), Math.max(0, (side - box.h) / 2)), before),
    width = Math.max(2, Math.round((scale * grown.w) / step)),
    height = Math.max(2, Math.round((scale * grown.h) / step));
  const plane = await planeOf(before, grown, width, height, channels);
  let energy = 0;
  for (let channel = 0; channel < channels; channel++) {
    let mean = 0;
    for (let i = channel; i < plane.pixels.length; i += channels) mean += plane.pixels[i];
    mean /= width * height;
    for (let i = channel; i < plane.pixels.length; i += channels) {
      plane.pixels[i] -= mean;
      energy += plane.pixels[i] * plane.pixels[i];
    }
  }
  return { ...plane, energy, grown };
}

export async function planeOf(
  picture: Picture,
  region: Box,
  width: number,
  height: number,
  channels: 1 | 3,
): Promise<Plane> {
  const own = cut(channels === 1 ? picture.gray : picture.pixels, picture.width, channels, region),
    pixels = Float32Array.from(await resized(own, region, channels, width, height));
  return { width, height, channels, pixels };
}

// The region's pixels, cut out here: sharp would copy the whole picture in for each of the search's many small looks
export function cut(pixels: Buffer, width: number, channels: number, region: Box) {
  const out = Buffer.alloc(region.w * region.h * channels),
    row = region.w * channels;
  for (let y = 0; y < region.h; y++) {
    const from = ((region.y + y) * width + region.x) * channels;
    pixels.copy(out, y * row, from, from + row);
  }
  return out;
}

// The pixels at width × height, centre on centre: sharp's resize smooths a reduction, but moves an enlargement half a
// pixel, which its affine with half-pixel offsets doesn't
async function resized(pixels: Buffer, from: Box, channels: 1 | 3, width: number, height: number) {
  const input = sharp(pixels, { raw: { width: from.w, height: from.h, channels } }),
    larger = width > from.w || height > from.h,
    centred = { idx: 0.5, idy: 0.5, odx: -0.5, ody: -0.5, interpolator: 'bicubic' } as const;
  const out = larger
    ? input.affine([width / from.w, 0, 0, height / from.h], centred)
    : input.resize(width, height, { fit: 'fill' });
  // (sharp writes one channel out as three unless told it is grey)
  return (channels === 1 ? out.greyscale() : out).raw().toBuffer();
}

// The template's best place in the edit with its top-left within the window (where it fits), by normalised
// cross-correlation: 1 for the same picture under any brightness and contrast
function best(template: Template, edit: Plane, within: Window) {
  let top: { x: number; y: number; score: number } | null = null;
  const xs = {
      min: Math.max(0, Math.floor(within.x.min)),
      max: Math.min(edit.width - template.width, Math.ceil(within.x.max)),
    },
    ys = {
      min: Math.max(0, Math.floor(within.y.min)),
      max: Math.min(edit.height - template.height, Math.ceil(within.y.max)),
    };
  for (let y = ys.min; y <= ys.max; y++)
    for (let x = xs.min; x <= xs.max; x++) {
      const score = correlation(template, edit, x, y);
      if (!top || score > top.score) top = { x, y, score };
    }
  return top;
}

function correlation(template: Template, edit: Plane, x: number, y: number) {
  const { channels } = template,
    sums = [0, 0, 0],
    row = template.width * channels;
  let squares = 0,
    product = 0;
  for (let j = 0; j < template.height; j++) {
    const from = ((y + j) * edit.width + x) * channels,
      own = j * row;
    for (let i = 0; i < row; i++) {
      const value = edit.pixels[from + i];
      sums[i % channels] += value;
      squares += value * value;
      product += template.pixels[own + i] * value;
    }
  }
  const spread = squares - sums.reduce((all, sum) => all + sum * sum, 0) / (template.width * template.height);
  return spread > 0 && template.energy > 0 ? product / Math.sqrt(template.energy * spread) : 0;
}

export const grow = (b: Box, dx: number, dy: number): Box => ({
  x: b.x - dx,
  y: b.y - dy,
  w: b.w + 2 * dx,
  h: b.h + 2 * dy,
});
// the box in whole pixels, within the picture
export function clip(b: Box, picture: { width: number; height: number }): Box {
  const x = Math.max(0, Math.floor(b.x)),
    y = Math.max(0, Math.floor(b.y));
  return {
    x,
    y,
    w: Math.max(1, Math.min(picture.width, Math.ceil(b.x + b.w)) - x),
    h: Math.max(1, Math.min(picture.height, Math.ceil(b.y + b.h)) - y),
  };
}
