// The board's ink on a call's page read for the call's agent (callpage.ts read): its pen stays handwriting, never
// turned into type on the page, and whoever reads the page reads the strokes as they are. Each of the
// board's scraps and drawings with ink goes as a picture of its strokes to Haiku 5.5, all of them in one call with the
// page's own words beside them, so a letter that could be read two ways is read as what fits the rest. Its circles,
// arrows and ticks are said as marks, and anything it can't tell is said as unsure, for the agent to ask the board. Each
// group's reading is kept for as long as its ink stays as it was, so a page read again costs nothing new. The worker
// makes the call (smallmodel.ts smallCall); the pictures live in memory for its length.
import sharp from 'sharp';
import { outline } from '../../../../shared/review/ink.js';
import { dayAllowance } from '../dayallowance.ts';
import { answerOf, smallCall } from '../smallmodel.ts';
import { isRefused, type Refused, type Stroke } from '../pagechecks.ts';

// The model: Haiku 5.5, by its full id (Ink's README: handwriting stays ink)
export const MODEL = 'claude-haiku-5-5';
// How long the agent's page read waits for the readings (the voice line gives HQ 15 s): past it, the page is read
// without them, and readings that come later are kept for its next read, up to READ_MS
const WAIT_MS = 10_000,
  READ_MS = 120_000;
// Each reading spends a little of a Claude seat's window, which the company's jobs live on: READS_A_DAY bounds what a
// page read again and again (or a client gone wrong) can take in a day. A day's reading at the board's pace is a few
// dozen.
export const READS_A_DAY = 300;
// One more reading today, unless today's are used
const takeOne = dayAllowance('handwriting_reads', 'reads', READS_A_DAY);
// A reading's longest field, and how many readings are kept
const SAID_MAX = 600,
  KEPT_MAX = 300;
// (the picture: the ink with a little room round it, drawn up to twice its size, so a word written small reads too)
const PAD = 12,
  SCALE_MAX = 2,
  SIDE_MAX = 1200;

// What the board's ink on one group says: its words as written, its marks, and what can't be told ('' for none)
export type Reading = { words: string; marks: string; unsure: string };
// One of the board's groups with ink: its number, its version (updated), its strokes
export type Inked = { id: number; updated: string; ink: Stroke[] };

const SCHEMA = {
  type: 'object',
  properties: {
    readings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: "the picture's number" },
          words: {
            type: 'string',
            maxLength: SAID_MAX,
            description: "the words written by hand, exactly as written, in their own language; '' for none",
          },
          marks: {
            type: 'string',
            maxLength: SAID_MAX,
            // (everyday words, "circle" never "ring")
            description:
              "the drawn marks, plainly (a circle round …, an arrow from … to …, a tick, a sketch of …); '' for none",
          },
          unsure: {
            type: 'string',
            maxLength: SAID_MAX,
            description: "what you can't tell for sure, a word or a mark, and the ways it could be read; '' when sure",
          },
        },
        required: ['id', 'words', 'marks', 'unsure'],
        additionalProperties: false,
      },
    },
  },
  required: ['readings'],
  additionalProperties: false,
};
const prompt = (page: string) => `The pictures are what someone drew with a pen on a page of their notebook, one \
picture for each part of the page, named by its number. The page itself, as text, a line for each part:

${page}

For each picture, read what they wrote and drew as they meant it. Read it with the rest of the page in mind: a letter \
or a word that could be read more than one way is the one that fits what else is written there. Give the handwritten \
words exactly as written (their language, spelling and capitals, lines joined with a space), and the drawn marks \
plainly, saying what each points at where you can tell. Where you can't tell what a word or a mark is, say so in \
unsure, with the ways it could be read: never guess silently.`;

// Readings kept by group and version, and those being read (a page read again meanwhile waits for them)
const kept = new Map<string, Reading>(),
  reading = new Map<string, Promise<void>>();
const keyOf = (g: Inked) => `${g.id}:${g.updated}`;

