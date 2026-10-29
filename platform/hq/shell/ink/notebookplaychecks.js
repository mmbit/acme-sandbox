// What notebookplay.js checks of a request: the coordinator's own (pagechecks.ts, pagescraps.ts), copied with the same
// refusals' status and words. Each check throws its refusal, an Error with .status. No DOM.
import { TEXT_MAX } from './notebookparts.js';

// A refusal as the coordinator answers it: a status and its words (a bare status: server.ts's ERRORS word)
export const refuse = (status, words = status === 404 ? 'not found' : 'refused') => {
  throw Object.assign(new Error(words), { status });
};

const MAX_POINTS = 120_000,
  GROWN_MAX = 20_000,
  TEXTS_MAX = 200,
  TEXT_W_MIN = 20,
  LABEL_MAX = 80,
  WORDS_MAX = 4000,
  MAX_SCRAPS = 40,
  PICTURE_SIDE = 2000,
  MAX_BYTES = 3.5 * 1024 * 1024;
const SIZE = { min: 0.5, max: 200 },
  SCRAP_XY = { min: -24_000, max: 24_000 },
  SCRAP_SIDE = { min: 4, max: 12000 },
  TILT = 180;
const SAID = ['spoken', 'typed', 'written'];
const FULL = 'This page is full: start a new page to keep drawing (undo the last lines to save this one)';
const finite = v => typeof v === 'number' && Number.isFinite(v);
const round = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- a request's parts
// A page's title as one line, trimmed
export function labelOf(v) {
  if (typeof v !== 'string') refuse(400, 'a label is text');
  const label = v.replace(/\s+/g, ' ').trim();
  return label.length > LABEL_MAX ? refuse(400, `a label is at most ${LABEL_MAX} characters`) : label;
}
// The strokes as HQ sent them (ink.js's), every one checked
export function inkOf(v) {
  if (!Array.isArray(v)) refuse(400, 'ink is a list of strokes');
  let points = 0;
  return v.map(s => {
    const stroke = strokeOf(s);
    if (!stroke)
      refuse(400, 'a stroke is { color: "#rrggbb", size, alpha?, fill?: true, points: [[x, y, pressure, t], ...] }');
    points += stroke.points.length;
    if (points > MAX_POINTS) refuse(413, FULL);
    return stroke;
  });
}
function strokeOf(s) {
  if (!s || typeof s !== 'object' || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  if (typeof s.size !== 'number' || !(s.size >= SIZE.min && s.size <= SIZE.max)) return null;
  if (s.alpha !== undefined && !(typeof s.alpha === 'number' && s.alpha >= 0 && s.alpha <= 1)) return null;
  const point = p => Array.isArray(p) && p.length === 4 && p.every(Number.isFinite);
  if (!Array.isArray(s.points) || !s.points.length || !s.points.every(point)) return null;
  if (s.fill !== undefined && s.fill !== true) return null;
  const alpha = s.alpha === undefined ? {} : { alpha: s.alpha },
    fill = s.fill ? { fill: true } : {};
  return { color: s.color.toLowerCase(), size: s.size, ...alpha, ...fill, points: s.points };
}
// The words typed on a page: [{ x, y, w, text, color }]
export function textsOf(v) {
  const why = 'texts are a list of { x, y, w, text, color: "#rrggbb" }, x and y on the page';
  const on = (n, max, min = 0) => typeof n === 'number' && n >= min && n <= max;
  if (!Array.isArray(v)) refuse(400, why);
  if (v.length > TEXTS_MAX) refuse(413, `a page holds at most ${TEXTS_MAX} typed notes`);
  return v.map(t => {
    if (!t || typeof t !== 'object' || !on(t.x, GROWN_MAX, -GROWN_MAX) || !on(t.y, GROWN_MAX, -GROWN_MAX))
      refuse(400, why);
    if (!on(t.w, GROWN_MAX) || t.w < TEXT_W_MIN) refuse(400, why);
    if (typeof t.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.color)) refuse(400, why);
    if (typeof t.text !== 'string' || !t.text.trim()) refuse(400, why);
    if (t.text.includes('\0')) refuse(400, "a typed note can't hold a NUL character");
    if ([...t.text].length > TEXT_MAX) refuse(400, `a typed note is at most ${TEXT_MAX} characters`);
    return { x: round(t.x), y: round(t.y), w: round(t.w), text: t.text, color: t.color.toLowerCase() };
  });
}
// The pictures placed in a group. ours(file): one uploaded to a page of the board's.
export function picturesOf(v, ours) {
  if (!Array.isArray(v)) refuse(400, 'scraps is a list of pictures on the page');
  if (v.length > MAX_SCRAPS) refuse(400, `a page holds at most ${MAX_SCRAPS} pictures`);
  const seen = new Set(),
    within = (n, r) => finite(n) && n >= r.min && n <= r.max;
  return v.map(c => {
    if (!c || typeof c !== 'object' || !ours(c.file)) refuse(400, 'a picture on the page is one uploaded to this page');
    if (seen.has(c.file)) refuse(400, 'a picture is on the page once');
    seen.add(c.file);
    const sides = within(c.w, SCRAP_SIDE) && within(c.h, SCRAP_SIDE);
    if (!within(c.x, SCRAP_XY) || !within(c.y, SCRAP_XY) || !sides || !within(c.tilt, { min: -TILT, max: TILT }))
      refuse(400, 'a picture on the page is { file, x, y, w, h, tilt }, within the page and a half turn');
    return { file: c.file, x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h), tilt: round(c.tilt) };
  });
}
// A note's words, spoken, typed or written: { words, said }
export function wordsOf(v, said) {
  if (v == null || v === '') return { words: '', said: null };
  if (typeof v !== 'string') refuse(400, "a note's words are text");
  const words = v.trim();
  if ([...words].length > WORDS_MAX) refuse(400, `a note's words are at most ${WORDS_MAX} characters`);
  if (!SAID.includes(said)) refuse(400, `said is how the words came: ${SAID.join(', ')}`);
  return { words, said: words ? said : null };
}
// Where a scrap was cut (anchor.js's v1 shape)
export function anchorOf(v) {
  const box = b => b && typeof b === 'object' && ['x', 'y', 'w', 'h'].every(k => finite(b[k]));
  if (!v || typeof v !== 'object' || v.v !== 1) refuse(400, 'an anchor is version 1: { v: 1, url, el, view, ink }');
  if (typeof v.url !== 'string' || !v.url || v.url.length > 2000 || !URL.canParse(v.url, 'https://x'))
    refuse(400, "an anchor's url is the page's address");
  const el = v.el;
  if (el !== null) {
    if (!el || typeof el !== 'object' || !box(el.box))
      refuse(400, "an anchor's el is null or { selector, tag, text, box }");
    if (
      typeof el.selector !== 'string' ||
      el.selector.length > 1000 ||
      typeof el.tag !== 'string' ||
      el.tag.length > 40
    )
      refuse(400, "an anchor's el names its element: a selector and a tag");
    if (typeof el.text !== 'string' || [...el.text].length > 200)
      refuse(400, "an anchor's element text is at most 200 characters");
  }
  if (!box(v.view) || !finite(v.view.dpr)) refuse(400, "an anchor's view is { w, h, x, y, dpr }, numbers");
  const sides = b => ({ x: b.x, y: b.y, w: b.w, h: b.h });
  return {
    v: 1,
    url: v.url,
    el: el && { selector: el.selector, tag: el.tag, text: el.text, box: sides(el.box) },
    view: { ...sides(v.view), dpr: v.view.dpr },
    ink: inkOf(v.ink),
    ...(v.video ? { video: { time: v.video.time, src: v.video.src } } : {}),
  };
}
// A PNG or JPEG data URL's picture: { bytes (Uint8Array), type, width, height }
export function dataUrlPicture(v) {
  const m = typeof v === 'string' ? /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(v) : null;
  if (!m) refuse(400, 'the picture is a PNG or JPEG data URL');
  const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
  if (bytes.length > MAX_BYTES) refuse(413, 'the picture is too large');
  return pictureOf(bytes);
}
// A picture's bytes read for its type and size (refused: not a PNG or JPEG, or past PICTURE_SIDE on its long side)
export function pictureOf(bytes) {
  const size = sizeOf(bytes);
  if (!size) refuse(400, 'not a picture we can read');
  if (Math.max(size.width, size.height) > PICTURE_SIDE)
    refuse(413, `a picture is ${PICTURE_SIDE} px on its long side at most`);
  return { bytes, ...size };
}
// (a PNG's IHDR, or a JPEG's first frame header)
function sizeOf(b) {
  const at = (i, n) => b.slice(i, i + n).reduce((sum, x) => sum * 256 + x, 0);
  if (b.length > 24 && at(0, 4) === 0x89504e47) return { type: 'image/png', width: at(16, 4), height: at(20, 4) };
  if (at(0, 2) !== 0xffd8) return null;
  for (let i = 2; i + 9 < b.length; i += 2 + at(i + 2, 2)) {
    if (b[i] !== 0xff) return null;
    if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(b[i + 1]))
      return { type: 'image/jpeg', width: at(i + 7, 2), height: at(i + 5, 2) };
  }
  return null;
}
