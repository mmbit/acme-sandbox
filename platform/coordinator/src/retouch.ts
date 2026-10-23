// The photo studio's retouch (studio.ts), plain geometry with no model: the keeper's crop of the board's photo before
// the image model edits it, and the boxes of the board's own pixels pasted back over the edit after it.
// (the warped paste: job #14464)
import sharp from 'sharp';
import { clip, find, frameOf, pictureOf } from './match.ts';
import { fit, scaleOf } from './corners.ts';
import { around, bicubic, homography, inverse, mapped, rectangle } from './warp.ts';
import { median } from './arithmetic.ts';
import type { Box, Picture } from './match.ts';
import type { Fit } from './corners.ts';
import type { Quad } from './warp.ts';

export type { Box } from './match.ts';
export { boxText } from './match.ts';
// a kept box: where it went in the edit (its corners there, from its top-left clockwise, and the box round them), how
// sure the match was (0 to 1) and the light put on it; or why it didn't
export type Kept =
  { box: Box; at: Box; corners: number[][]; match: number; gain: number[] } | { box: Box; missing: string };

const JPEG = { quality: 95, chromaSubsampling: '4:4:4' } as const;
// the paste: its edge fades in over FEATHER pixels of the edit, its light from a ring just outside it, RING of the box's
// shorter side (at least 3 pixels), as a gain between these
const FEATHER = 4,
  RING = 0.06,
  GAIN = [0.5, 2];

// "x,y,w,h" in whole pixels, or null
export function boxFrom(text: unknown): Box | null {
  const parts = /^(\d+),(\d+),(\d+),(\d+)$/.exec(String(text ?? '').replace(/\s/g, ''));
  if (!parts) return null;
  const [x, y, w, h] = parts.slice(1).map(Number);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
export const inside = (b: Box, outer: Box) =>
  b.x >= outer.x && b.y >= outer.y && b.x + b.w <= outer.x + outer.w && b.y + b.h <= outer.y + outer.h;

// The photo turned clockwise by quarter turns (its pixels moved, none redrawn), then cut to the box in the turned
// photo's pixels, in its own format (the turn)
export async function framed(picture: Buffer, type: string, turn: number, box: Box | null) {
  const turned = sharp(picture).rotate(turn),
    region = box ? turned.extract({ left: box.x, top: box.y, width: box.w, height: box.h }) : turned;
  return (type === 'image/png' ? region.png() : region.jpeg(JPEG)).toBuffer();
}

// Each box of the photo as it went to the model (input), found in the model's edit, its corners fitted there, and its
// own pixels warped onto them over the edit, their light matched to the edit's around them. A box it can't find surely, or whose light it can't
// measure, stays the model's, and says why.
export async function keepBoxes(input: Buffer, edit: Buffer, type: string, boxes: Box[]) {
  const before = await pictureOf(input),
    after = await pictureOf(edit),
    frame = await frameOf(before, after),
    kept: Kept[] = [];
  for (const box of boxes) {
    const spot = await find(before, after, box, frame),
      fitted = typeof spot === 'string' ? spot : await fit(before, after, box, spot);
    kept.push({ box, ...(typeof fitted === 'string' ? { missing: fitted } : paste(before, after, box, fitted)) });
  }
  if (!kept.some(k => 'at' in k)) return { picture: edit, kept };
  const out = sharp(after.pixels, { raw: { width: after.width, height: after.height, channels: 3 } });
  return { picture: await (type === 'image/png' ? out.png() : out.jpeg(JPEG)).toBuffer(), kept };
}

// ---- the paste
// The box's own pixels warped onto its corners in the edit, in the edit's light: where it went and how; or why it wasn't
function paste(before: Picture, after: Picture, box: Box, { corners, score }: Fit) {
  const toEdit = homography(rectangle(box.w, box.h), corners),
    toBox = inverse(toEdit),
    scale = scaleOf(box, corners),
    ring = Math.max(3, Math.round(RING * Math.min(box.w, box.h))),
    ringed = rectangle(box.w + 2 * ring, box.h + 2 * ring).map(p => mapped(toEdit, p.x - ring, p.y - ring)) as Quad,
    reach = clip(around(ringed), after);
  // the board's pixel at each of the edit's within reach, and how deep in the box it lies, in edit pixels (NaN: past
  // the ring or the photo; under 0: in the ring)
  const own = new Float32Array(reach.w * reach.h * 3),
    depth = new Float32Array(reach.w * reach.h).fill(NaN);
  for (let y = 0; y < reach.h; y++)
    for (let x = 0; x < reach.w; x++) {
      const { x: u, y: v } = mapped(toBox, reach.x + x + 0.5, reach.y + y + 0.5),
        at = y * reach.w + x;
      if (u < -ring || v < -ring || u > box.w + ring || v > box.h + ring) continue;
      for (let channel = 0; channel < 3; channel++)
        own[at * 3 + channel] = bicubic(
          before.pixels,
          before.width,
          before.height,
          3,
          channel,
          box.x + u - 0.5,
          box.y + v - 0.5,
        );
      if (!Number.isNaN(own[at * 3])) depth[at] = Math.min(u, v, box.w - u, box.h - v) * scale;
    }
  const gain = lightOf(own, depth, after, reach);
  if (typeof gain === 'string') return { missing: gain };
  for (let y = 0; y < reach.h; y++)
    for (let x = 0; x < reach.w; x++) {
      const at = y * reach.w + x,
        alpha = Math.min(1, (depth[at] + 0.5) / (FEATHER + 1)),
        to = ((reach.y + y) * after.width + reach.x + x) * 3;
      if (!(depth[at] > 0)) continue;
      for (let channel = 0; channel < 3; channel++) {
        const mine = Math.min(255, Math.max(0, own[at * 3 + channel] * gain[channel]));
        after.pixels[to + channel] = Math.round(after.pixels[to + channel] * (1 - alpha) + mine * alpha);
      }
    }
  return {
    at: around(corners),
    corners: corners.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
    match: Math.round(score * 100) / 100,
    gain: gain.map(g => Math.round(g * 100) / 100),
  };
}

// The gain per channel that brings the photo's light to the edit's: the median ratio, edit over photo, of the ring
// around the box (where both have it, skipping near-black pixels whose ratio is noise); or why it can't be measured.
// own and depth: the board's pixels over the edit's region `reach`, and how deep in the box each is (paste).
function lightOf(own: Float32Array, depth: Float32Array, after: Picture, reach: Box) {
  const ratios: number[][] = [[], [], []];
  for (let y = 0; y < reach.h; y++)
    for (let x = 0; x < reach.w; x++) {
      const at = y * reach.w + x,
        to = ((reach.y + y) * after.width + reach.x + x) * 3;
      if (!(depth[at] <= 0)) continue;
      for (let channel = 0; channel < 3; channel++) {
        const mine = own[at * 3 + channel],
          theirs = after.pixels[to + channel];
        if (mine > 16 && theirs > 16) ratios[channel].push(theirs / mine);
      }
    }
  const medians = ratios.map(median);
  if (medians.some(m => m === null))
    return "the light around it can't be measured (it fills the picture, or its surroundings are black)";
  return medians.map(m => Math.min(GAIN[1], Math.max(GAIN[0], m!)));
}
