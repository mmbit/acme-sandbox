// The book's pages as agents and calls read them (book.ts keeps them): any job lists and saves one (hq sketches, hq
// sketch), and a board call's agent asks for one by number or label words (the voice line's sketch tool). A call's page
// reads like any other, but a call about a card for keys keeps its pages to itself (callRead).
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { db } from '../db.ts';
import { BOARD, COLUMNS, row, summary, type Page } from './book.ts';
import { pictureOf } from './bookpicture.ts';
import type { Refused } from '../pagechecks.ts';
import type { Reader } from '../jobs.ts';
import { callAccess, keysCall } from '../memory.ts';
import { DIR } from '../pagescraps.ts';
import { ownerOf } from './sketchpeople.ts';

// ---------------------------------------------------------------- agents: hq sketches, hq sketch <id>
// Every book's pages the reader may read, archived ones (archived) or the rest, without HQ's picture address: whose
// (from: an invited person's name, null for the board's)
export const listForAgent = (archived: boolean, reader: Reader) => ({
  sketches: readable(
    (db.prepare(`select ${COLUMNS} from book_pages order by updated desc, id desc`).all() as Page[]).filter(
      p => !!p.archived === archived,
    ),
    reader,
  ).map(p => ({ ...summary(p, false), from: ownerOf(p.who) })),
});
export async function getForAgent(id: number, reader: Reader) {
  const p = row(id, null);
  if (!p) return 404;
  const access = callRead(p, reader);
  if (access !== true) return access;
  const file = await pictureOf(p);
  if (!file) return 404; // (deleted while it was drawn)
  const data = readFileSync(`${DIR}/${file}`).toString('base64');
  return { ...summary(p, false), from: ownerOf(p.who), picture: { type: 'image/png', data } };
}

// ---------------------------------------------------------------- the voice line's: a call's sketch tool
// POST /api/voice/sketch { call, sketch }: on a live call with the board, one of its book's pages for the call's agent
// (hq_tools.py's sketch tool, through the line, which counts the picture against the call's budget), archived ones
// too: by its number ('12', '#12'), or by a few words of its label (each word in it, any case; the latest change of
// those that match, the rest named). Its picture is a PNG VOICE_PX on the long side at most: what the model sees of a
// bigger one, and within the API's 2,000 px for a request with over 20 pictures (a walk-through's).
const VOICE_PX = 1568,
  NAMED = 8;
export async function forVoice(b: any) {
  const call = Number(b?.call),
    asked = typeof b?.sketch === 'string' ? b.sketch.trim() : '';
  const live = call
    ? (db.prepare("select agent from calls where id = ? and status = 'live'").get(call) as
        { agent: string } | undefined)
    : undefined;
  if (!live) return 404;
  if (!asked || asked.length > 200) return [400, "sketch is its number ('12') or a few words of its label"] as Refused;
  const all = readable(listed(BOARD), { id: 0, agent: live.agent, callId: call }, call),
    name = (p: Page) => `#${p.id}${p.label ? ` “${p.label}”` : ''}`;
  const number = /^#?([0-9]{1,9})$/.exec(asked);
  const words: string[] = asked.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const found = number
    ? all.filter(p => p.id === Number(number[1]))
    : all.filter(p => words.length && words.every(w => p.label.toLowerCase().includes(w)));
  if (!found.length) {
    const some = all.slice(0, NAMED).map(name).join(', ');
    return [
      404,
      `No page ${number ? `#${number[1]}` : 'has those words in its label'}. ${some ? `The latest: ${some}.` : 'The book is empty.'}`,
    ] as Refused;
  }
  const p = found.find(f => f.strokes || JSON.parse(f.scraps).length) ?? found[0];
  if (!p.strokes && !JSON.parse(p.scraps).length) return [409, `Page ${name(p)} has nothing on it yet.`] as Refused;
  const file = await pictureOf(p);
  if (!file) return 404; // (deleted while it was drawn)
  const png = await sharp(readFileSync(`${DIR}/${file}`))
    .resize(VOICE_PX, VOICE_PX, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const others = found
    .filter(f => f !== p)
    .slice(0, NAMED)
    .map(name);
  const line = [
    `Page ${name(p)} of the board's book${p.archived ? ' (archived)' : ''}${p.url ? `, on ${p.url}` : ''}: made ${minute(p.created)} UTC, last changed ${minute(p.updated)} UTC${p.sent ? `, last sent to the CEO ${minute(p.sent)} UTC` : ''}.`,
    ...(others.length ? [`Its label's words match ${others.join(', ')} too.`] : []),
  ].join(' ');
  return { picture: { type: 'image/png', data: png.toString('base64') }, line };
}
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const listed = (who: string) =>
  db.prepare(`select ${COLUMNS} from book_pages where who = ? order by updated desc, id desc`).all(who) as Page[];

// A call's page (its notes page, ink/callnotes.ts, what the board drew on it, or a try's versions page from its note:
// booktry.ts) reads like any page, by every job. Only a call about a card for keys (memory.ts keysCall) keeps its pages
// as it keeps its lines, for its own agent (charter rule 8). A call's own pages are its own (own: a live call reading).
function callRead(p: Page, reader: Reader, own?: number): true | 404 | [403, string] {
  if (p.call == null || p.call === own || !keysCall(p.call)) return true;
  return callAccess(p.call, reader);
}
// (each call read once)
function readable(pages: Page[], reader: Reader, own?: number) {
  const read = new Map<number, boolean>();
  return pages.filter(p => {
    if (p.call == null) return true;
    if (!read.has(p.call)) read.set(p.call, callRead(p, reader, own) === true);
    return read.get(p.call)!;
  });
}
