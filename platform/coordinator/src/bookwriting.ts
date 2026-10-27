// The board's own writing on a sheet page, going with the sheet's notes (booksheets.ts): at the plane's tap the book
// says where each note lies on the pages showing the sheet's notes, any sheet's (its spot, in the page's px: only the
// browser lays the notes out), and as the sheet goes, the ink on those pages that never went before is gathered into
// lines of writing (strokes near enough to touch), each line beside the note nearest it. A line nearest another sheet's
// note stays on the page for that sheet. Each of this sheet's notes' lines are read into words as the Pencil's
// handwriting is (handwriting.ts: the model decides what's writing, so a doodle or a ring goes as none) and quoted under
// that note in its owner's task; ink that couldn't be read points the owner at the page itself (hq sketch). Ink that
// went once is remembered by its page and never goes again with a later sheet.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { db } from './db.ts';
import { outline } from '../../../shared/review/ink.js';
import { readPicture } from './handwriting.ts';
import { PAGE, isRefused, type Refused, type Stroke } from './pagechecks.ts';

// spots: a sheet's notes' places on their pages, kept from the tap until it has gone (a restart in between reads them
// again). written: each stroke that went, by its page and its points' hash.
db.exec(`create table if not exists book_spots (sheet integer primary key, spots text not null);
  create table if not exists book_written (page integer not null, stroke text not null, sheet integer not null,
  primary key (page, stroke))`);

export type Spot = { note: number; page: number; x: number; y: number; w: number; h: number };
// A note's writing read: its words, '' for none (marks only), null when it couldn't be read
export type Writing = { note: number; page: number; words: string | null; strokes: string[] };
type Box = { x0: number; y0: number; x1: number; y1: number };

// strokes this near (page px) are one line of writing; the picture's room round the ink, its scale and longest side
// (written.js's inkPicture's)
const NEAR_PX = 24,
  PAD = 12,
  SCALE_MAX = 2,
  SIDE_MAX = 1200;

// The spots a send names: [{ note, page, x, y, w, h }], each a note of the book (inBook) on a sheet page of it (pageOf:
// its row, or none); nothing (undefined) from a book that says none
export function spotsOf(
  v: unknown,
  inBook: (note: number) => boolean,
  pageOf: (id: number) => { kind: string } | undefined,
) {
  if (v === undefined) return [];
  const bad: Refused = [400, "spots are the places of the notes on the sheet's pages: [{ note, page, x, y, w, h }]"];
  if (!Array.isArray(v)) return bad;
  const spots: Spot[] = [];
  for (const s of v) {
    const n = (k: string) => (typeof s?.[k] === 'number' && Number.isFinite(s[k]) ? (s[k] as number) : NaN);
    const spot = { note: n('note'), page: n('page'), x: n('x'), y: n('y'), w: n('w'), h: n('h') };
    if (!inBook(spot.note) || pageOf(spot.page)?.kind !== 'sheet') return bad;
    if (![spot.x, spot.y, spot.w, spot.h].every(x => Math.abs(x) <= PAGE.max) || spot.w < 0 || spot.h < 0) return bad;
    spots.push(spot);
  }
  return spots;
}
// Kept at the tap, gone at an undo or once the sheet has gone
export function keepSpots(sheet: number, spots: Spot[]) {
  if (spots.length)
    db.prepare('insert or replace into book_spots (sheet, spots) values (?, ?)').run(sheet, JSON.stringify(spots));
  else dropSpots(sheet);
}
export const dropSpots = (sheet: number) => db.prepare('delete from book_spots where sheet = ?').run(sheet);

// The sheet's writing read, then go(writing): at once when there's none to read. Called again while it's being read
// (each read of the sheets), it waits for that reading.
const reading = new Set<number>();
export function readThenGo(sheet: number, go: (writing: Writing[]) => void) {
  if (reading.has(sheet)) return;
  const groups = toRead(sheet);
  if (!groups.length) return go([]);
  reading.add(sheet);
  void Promise.all(groups.map(readGroup)).then(writing => {
    reading.delete(sheet);
    go(writing);
  });
}

// Once the sheet has gone: its strokes went, never to go again with a later sheet on those pages
export function went(sheet: number, writing: Writing[]) {
  for (const w of writing)
    for (const key of w.strokes)
      db.prepare('insert or ignore into book_written (page, stroke, sheet) values (?, ?, ?)').run(w.page, key, sheet);
  dropSpots(sheet);
}

// The notes' texts as the task quotes them, each with the words written beside it (notes: in the texts' order)
export function withWriting(notes: { id: number }[], texts: string[], writing: Writing[]) {
  const said = writing.filter(w => w.words !== '');
  return texts.map((t, i) => [t, ...said.filter(w => w.note === notes[i].id).map(besideLine)].join('\n'));
}
const besideLine = (w: Writing) =>
  w.words === null
    ? `The board also wrote beside this note on the sheet, and it couldn't be read: \`hq sketch ${w.page}\` shows the page as the board drew it.`
    : `The board also wrote beside this note on the sheet, in its own hand: “${w.words}”`;

