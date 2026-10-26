// A page's parts as a save or a new page brings them (book.ts), and a note's (booknotes.ts), each checked, or refused
// with why: a page is kept whole or not at all.
import * as pictures from './pictures.ts';
import { MAX_SCRAPS } from './pagescraps.ts';
import { noKeys } from '../../../shared/review/anchor.js';

// The ink a page holds. The page draws all of it again at every undo, redo and
// stroke the eraser takes, and the coordinator once more for its picture (bookrender.ts): ink.js
// draws a point (a disc and the band to the one before) in about 7.5 µs on one core of the worker, measured over 50,000
// to 200,000 points, and a one-point stroke costs the same as a point. MAX_POINTS keeps that whole redraw under a second
// on a tablet's core, so undo still answers; every stroke has a point, so it bounds the strokes too. A page that would
// pass it is refused whole (FULL), and the page says to start a new page.
export const MAX_POINTS = 120_000;
// A page grows downward as it's written on (the book), to GROWN_MAX; a new one is a screen or so.
const PAGE = { min: 100, max: 4000 },
  GROWN_MAX = 20_000,
  SIZE = { min: 0.5, max: 200 },
  LABEL_MAX = 80;
// A save's JSON: the ink and the scraps (the picture is drawn by the coordinator: bookrender.ts). ink.js writes a
// point's x, y and pressure to 2 decimals and t in whole ms, at most 40 bytes, and a stroke's colour, size and alpha in
// under 100, so at most 140 for a stroke of one point. A scrap is its file's name and five numbers, under 200. A note's
// body is its snip (a picture in base64, 4 bytes for every 3) and its anchor (ink as a page's, and a little more).
export const SAVE_MAX = 100 + MAX_POINTS * 140 + MAX_SCRAPS * 200,
  NOTE_MAX = Math.ceil(pictures.MAX_BYTES / 3) * 4 + MAX_POINTS * 140 + 64 * 1024;
export const FULL = 'This page is full: start a new page to keep drawing (undo the last lines to save this one)';
// (every check refuses the same way: a [status, why] pair)
export type Refused = [number, string];
export const isRefused = (v: unknown): v is Refused => Array.isArray(v) && typeof v[0] === 'number';

// A page's side: whole CSS px within PAGE, or the refusal
export const pageSide = (v: unknown): number | Refused =>
  Number.isInteger(v) && Number(v) >= PAGE.min && Number(v) <= PAGE.max
    ? Number(v)
    : [400, `a page is whole CSS px, ${PAGE.min} to ${PAGE.max} on each side`];
// A page's height once it has grown: whole CSS px, from what it was made to GROWN_MAX
export const grownTo = (v: unknown, h: number): number | Refused =>
  v === undefined
    ? h
    : Number.isInteger(v) && Number(v) >= PAGE.min && Number(v) <= GROWN_MAX
      ? Number(v)
      : [400, `a page grows to whole CSS px, at most ${GROWN_MAX}`];
// A label as one line, trimmed, or the refusal
export function labelOf(v: unknown): string | Refused {
  if (typeof v !== 'string') return [400, 'a label is text'];
  const label = v.replace(/\s+/g, ' ').trim();
  return label.length > LABEL_MAX ? [400, `a label is at most ${LABEL_MAX} characters`] : label;
}
// The strokes as HQ sent them, every one checked, or the refusal. Nothing is cut: a page is kept whole or not at all.
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
export function dataUrlPicture(v: unknown): Refused | { type: string; clean: Buffer } {
  const m = typeof v === 'string' ? /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(v) : null;
  if (!m) return [400, 'the picture is a PNG or JPEG data URL'];
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length > pictures.MAX_BYTES) return [413, 'the picture is too large'];
  return pictures.picture(raw) ?? [400, 'not a picture we can read'];
}

// ---------------------------------------------------------------- a note
// Where a note is (anchor.js's v1 shape), all lengths in document CSS px, scroll-independent:
// { v: 1, url (fragment values left out), el: { selector, tag, text (≤ 200), box: { x, y, w, h } } | null,
// view: { w, h, x, y, dpr }, ink: [ink.js strokes, points in document px] }. el is the element the mark is on (null: the
// bare page); its text is empty inside [data-private] and never an input's value (anchor.js's rule, browser-side).
// Only the shape is checked here: drawing it again on a page that has reflowed is the browser's.
export type Anchor = {
  v: 1;
  url: string;
  el: { selector: string; tag: string; text: string; box: Box } | null;
  view: Box & { dpr: number };
  ink: Stroke[];
};
type Box = { x: number; y: number; w: number; h: number };
const ANCHOR_TEXT = 200,
  SELECTOR_MAX = 1000,
  URL_MAX = 2000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const boxOf = (b: any, keys = ['x', 'y', 'w', 'h']) =>
  b && typeof b === 'object' && keys.every(k => finite(b[k])) ? b : null;
export function anchorOf(v: any): Anchor | Refused {
  if (!v || typeof v !== 'object' || v.v !== 1) return [400, 'an anchor is version 1: { v: 1, url, el, view, ink }'];
  if (typeof v.url !== 'string' || !v.url || v.url.length > URL_MAX || !URL.canParse(v.url, 'https://x'))
    return [400, "an anchor's url is the page's address"];
  const el = v.el;
  if (el !== null) {
    if (!el || typeof el !== 'object' || !boxOf(el.box))
      return [400, "an anchor's el is null or { selector, tag, text, box }"];
    if (
      typeof el.selector !== 'string' ||
      el.selector.length > SELECTOR_MAX ||
      typeof el.tag !== 'string' ||
      el.tag.length > 40
    )
      return [400, "an anchor's el names its element: a selector and a tag"];
    if (typeof el.text !== 'string' || [...el.text].length > ANCHOR_TEXT)
      return [400, `an anchor's element text is at most ${ANCHOR_TEXT} characters`];
  }
  if (!boxOf(v.view, ['w', 'h', 'x', 'y', 'dpr'])) return [400, "an anchor's view is { w, h, x, y, dpr }, numbers"];
  const ink = inkOf(v.ink);
  if (isRefused(ink)) return ink;
  const box = (b: any) => ({ x: b.x, y: b.y, w: b.w, h: b.h });
  return {
    v: 1,
    url: noKeys(v.url),
    el: el && { selector: el.selector, tag: el.tag, text: el.text, box: box(el.box) },
    view: { ...box(v.view), dpr: v.view.dpr },
    ink,
  };
}
// A note's words, spoken, typed or written (read from handwriting), as one trimmed text, or the refusal
export const WORDS_MAX = 4000;
export const SAID = ['spoken', 'typed', 'written'] as const;
export function wordsOf(v: unknown, said: unknown): { words: string; said: string | null } | Refused {
  if (v == null || v === '') return { words: '', said: null };
  if (typeof v !== 'string') return [400, "a note's words are text"];
  const words = v.trim();
  if ([...words].length > WORDS_MAX) return [400, `a note's words are at most ${WORDS_MAX} characters`];
  if (!SAID.includes(said as (typeof SAID)[number])) return [400, `said is how the words came: ${SAID.join(', ')}`];
  return { words, said: words ? (said as string) : null };
}
// Whether a note asks now: its words end in a question mark (any script's: ？ too)
export const asks = (words: string) => /[?？]\s*$/.test(words);
