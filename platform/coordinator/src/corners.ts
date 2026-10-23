// A kept box's four corners in the model's edit, from the place and scale the search found it at (match.ts): the model
// hands the photo back squared up (turned a degree or two, its perspective straightened), which no scaled box lines up
// with at the finer steps. Coarse to fine, each corner moves a little at a time for as long as the box's pixels, warped
// onto the four, match the edit better; how sure is then judged on the box warped there, in colour (retouch.ts pastes it).
import { CONFIRM_SIDE, FIT_SIDE, MATCH_MIN, boxText, clip, grow, planeOf, templateOf } from './match.ts';
import type { Box, Picture, Spot } from './match.ts';
import { around, bilinear, homography, mapped, rectangle } from './warp.ts';
import type { Quad } from './warp.ts';

export type Fit = { corners: Quad; score: number };

// The fit's steps: the box's longer side at FIT_SIDE pixels, then twice that at each step up to LEVELS of them (never
// finer than the edit's own); at each, a corner moves FIRST_MOVE of its pixels at a time (NEXT_MOVE after the first
// step, which leaves it closer than that), halved down to LAST_MOVE, at most ROUNDS times over at each length
const LEVELS = 4,
  FIRST_MOVE = 2,
  NEXT_MOVE = 0.5,
  LAST_MOVE = 0.125,
  ROUNDS = 12;

// The box's corners in the edit, how surely it is there; or why it isn't kept
export async function fit(before: Picture, after: Picture, box: Box, spot: Spot): Promise<Fit | string> {
  let corners = rectangle(box.w, box.h).map(p => ({
    x: spot.x + spot.scale * p.x,
    y: spot.y + spot.scale * p.y,
  })) as Quad;
  for (let level = 0; level < LEVELS; level++) {
    const step = Math.max(1, (scaleOf(box, corners) * Math.max(box.w, box.h)) / (FIT_SIDE * 2 ** level));
    const score = await scorer(before, after, box, corners, step, 1);
    corners = climb(score, corners, (level ? NEXT_MOVE : FIRST_MOVE) * step, LAST_MOVE * step);
    if (step === 1) break;
  }
  const at = around(corners);
  // (a box that fills the picture may end a fraction of a pixel past its edge)
  if (corners.some(p => p.x < -1 || p.y < -1 || p.x > after.width + 1 || p.y > after.height + 1))
    return `the edit's frame cuts it (it would sit at ${boxText(at)} in a ${after.width} × ${after.height} edit)`;
  const step = Math.max(1, (scaleOf(box, corners) * Math.max(box.w, box.h)) / CONFIRM_SIDE),
    score = (await scorer(before, after, box, corners, step, 3))(corners);
  if (score < MATCH_MIN)
    return `the edit doesn't hold it surely (best match ${score.toFixed(2)} at ${boxText(at)}, under ${MATCH_MIN})`;
  return { corners, score };
}

// edit pixels for one of the box's: its four sides' lengths over the box's
export function scaleOf(box: Box, corners: Quad) {
  const length = (i: number) =>
    Math.hypot(corners[(i + 1) % 4].x - corners[i].x, corners[(i + 1) % 4].y - corners[i].y);
  return (length(0) + length(1) + length(2) + length(3)) / (2 * (box.w + box.h));
}

// The corners moved together: each alone, each side's two (a box leaning a little is put upright by moving one side's
// pair), and all four (a box a little off as a whole)
const GROUPS = [[0], [1], [2], [3], [0, 1], [1, 2], [2, 3], [3, 0], [0, 1, 2, 3]];

// Each group of corners in turn moved a few pixels each way, kept where the match is better, the moves halved when none is
function climb(score: (corners: Quad) => number, start: Quad, first: number, last: number) {
  let corners = start,
    best = score(start);
  for (let move = first; move >= last; move /= 2)
    for (let round = 0, better = true; better && round < ROUNDS; round++) {
      better = false;
      for (const group of GROUPS)
        for (const [dx, dy] of [
          [move, 0],
          [-move, 0],
          [0, move],
          [0, -move],
        ]) {
          const tried = corners.map((p, i) => (group.includes(i) ? { x: p.x + dx, y: p.y + dy } : p)) as Quad,
            value = score(tried);
          if (value > best) [best, corners, better] = [value, tried, true];
        }
    }
  return corners;
}

// How well the box, warped onto some corners near these, matches the edit at a step (edit pixels for one of the
// match's): normalised cross-correlation per channel, as match.ts's; -1 for corners that reach past the edit's region
async function scorer(before: Picture, after: Picture, box: Box, near: Quad, step: number, channels: 1 | 3) {
  const template = await templateOf(before, box, scaleOf(box, near), step, channels),
    reach = (FIRST_MOVE * ROUNDS + 2) * step,
    region = clip(grow(around(near), reach, reach), after),
    edit = await planeOf(
      after,
      region,
      Math.max(2, Math.round(region.w / step)),
      Math.max(2, Math.round(region.h / step)),
      channels,
    );
  const regionStep = { x: region.w / edit.width, y: region.h / edit.height },
    { grown } = template,
    n = template.width * template.height;
  return (corners: Quad) => {
    const toEdit = homography(rectangle(box.w, box.h), corners),
      sums = [0, 0, 0];
    let squares = 0,
      product = 0;
    for (let j = 0; j < template.height; j++)
      for (let i = 0; i < template.width; i++) {
        // (the template pixel's centre in the box, then in the edit's region at the step, 0 at its first pixel's centre)
        const { x, y } = mapped(
            toEdit,
            grown.x - box.x + ((i + 0.5) * grown.w) / template.width,
            grown.y - box.y + ((j + 0.5) * grown.h) / template.height,
          ),
          ex = (x - region.x) / regionStep.x - 0.5,
          ey = (y - region.y) / regionStep.y - 0.5;
        for (let channel = 0; channel < channels; channel++) {
          const value = bilinear(edit.pixels, edit.width, edit.height, channels, channel, ex, ey);
          if (Number.isNaN(value)) return -1;
          sums[channel] += value;
          squares += value * value;
          product += template.pixels[(j * template.width + i) * channels + channel] * value;
        }
      }
    const spread = squares - sums.reduce((all, sum) => all + sum * sum, 0) / n;
    return spread > 0 && template.energy > 0 ? product / Math.sqrt(template.energy * spread) : 0;
  };
}
