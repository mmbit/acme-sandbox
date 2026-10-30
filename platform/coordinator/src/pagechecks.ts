// A page's parts as a save or a new page brings them (book.ts), and a note's (booknotes.ts), each checked, or refused
// with why: a page is kept whole or not at all.
import * as pictures from './pictures.ts';
import { MAX_SCRAPS } from './pagescraps.ts';
import { noKeys } from '../../../shared/review/anchor.js';
import { TEXT_MAX } from '../../hq/shell/ink/notebookparts.js';
import { LINE } from '../../hq/shell/ink/bookinkmath.js';

// The ink a page holds. The page draws all of it again at every undo, redo and
// stroke the eraser takes, and the coordinator once more for its picture (bookrender.ts): ink.js
// draws a point (a disc and the band to the one before) in about 7.5 µs on one core of the worker, measured over 50,000
// to 200,000 points, and a one-point stroke costs the same as a point. MAX_POINTS keeps that whole redraw under a second
// on a tablet's core, so undo still answers; every stroke has a point, so it bounds the strokes too. A page that would
// pass it is refused whole (FULL), and the page says to start a new page.
export const MAX_POINTS = 120_000;
// A page grows any way as it's written on (the book), to GROWN_MAX a side; a new one is a screen or so, its top-left at
// 0,0 where its heading is. Grown up or left, its top-left (x, y) is above or left of that, what's on it staying where
// it is. (PAGE: a new page's sides, exported for the sheet pages the coordinator makes: book.ts sheetPageFor.)
export const PAGE = { min: 100, max: 4000 };
// (GROWN_MAX exported for the answers the store types onto a page: booktyped.ts.)
export const GROWN_MAX = 20_000;
// (exported for a try's versions page title: ink/booktry.ts.)
export const LABEL_MAX = 80;
// Words typed on a page (the book's text tool): at most TEXTS_MAX boxes a page, each at most TEXT_MAX characters.
export const TEXTS_MAX = 200;
// (a box narrower than this wraps every letter: never one HQ makes)
const TEXT_W_MIN = 20;
// A save's JSON: the ink and the scraps (the picture is drawn by the coordinator: bookrender.ts). ink.js writes a
// point's x, y and pressure to 2 decimals and t in whole ms, at most 40 bytes, and a stroke's colour, size and alpha in
// under 100, so at most 140 for a stroke of one point. A scrap is its file's name and five numbers, under 200. A typed
// box is four numbers and a colour (under 100) and its words, 6 bytes a character at most as JSON escapes them.
// A note's
// body is its snip (a picture in base64, 4 bytes for every 3) and its anchor (ink as a page's, and a little more).
export const SAVE_MAX = 100 + MAX_POINTS * 140 + MAX_SCRAPS * 200 + TEXTS_MAX * (100 + TEXT_MAX * 6),
  NOTE_MAX = Math.ceil(pictures.MAX_BYTES / 3) * 4 + MAX_POINTS * 140 + 64 * 1024;
export const FULL = 'This page is full: start a new page to keep drawing (undo the last lines to save this one)';
// (every check refuses the same way: a [status, why] pair)
// The optional reason lets a guest page word a refusal in its own language.
export type Refused = [number, string, string?];
export const isRefused = (v: unknown): v is Refused => Array.isArray(v) && typeof v[0] === 'number';

// A page's side: whole CSS px within PAGE, or the refusal
export const pageSide = (v: unknown): number | Refused =>
  Number.isInteger(v) && Number(v) >= PAGE.min && Number(v) <= PAGE.max
    ? Number(v)
    : [400, `a page is whole CSS px, ${PAGE.min} to ${PAGE.max} on each side`];
// A page's height (or width) once it has grown: whole CSS px, from what it was made to GROWN_MAX. (The width grows too,
// the page endless every way.)
export const grownTo = (v: unknown, h: number): number | Refused =>
  v === undefined
    ? h
    : Number.isInteger(v) && Number(v) >= PAGE.min && Number(v) <= GROWN_MAX
      ? Number(v)
      : [400, `a page grows to whole CSS px, at most ${GROWN_MAX}`];
