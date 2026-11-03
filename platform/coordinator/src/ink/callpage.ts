// A call's notes page as its agent works it, the way the board does: it reads
// what's on the page (read), draws on it (mark: a rectangle, an ellipse, a line, an arrow, a pen line or a highlight)
// and changes what's there (change: its own note's or scrap's words, anything moved or deleted), puts a drawing of its
// own on it as a picture (drawing: drawing.ts), and has versions of something on it made to pick from (versions:
// booktry.ts.). Its notes and
// scraps are callnotes.ts scrap. The page is its scrap units in order (scrapunit.js): the agent reads each in its own
// px, and a mark goes on the scrap it's about or is a drawing of its own. Each goes through the notebook's own routes
// (notebookgroups.ts) as the agent's: every screen showing the page reads it as it does another screen's change, and
// the board's Undo never takes it back (it takes back only the board's own steps), the board deletes or changes
// it as it would its own.
// What it draws asks for nothing: it stays on the page as sent, unless the board changes it.
import sharp from 'sharp';
import { db } from '../db.ts';
import { drawn } from '../drawing.ts';
import { exclude } from '../latency.ts';
import { findAgent } from '../jobs.ts';
import { BOARD } from './book.ts';
import { shut } from '../notebook.ts';
import {
  createGroup,
  deleteGroup,
  editGroup,
  isUnitOn,
  moveGroup,
  partsOf,
  row,
  type Group,
} from '../notebookgroups.ts';
import { emptyGroup } from '../../../hq/shell/ink/notebookparts.js';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';
import { addPicture, lineId } from '../notebookscraps.ts';
import { isRefused, type Refused, type Stroke, type Typed } from '../pagechecks.ts';
import { boxWords, liveCall, pageFor } from './callnotes.ts';
import { asksOf, ownLines, rewrote } from './callasks.ts';
import { WHAT } from '../ledger.ts';
import { MARKERS, MARKER_ALPHA, WIDTHS, shape } from '../../../hq/shell/ink/bookinkmath.js';
import { inkOf } from '../../../hq/shell/ink/agentink.js';
import { UNIT_W, retypedNote, unitOf } from '../../../hq/shell/ink/scrapunit.js';
import { tryNow } from './booktry.ts';
import { readInk, type Reading } from './inkread.ts';

// What the agent draws: the book's shapes, a pen line, a highlight
export const MARKS = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight'];
// Room round a scrap's contents a mark goes round (its px), and a pen point's pressure and time apart (ms), as a hand's
const ROOM = 12,
  PRESSURE = 0.5,
  T_STEP = 16;
const ENDED = [404, 'This call has ended: its notes have gone in.'] as Refused;

// The live call and its notes page (made if it has none yet). Its answers in plain words
function callPage(b: any) {
  const call = Number(b?.call);
  const c = Number.isInteger(call) && call > 0 ? liveCall(call) : undefined;
  const p = c && pageFor(call);
  if (!c || !p) return ENDED;
  if (shut(p)) return [409, 'This call’s notes have gone in.'] as Refused;
  return { agent: c.agent, page: p };
}
const groupsOn = (page: number) =>
  db
    .prepare('select * from notebook_groups where page = ? and parent is null and deleted is null order by pos, id')
    .all(page) as Group[];