// The ink to read: on each page a note of the sheet's is on, the strokes that never went, in lines of writing, each
// line beside the nearest note there of any sheet (a wiped one is gone); one group for each of the sheet's open notes
// with lines beside it, the rest left on the page
function toRead(sheet: number) {
  const row = db.prepare('select spots from book_spots where sheet = ?').get(sheet) as { spots: string } | undefined;
  if (!row) return [];
  const open = new Set(
    (db.prepare("select id from book_notes where sheet = ? and status = 'open'").all(sheet) as { id: number }[]).map(
      n => n.id,
    ),
  );
  const stays = db.prepare('select 1 from book_notes where id = ?'),
    spots = (JSON.parse(row.spots) as Spot[]).filter(s => stays.get(s.note)),
    groups = new Map<number, { note: number; page: number; strokes: Stroke[] }>();
  for (const page of new Set(spots.filter(s => open.has(s.note)).map(s => s.page))) {
    const here = spots.filter(s => s.page === page),
      { ink } = (db.prepare('select ink from book_pages where id = ?').get(page) as { ink: string } | undefined) ?? {
        ink: '[]',
      };
    const sent = new Set(
      (db.prepare('select stroke from book_written where page = ?').all(page) as { stroke: string }[]).map(
        r => r.stroke,
      ),
    );
    for (const line of linesOf((JSON.parse(ink) as Stroke[]).filter(s => !sent.has(keyOf(s))))) {
      const box = boxOf(line),
        to = here.reduce((a, b) => (apart(box, spotBox(b)) < apart(box, spotBox(a)) ? b : a));
      if (!open.has(to.note)) continue;
      const g = groups.get(to.note) ?? { note: to.note, page, strokes: [] };
      g.strokes.push(...line);
      groups.set(to.note, g);
    }
  }
  return [...groups.values()];
}

async function readGroup(g: { note: number; page: number; strokes: Stroke[] }): Promise<Writing> {
  const strokes = g.strokes.map(keyOf);
  try {
    const read = await readPicture({ type: 'image/png', clean: await picture(g.strokes) });
    return { note: g.note, page: g.page, words: isRefused(read) ? null : read.words, strokes };
  } catch (err) {
    console.error(`The book: writing beside note #${g.note} not read:`, err);
    return { note: g.note, page: g.page, words: null, strokes };
  }
}

// A stroke as the store knows it again: its points' hash
const keyOf = (s: Stroke) => createHash('sha256').update(JSON.stringify(s.points)).digest('base64url').slice(0, 22);

// The strokes in lines of writing: strokes whose boxes come within NEAR_PX of each other, and theirs, are one
function linesOf(strokes: Stroke[]) {
  const boxes = strokes.map(s => boxOf([s])),
    group = strokes.map((_, i) => i);
  const top = (i: number): number => (group[i] === i ? i : (group[i] = top(group[i])));
  for (let i = 0; i < strokes.length; i++)
    for (let j = i + 1; j < strokes.length; j++) if (apart(boxes[i], boxes[j]) <= NEAR_PX) group[top(j)] = top(i);
  const lines = new Map<number, Stroke[]>();
  strokes.forEach((s, i) => lines.set(top(i), [...(lines.get(top(i)) ?? []), s]));
  return [...lines.values()];
}
const boxOf = (strokes: Stroke[]): Box => {
  const pts = strokes.flatMap(s => s.points.map(p => [p[0], p[1], (s.size ?? 4) / 2]));
  return {
    x0: Math.min(...pts.map(p => p[0] - p[2])),
    y0: Math.min(...pts.map(p => p[1] - p[2])),
    x1: Math.max(...pts.map(p => p[0] + p[2])),
    y1: Math.max(...pts.map(p => p[1] + p[2])),
  };
};
const spotBox = (s: Spot): Box => ({ x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h });
// How far apart two boxes are: 0 when they touch
const apart = (a: Box, b: Box) =>
  Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));

// The ink alone, dark on white, with a little room round it, drawn up to twice its size (as written.js's inkPicture)
async function picture(strokes: Stroke[]) {
  const b = boxOf(strokes),
    w = b.x1 - b.x0 + 2 * PAD,
    h = b.y1 - b.y0 + 2 * PAD,
    k = Math.min(SCALE_MAX, SIDE_MAX / Math.max(w, h)),
    W = Math.max(1, Math.ceil(w * k)),
    H = Math.max(1, Math.ceil(h * k));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${b.x0 - PAD} ${b.y0 - PAD} ${w} ${h}">${strokes
    .map(s => `<path d="${outline(s)}" fill="#000"/>`)
    .join('')}</svg>`;
  return sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
}