// A page's left or top once it has grown that way: whole CSS px, 0 or up to GROWN_MAX before its heading; undefined:
// kept as it was.
export const cornerOf = (v: unknown, was: number): number | Refused =>
  v === undefined
    ? was
    : Number.isInteger(v) && Number(v) <= 0 && Number(v) >= -GROWN_MAX
      ? Number(v)
      : [400, `a page's top-left is whole CSS px, 0 to -${GROWN_MAX}`];
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
    if (!stroke)
      return [400, 'a stroke is { color: "#rrggbb", size, alpha?, fill?: true, points: [[x, y, pressure, t], ...] }'];
    points += stroke.points.length;
    if (points > MAX_POINTS) return [413, FULL, 'pageFull'];
    strokes.push(stroke);
  }
  return strokes;
}
// The words typed on a page as HQ sent them: [{ x, y, w, text, color }], x and y the box's top-left and w the width
// its words wrap at, in the page's px; every one checked, or the refusal. A box of no words is never kept (HQ drops
// it), so it's refused here. undefined: none sent (a sketch's save), the page's kept as they are. id: a typed line's own,
// which it keeps through edits, joins and splits (notebookscraps.ts typedNote)
export type Typed = { x: number; y: number; w: number; text: string; color: string; id?: string };
export const LINE_ID = /^[0-9a-f]{12}$/;
export function textsOf(v: unknown): Typed[] | Refused | undefined {
  if (v === undefined) return undefined;
  const why = [400, 'texts are a list of { x, y, w, text, color: "#rrggbb" }, x and y on the page'] as Refused;
  // (x and y either side of the page's heading: it grows every way.)
  const on = (n: unknown, max: number, min = 0): n is number => typeof n === 'number' && n >= min && n <= max;
  if (!Array.isArray(v)) return why;
  if (v.length > TEXTS_MAX) return [413, `a page holds at most ${TEXTS_MAX} typed notes`, 'notesFull'];
  const texts: Typed[] = [];
  for (const t of v) {
    if (!t || typeof t !== 'object' || !on(t.x, GROWN_MAX, -GROWN_MAX) || !on(t.y, GROWN_MAX, -GROWN_MAX)) return why;
    if (!on(t.w, GROWN_MAX) || t.w < TEXT_W_MIN) return why;
    if (typeof t.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.color)) return why;
    if (typeof t.text !== 'string' || !t.text.trim()) return why;
    if (t.text.includes('\0')) return [400, "a typed note can't hold a NUL character", 'noteCharacter'];
    if ([...t.text].length > TEXT_MAX) return [400, `a typed note is at most ${TEXT_MAX} characters`, 'noteLong'];
    if (t.id !== undefined && !(typeof t.id === 'string' && LINE_ID.test(t.id))) return why;
    const round = (n: number) => Math.round(n * 100) / 100;
    const id = t.id === undefined ? {} : { id: t.id as string };
    texts.push({ x: round(t.x), y: round(t.y), w: round(t.w), text: t.text, color: t.color.toLowerCase(), ...id });
  }
  return texts;
}
function strokeOf(s: any) {
  if (!s || typeof s !== 'object' || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  if (typeof s.size !== 'number' || !(s.size >= LINE.min && s.size <= LINE.max)) return null;
  if (s.alpha !== undefined && !(typeof s.alpha === 'number' && s.alpha >= 0 && s.alpha <= 1)) return null;
  const point = (p: unknown) => Array.isArray(p) && p.length === 4 && p.every(Number.isFinite);
  if (!Array.isArray(s.points) || !s.points.length || !s.points.every(point)) return null;
  if (s.fill !== undefined && s.fill !== true) return null;
  const alpha = s.alpha === undefined ? {} : { alpha: s.alpha };
  // (a filled shape: its line and its inside, ink.js.)
  const fill = s.fill ? { fill: true as const } : {};
  return { color: s.color.toLowerCase(), size: s.size, ...alpha, ...fill, points: s.points as number[][] };
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
  // a note on a film: the moment it was stopped at (seconds) and the film's path
  video?: { time: number; src: string };
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
  const video = v.video;
  if (
    video !== undefined &&
    !(video && finite(video.time) && video.time >= 0 && typeof video.src === 'string' && video.src.length <= URL_MAX)
  )
    return [400, "an anchor's video is { time, src }: the film's moment, in seconds, and its path"];
  const box = (b: any) => ({ x: b.x, y: b.y, w: b.w, h: b.h });
  return {
    v: 1,
    url: noKeys(v.url),
    el: el && { selector: el.selector, tag: el.tag, text: el.text, box: box(el.box) },
    view: { ...box(v.view), dpr: v.view.dpr },
    ink,
    ...(video ? { video: { time: video.time, src: video.src } } : {}),
  };
}
// A note's words, spoken, typed or written (read from handwriting), as one trimmed text, or the refusal
export const WORDS_MAX = 4000;
export const SAID = ['spoken', 'typed', 'written'] as const;
export function wordsOf(v: unknown, said: unknown): { words: string; said: string | null } | Refused {
  if (v == null || v === '') return { words: '', said: null };
  if (typeof v !== 'string') return [400, "a note's words are text"];
  const words = v.trim();
  if ([...words].length > WORDS_MAX) return [400, `a note's words are at most ${WORDS_MAX} characters`, 'replyLong'];
  if (!SAID.includes(said as (typeof SAID)[number])) return [400, `said is how the words came: ${SAID.join(', ')}`];
  return { words, said: words ? (said as string) : null };
}