// POST /api/voice/page { call }: what's on the call's page, its scraps in order, a line each: its number (#id), who
// wrote it, what it is, its words and its contents' box in its own px, and what the board's ink on it says, read from
// its strokes with the page round them (inkread.ts): never type made of it on the page
export async function read(b: any) {
  const at = callPage(b);
  if (isRefused(at)) return at;
  const groups = groupsOn(at.page.id);
  if (!groups.length) return { ok: "There's nothing in the call's notes yet." };
  const lines = groups.map(g => lineOf(g, at.agent)),
    // (a group's ink is strokes as the store took them: pagechecks.ts inkOf)
    inked = groups
      .filter(g => g.by === BOARD && partsOf(g).ink.length)
      .map(g => ({ id: g.id, updated: g.updated, ink: partsOf(g).ink as Stroke[] }));
  const readings = await readInk(inked, lines.join('\n'));
  if (isRefused(readings)) return readings;
  const head = `The call's notes in order (x, y, width and height in each note's own px, ${UNIT_W} wide, y down):`;
  return { ok: [head, ...groups.map((g, i) => lines[i] + readingOf(g, readings))].join('\n') };
}
// What the board's ink on a group says, after its line: or, unread, that it's to be asked about
function readingOf(g: Group, readings: Map<number, Reading>) {
  if (g.by !== BOARD || !partsOf(g).ink.length) return '';
  const r = readings.get(g.id);
  if (!r) return "; its ink couldn't be read just now: ask the board what it says if it matters";
  const said = [r.words && `written “${r.words}”`, r.marks && `drawn: ${r.marks}`].filter(Boolean).join('; ');
  return `; its ink, read: ${said || 'nothing anyone could read'}${r.unsure ? `; not sure: ${r.unsure}: ask the board` : ''}`;
}
function lineOf(g: Group, agent: string) {
  const parts = partsOf(g),
    box = boxOf(parts);
  const who = g.by === agent ? 'yours' : g.by === BOARD ? "the board's" : `${findAgent(g.by)?.name ?? g.by}'s`;
  const what =
    g.kind === 'scrap'
      ? 'note with a picture'
      : g.kind === 'note'
        ? 'note'
        : parts.pictures.length
          ? 'picture'
          : 'drawing';
  const typed = (parts.texts as { text: string }[]).map(t => t.text).join(' ');
  const words = g.words || typed;
  const ink = parts.ink.length ? `, ${parts.ink.length} line${parts.ink.length > 1 ? 's' : ''} of ink` : '';
  const asks = asksOf(g.id).length ? ' (an ask)' : '';
  const place = box ? ` at ${boxWords(box)}` : '';
  // (its words whole)
  return `#${g.id} ${who} ${what}${asks}${words ? `: “${words}”` : ''}${ink}${place}`;
}

// POST /api/voice/mark { call, mark, around?, box?, points?, filled? }: a mark in the agent's ink on the scrap around
// names, in its px, or a drawing of its own at the page's end: a rectangle or ellipse round the scrap's contents
// (around alone) or a box ({ x, y, width, height }), filled or not; a line or an arrow from points[0] to points[1]; a
// pen line through points; a highlight over the scrap's contents or a box, or along points
export function mark(b: any) {
  const at = callPage(b);
  if (isRefused(at)) return at;
  const on = b.around == null ? null : row(Number(b.around));
  if (on !== null && !isUnitOn(on, at.page.id))
    return [404, `around: no #${b.around} in the call's notes (read them with read_notes)`] as Refused;
  const stroke = strokeOf(b, at.agent, on);
  if (isRefused(stroke)) return stroke;
  const what = b.mark === 'rect' ? 'rectangle' : b.mark;
  if (on) {
    const parts = partsOf(on),
      done = editGroup({ id: on.id, since: on.updated, ink: [...parts.ink, stroke] }, BOARD, at.agent);
    if (isRefused(done) || typeof done !== 'object') return done as Refused;
    return { ok: `Your ${what} is on #${on.id}.`, id: on.id };
  }
  const own = unitOf({ ...emptyGroup, ink: [stroke] }).parts;
  const g = createGroup({ page: at.page.id, ...own }, BOARD, at.agent);
  if (isRefused(g) || typeof g !== 'object') return g as Refused;
  return { ok: `Your ${what} is in the call's notes (#${g.id}).`, id: g.id };
}
function strokeOf(b: any, agent: string, on: Group | null) {
  if (!MARKS.includes(b.mark)) return [400, `mark: one of ${MARKS.join(', ')}`] as Refused;
  const ink = { color: inkOf(agent), size: WIDTHS.pen[1] },
    highlight = { color: MARKERS[0].color, size: WIDTHS.highlighter[1], alpha: MARKER_ALPHA };
  const points = pointsOf(b.points);
  if (['line', 'arrow'].includes(b.mark)) {
    if (points?.length !== 2) return [400, 'points: [[x, y], [x, y]], from and to, in the note’s px'] as Refused;
    return shape(b.mark, points[0], points[1], ink) ?? ([400, 'the line is too short to draw'] as Refused);
  }
  if (b.mark === 'pen' || (b.mark === 'highlight' && points)) {
    if (!points || points.length < 2) return [400, 'points: [[x, y], ...], two or more, in the note’s px'] as Refused;
    const along = b.mark === 'pen' ? ink : highlight;
    return { ...along, points: points.map(([x, y], i) => [x, y, PRESSURE, i * T_STEP]) };
  }
  const box = boxAsked(b, on);
  if (isRefused(box)) return box;
  const from: [number, number] = [box.x, box.y],
    to: [number, number] = [box.x + box.w, box.y + box.h];
  const drawn =
    b.mark === 'highlight'
      ? shape('rect', from, to, { ...highlight, size: 2 }, { fill: true })
      : shape(b.mark, from, to, ink, { fill: b.filled === true });
  return drawn ?? ([400, 'the box is too small to draw'] as Refused);
}
// A box the agent names: its own (box), or round the contents of the scrap it's on with room, inside the scrap
function boxAsked(b: any, on: Group | null): { x: number; y: number; w: number; h: number } | Refused {
  const contents = on && b.box === undefined ? boxOf(partsOf(on)) : null;
  if (on && contents) {
    const x = Math.max(0, contents.x - ROOM),
      y = Math.max(0, contents.y - ROOM);
    return { x, y, w: Math.min(UNIT_W, contents.x + contents.w + ROOM) - x, h: contents.y + contents.h + ROOM - y };
  }
  const r = b.box,
    n = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!r || ![r.x, r.y, r.width, r.height].every(n) || r.width <= 0 || r.height <= 0)
    return [400, "around (a note's number) or box: { x, y, width, height } in the note's px"] as Refused;
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}
const pointsOf = (v: unknown) =>
  Array.isArray(v) && v.length <= 500 && v.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
    ? (v as [number, number][])
    : null;