// The readings of the groups' ink, by group number: those kept, and the rest read now with the page (its lines, as
// the agent reads it). A group missing from the answer has no reading (the call failed, or came too late). Each call to
// the model is one of the day's handwriting readings (counted): the refusal once they're used.
export async function readInk(groups: Inked[], page: string): Promise<Map<number, Reading> | Refused> {
  const out = new Map<number, Reading>();
  const unread = groups.filter(g => {
    const k = kept.get(keyOf(g));
    if (k) out.set(g.id, k);
    return !k;
  });
  if (!unread.length) return out;
  const fresh = unread.filter(g => !reading.has(keyOf(g)));
  if (fresh.length) {
    const used = counted();
    if (used) return used;
    readNow(fresh, page);
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(unread.map(g => reading.get(keyOf(g)))),
    new Promise(res => (timer = setTimeout(res, WAIT_MS))),
  ]);
  clearTimeout(timer);
  for (const g of unread) {
    const r = kept.get(keyOf(g));
    if (r) out.set(g.id, r);
  }
  return out;
}
// One reading of the board's ink counted against today's READS_A_DAY: the refusal once today's are used
export function counted(): Refused | undefined {
  if (!takeOne()) return [429, `handwriting is read ${READS_A_DAY} times a day, and today's are used`];
}
// The groups' ink put to the model with the page, each reading kept as it comes
function readNow(unread: Inked[], page: string) {
  const went = put(unread, page)
    .catch(err => console.error("The board's ink on a call's page not read:", err))
    .finally(() => {
      for (const g of unread) reading.delete(keyOf(g));
    });
  for (const g of unread) reading.set(keyOf(g), went);
}
async function put(unread: Inked[], page: string) {
  const content: unknown[] = [];
  for (const g of unread) content.push({ type: 'text', text: `Picture #${g.id}:` }, image(await picture(g.ink)));
  content.push({ type: 'text', text: prompt(page) });
  const answer = await smallCall({
    name: "the board's ink reader",
    model: MODEL,
    content,
    schema: SCHEMA,
    check: readings(new Set(unread.map(g => g.id))),
    wait: READ_MS,
    failed: "the board's ink reader couldn't read it",
    keepAlive: false,
  });
  if (isRefused(answer)) return;
  for (const g of unread) {
    const r = answer.get(g.id);
    if (r) kept.set(keyOf(g), r);
  }
  // (the oldest let go first: a Map keeps its order)
  for (const k of kept.keys()) if (kept.size > KEPT_MAX) kept.delete(k);
}

const readings =
  (ids: Set<number>) =>
  (result: unknown): Map<number, Reading> | string => {
    const a = answerOf(result);
    if (typeof a === 'string') return a;
    if (!Array.isArray(a.readings)) return 'an answer without readings';
    const out = new Map<number, Reading>();
    for (const r of a.readings as Record<string, unknown>[]) {
      if (!ids.has(r?.id as number)) continue;
      const { words, marks, unsure } = r;
      if (typeof words !== 'string' || typeof marks !== 'string' || typeof unsure !== 'string')
        return 'a reading without words, marks and unsure';
      if ([words, marks, unsure].some(s => [...s].length > SAID_MAX)) return `a reading over ${SAID_MAX} characters`;
      const said = (s: string) => s.replace(/\s+/g, ' ').trim();
      out.set(r.id as number, { words: said(words), marks: said(marks), unsure: said(unsure) });
    }
    return out.size ? out : 'readings of none of the pictures';
  };

const image = (png: Buffer) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
});

// The ink alone, dark on white, with a little room round it, drawn up to twice its size
async function picture(strokes: Stroke[]) {
  const pts = strokes.flatMap(s => s.points.map(p => [p[0], p[1], (s.size ?? 4) / 2]));
  const x0 = Math.min(...pts.map(p => p[0] - p[2])) - PAD,
    y0 = Math.min(...pts.map(p => p[1] - p[2])) - PAD,
    w = Math.max(...pts.map(p => p[0] + p[2])) + PAD - x0,
    h = Math.max(...pts.map(p => p[1] + p[2])) + PAD - y0,
    k = Math.min(SCALE_MAX, SIDE_MAX / Math.max(w, h)),
    W = Math.max(1, Math.ceil(w * k)),
    H = Math.max(1, Math.ceil(h * k));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${x0} ${y0} ${w} ${h}">${strokes
    .map(s => `<path d="${outline(s)}" fill="#000"/>`)
    .join('')}</svg>`;
  return sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
}
