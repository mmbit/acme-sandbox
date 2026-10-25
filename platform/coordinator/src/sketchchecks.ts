// A sketch's parts as a save or a new page brings them (sketches.ts), each checked, or refused with why: a sketch is kept
// whole or not at all.
import * as pictures from './pictures.ts';
import { MAX_SCRAPS } from './sketchscraps.ts';

// The ink a sketch holds. The page draws all of it again at every undo, redo and
// stroke the eraser takes, and once more for the picture every save sends (sketchpen.js redraw, pictureOf): ink.js
// draws a point (a disc and the band to the one before) in about 7.5 µs on one core of the worker, measured over 50,000
// to 200,000 points, and a one-point stroke costs the same as a point. MAX_POINTS keeps that whole redraw under a second
// on a tablet's core, so undo still answers; every stroke has a point, so it bounds the strokes too. A page that would
// pass it is refused whole (FULL), and the page says to start a new sketch.
export const MAX_POINTS = 120_000;
const PAGE = { min: 100, max: 4000 },
  SIZE = { min: 0.5, max: 200 },
  LABEL_MAX = 80;
// A save's JSON: the picture in base64 (4 bytes for every 3) and the ink. ink.js writes a point's x, y and pressure
// to 2 decimals and t in whole ms, at most 40 bytes, and a stroke's colour, size and alpha in under 100, so at most
// 140 for a stroke of one point. A scrap is its file's name and five numbers, under 200.
export const SAVE_MAX = Math.ceil(pictures.MAX_BYTES / 3) * 4 + 100 + MAX_POINTS * 140 + MAX_SCRAPS * 200;
export const FULL = 'This sketch is full: start a new sketch to keep drawing (undo the last lines to save this one)';
// (every check refuses the same way: a [status, why] pair)
export type Refused = [number, string];
export const isRefused = (v: unknown): v is Refused => Array.isArray(v) && typeof v[0] === 'number';

// A page's side: whole CSS px within PAGE, or the refusal
export const pageSide = (v: unknown): number | Refused =>
  Number.isInteger(v) && Number(v) >= PAGE.min && Number(v) <= PAGE.max
    ? Number(v)
    : [400, `a page is whole CSS px, ${PAGE.min} to ${PAGE.max} on each side`];
// A label as one line, trimmed, or the refusal
export function labelOf(v: unknown): string | Refused {
  if (typeof v !== 'string') return [400, 'a label is text'];
  const label = v.replace(/\s+/g, ' ').trim();
  return label.length > LABEL_MAX ? [400, `a label is at most ${LABEL_MAX} characters`] : label;
}
// The strokes as HQ sent them, every one checked, or the refusal. Nothing is cut: a sketch is kept whole or not at all.
export type Stroke = NonNullable<ReturnType<typeof strokeOf>>;
export function inkOf(v: unknown): Stroke[] | Refused {
  if (!Array.isArray(v)) return [400, 'ink is a list of strokes'];
  let points = 0;
  const strokes: Stroke[] = [];
  for (const s of v) {
    const stroke = strokeOf(s);
    if (!stroke) return [400, 'a stroke is { color: "#rrggbb", size, alpha?, points: [[x, y, pressure, t], ...] }'];
    points += stroke.points.length;
    if (points > MAX_POINTS) return [413, FULL];
    strokes.push(stroke);
  }
  return strokes;
}
function strokeOf(s: any) {
  if (!s || typeof s !== 'object' || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  if (typeof s.size !== 'number' || !(s.size >= SIZE.min && s.size <= SIZE.max)) return null;
  if (s.alpha !== undefined && !(typeof s.alpha === 'number' && s.alpha >= 0 && s.alpha <= 1)) return null;
  const point = (p: unknown) => Array.isArray(p) && p.length === 4 && p.every(Number.isFinite);
  if (!Array.isArray(s.points) || !s.points.length || !s.points.every(point)) return null;
  const alpha = s.alpha === undefined ? {} : { alpha: s.alpha };
  return { color: s.color.toLowerCase(), size: s.size, ...alpha, points: s.points as number[][] };
}
// A data URL's picture, read by its bytes and stripped as an upload is (pictures.ts), or the refusal
export function pictureOf(v: unknown): Refused | { type: string; clean: Buffer } {
  const m = typeof v === 'string' ? /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(v) : null;
  if (!m) return [400, 'the picture is a PNG or JPEG data URL'];
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length > pictures.MAX_BYTES) return [413, 'the picture is too large'];
  return pictures.picture(raw) ?? [400, 'not a picture we can read'];
}