// POST /api/voice/drawing { call, svg }: a drawing of the agent's own (a diagram, a chart) drawn as a picture in the
// company's look (drawing.ts) and put on the page as its last scrap, for the board to draw on as on any picture. It
// asks for nothing. Its answer carries the picture at half its size, for the agent to see what the board sees.
export async function drawing(b: any) {
  const live = callPage(b);
  if (isRefused(live)) return live;
  // (drawn in Chromium, outside HQ's thread)
  const picture = await exclude(drawn(typeof b.svg === 'string' ? b.svg : ''));
  if (isRefused(picture)) return picture;
  // (the call may have ended while it was drawn)
  const at = callPage(b);
  if (isRefused(at)) return at;
  const g = addPicture(at.page, at.agent, { type: 'image/png', clean: picture.png }, NOTHING_SAID);
  if (isRefused(g)) return g;
  const seen = await sharp(picture.png)
    .resize({ width: picture.width >> 1 })
    .jpeg({ quality: 85 })
    .toBuffer();
  return {
    ok: `Your drawing is in the call's notes (#${g.id}), its picture at ${boxWords(boxOf(partsOf(g))!)}, appearing as \
the board watches. Here it is as the board sees it: if words overlap or run off it, delete it and draw it again.`,
    id: g.id,
    picture: { type: 'image/jpeg', data: seen.toString('base64') },
  };
}
const NOTHING_SAID = { words: '', said: null, owner: null };

// POST /api/voice/try { call, id, why }: versions of something on the call's page to pick from (a scrap, a note, the
// board's drawing), each the real thing made by its owner in a try run (booktry.ts tryNow); why: the board's words asking
// for them. A try already going on it hears the ask instead.
export function versions(b: any) {
  const at = callPage(b);
  if (isRefused(at)) return at;
  const g = row(Number(b.id));
  if (!isUnitOn(g, at.page.id)) return [404, `no #${b.id} in the call's notes (read them with read_notes)`] as Refused;
  const why = typeof b.why === 'string' ? b.why.replace(/\s+/g, ' ').trim() : '';
  if (!why || [...why].length > WHAT)
    return [400, `why: the board's ask in one line of at most ${WHAT} characters`] as Refused;
  const going = (g as Group & { tried: number | null }).tried;
  const job = tryNow({ grp: g.id }, { id: 0, why });
  if (job === null) return [409, `#${g.id} has nothing to try on: it's gone from the notes`] as Refused;
  const run = db.prepare('select agent from jobs where id = ?').get(job) as { agent: string };
  const who = findAgent(run.agent)?.name ?? run.agent;
  if (job === going) return { ok: `${who}'s try on it is still going: the board's ask goes to it.`, job };
  const took = usualTry();
  const when = took ? ` Tries lately took about ${took} minutes to the last one.` : '';
  const started = `Started: ${who} makes a few versions of it, the real thing built, and they appear under it one by \
one as each is made.${when}`;
  return { ok: started, job };
}
// The minutes the latest finished try runs took, the middle one (null: too few to say)
function usualTry() {
  const took = (
    db
      .prepare(
        `select (julianday(finished) - julianday(started)) * 1440 minutes from jobs
          where kind = 'try' and status = 'done' and started is not null and finished is not null order by id desc limit 9`,
      )
      .all() as { minutes: number }[]
  )
    .map(r => r.minutes)
    .sort((x, y) => x - y);
  return took.length >= 3 ? Math.max(1, Math.round(took[took.length >> 1])) : null;
}

// POST /api/voice/change { call, id, words? | after? | delete? }: one thing on the call's page changed: the words of the
// agent's own note or scrap (an ask's item takes them too, while it hasn't gone anywhere), anything on it moved right
// after another (after: its number), or deleted
export function change(b: any) {
  const at = callPage(b);
  if (isRefused(at)) return at;
  const g = row(Number(b.id));
  if (!isUnitOn(g, at.page.id)) return [404, `no #${b.id} in the call's notes (read them with read_notes)`] as Refused;
  const asked = ['words', 'after', 'delete'].filter(k => b[k] !== undefined);
  if (asked.length !== 1) return [400, 'one of words, after and delete'] as Refused;
  const done =
    b.delete === true
      ? deleteGroup({ id: g.id }, BOARD)
      : b.after !== undefined
        ? moveGroup({ id: g.id, page: at.page.id, after: b.after }, BOARD)
        : newWords(g, b.words, at.agent);
  if (isRefused(done) || typeof done !== 'object') return done as Refused;
  const how = b.delete === true ? 'is deleted' : b.after !== undefined ? 'has moved' : 'says it now';
  return { ok: `#${g.id} ${how}.` };
}
// The agent's own note or scrap retyped with new words while its one ask is open and its lines are still in it
function newWords(g: Group, words: unknown, agent: string) {
  if (g.by !== agent || !['scrap', 'note'].includes(g.kind))
    return [409, 'only the words of your own notes change: draw beside the rest, or move or delete it'] as Refused;
  const said = typeof words === 'string' ? words.replace(/\s+/g, ' ').trim() : '';
  if (!said || [...said].length > WHAT) return [400, `words: one line of at most ${WHAT} characters`] as Refused;
  const asks = asksOf(g.id);
  if (asks.some(a => !open(a.item)))
    return [409, 'its ask has gone to its work already: pass the change on with add or reach'] as Refused;
  if (asks.length !== 1) return [409, 'the board joined it with another note: add one of your own instead'] as Refused;
  if (!retypable(g, asks[0].item))
    return [409, 'none of your words are in it now (the board took them out): add one of your own instead'] as Refused;
  return retyped(g, said, agent, asks[0].item);
}
// Whether a note of the agent's can be typed again: a scrap always (its words are its post-it's), a note while its ask's
// own lines are still in it
const retypable = (g: Group, item: number) => g.kind === 'scrap' || ownLines(g.id, item).length > 0;
// A note of the agent's typed again with new words where its ask's own lines stood (a scrap's are its post-it's), the
// board's own lines in it kept, its ask's item's line with them
function retyped(g: Group, said: string, agent: string, item: number) {
  const texts = partsOf(g).texts as Typed[],
    own = g.kind === 'note' ? ownLines(g.id, item) : null,
    mine = own && texts.filter(t => t.id !== undefined && own.includes(t.id)),
    note = mine && retypedNote(texts, mine, said, (t: Typed) => ({ ...t, id: lineId() }));
  const edit = note ? { texts: note.texts } : { words: said, said: 'typed' };
  const done = editGroup({ id: g.id, since: g.updated, ...edit }, BOARD, agent);
  if (!isRefused(done)) rewrote(g.id, item, said, note ? note.put.map((t: Typed) => t.id!) : []);
  return done;
}
// The live call's correction of something it wrote down (the replace tool: ledger.ts add): its ask is the new item's,
// and its note says the new words where the old ones stood, as change's do, the board's own lines in it kept. One whose
// own lines the board took out stays as the board left it: the follow-up has the correction.
export function replaced(call: number, was: number, item: { id: number; what: string }) {
  const c = liveCall(call);
  const on = db
    .prepare(
      `select a.grp from call_asks a join notebook_groups g on g.id = a.grp join book_pages p on p.id = g.page
        where a.item = ? and p.kind = 'call' and p.call = ? and g.deleted is null`,
    )
    .get(was, call) as { grp: number } | undefined;
  if (!c || !on) return;
  db.prepare('update call_asks set item = ? where grp = ? and item = ?').run(item.id, on.grp, was);
  const g = row(on.grp)!;
  if (retypable(g, item.id)) retyped(g, item.what, c.agent, item.id);
}
const open = (item: number) =>
  !!db.prepare("select 1 from call_items where id = ? and status = 'open' and job is null").get(item);
