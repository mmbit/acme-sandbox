// The book's pages as agents and calls read them (book.ts keeps them): any job lists and saves one (hq sketches, hq
// sketch), and a board call's agent asks for one by number or label words (the voice line's sketch tool). A call's page
// reads like any other, but a call about a card for keys keeps its pages to itself, and a customer call's go to its
// readers (callRead).
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { db, scrubbed } from '../db.ts';
import * as latency from '../latency.ts';
import { BOARD, COLUMNS, row, summary, type Page } from './book.ts';
import { pictureOf } from './bookpicture.ts';
import type { Refused } from '../pagechecks.ts';
import { readsCustomerData, type Reader } from '../jobs.ts';
import { callAccess, customerCall, keysCall } from '../memory.ts';
import { DIR } from '../pagescraps.ts';
import { ownerOf } from './sketchpeople.ts';
import { cutsOf, piecesFor } from '../../../hq/shell/ink/booksharefiles.js';

// ---------------------------------------------------------------- agents: hq sketches, hq sketch <id>
// Every book's pages the reader may read, archived ones (archived) or the rest, without HQ's picture address: whose
// (from: an invited person's name, null for the board's)
export const listForAgent = (archived: boolean, reader: Reader) => ({
  sketches: readable(
    (db.prepare(`select ${COLUMNS} from book_pages order by updated desc, id desc`).all() as Page[]).filter(
      p => !!p.archived === archived,
    ),
    reader,
  ).map(p => ({ ...shownTo(p, reader), from: ownerOf(p.who) })),
});
export async function getForAgent(id: number, reader: Reader) {
  const p = row(id, null);
  if (!p || !readsPage(p, reader)) return 404;
  const access = pageRead(p, reader, callRead(p, reader));
  if (access !== true) return access;
  const file = await pictureOf(p);
  if (!file) return 404; // (deleted while it was drawn)
  await latency.exclude(scrubbed()); // (its call's summary read after a save's scrub: db.ts scrubSaved)
  const data = readFileSync(`${DIR}/${file}`).toString('base64');
  return { ...shownTo(p, reader), from: ownerOf(p.who), picture: { type: 'image/png', data } };
}
// An invited person's own page carries their notes, name and what their screenshots caught (on a tester's checkout,
// what they typed in), like an outside reviewer's note (feedback.ts readsOutside): read only by roles.customerData and
// the jobs it went to (a sheet of it, or its review round's Advice: notebookrounds.ts).
const SENT_TO = `select 1 from book_notes n join book_sheets s on s.id = n.sheet where n.page = ?1 and s.job = ?2
  union all select 1 from notebook_guests g join notebook_rounds r on r.notebook = g.notebook where g.page = ?1 and r.advice = ?2`;
const sentTo = (p: Page, reader: Reader) => !!reader.id && !!db.prepare(SENT_TO).get(p.id, reader.id);
function readsPage(p: Page, reader: Reader) {
  if (p.who === BOARD) return true;
  return sentTo(p, reader) || readsCustomerData(reader);
}
// A page as a job reads it. A customer call's summary is the follow-up's account of the call (calls.reply), with the
// customer's details in it: only the call's own readers (callAccess) get it, not a job only a sheet of the page went
// to.
function shownTo(p: Page, reader: Reader) {
  const shown = summary(p, false);
  if (p.kind !== 'call' || p.call == null || !shown.summary || !customerCall(p.call)) return shown;
  return callAccess(p.call, reader) === true ? shown : { ...shown, summary: null };
}

// ---------------------------------------------------------------- the voice line's: a call's sketch tool
// POST /api/voice/sketch { call, sketch }: on a live call with the board, one of its book's pages for the call's agent
// (hq_tools.py's sketch tool, through the line, which counts the picture against the call's budget), archived ones
// too: by its number ('12', '#12'), or by a few words of its label (each word in it, any case; the latest change of
// those that match, the rest named). Its picture is PNGs VOICE_PX on the long side at most: what the model sees of a
// bigger one, and within the API's 2,000 px for a request with over 20 pictures (a walk-through's). A long page goes in
// pieces down it, as one dropped on a call does (booksharefiles.js), so its notes reach the model at a readable size.
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
  const pictures = await piecesOf(readFileSync(`${DIR}/${file}`));
  const others = found
    .filter(f => f !== p)
    .slice(0, NAMED)
    .map(name);
  const line = [
    `Page ${name(p)} of the board's book${p.archived ? ' (archived)' : ''}${p.url ? `, on ${p.url}` : ''}: made ${minute(p.created)} UTC, last changed ${minute(p.updated)} UTC${p.sent ? `, last sent to the CEO ${minute(p.sent)} UTC` : ''}.`,
    ...(pictures.length > 1
      ? [`It's long: in ${pictures.length} pieces from its top down, each overlapping the last.`]
      : []),
    ...(others.length ? [`Its label's words match ${others.join(', ')} too.`] : []),
  ].join(' ');
  return { pictures: pictures.map(png => ({ type: 'image/png', data: png.toString('base64') })), line };
}
// A page's picture (png, grown down to its last words) in as many pieces as its shape asks for, each VOICE_PX on its
// long side at most
async function piecesOf(png: Buffer) {
  const { width = 1, height = 1 } = await sharp(png).metadata();
  return Promise.all(
    cutsOf(piecesFor(width, height), height).map(({ top, height }) =>
      sharp(png)
        .extract({ left: 0, top, width, height })
        .resize(VOICE_PX, VOICE_PX, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer(),
    ),
  );
}
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const listed = (who: string) =>
  db.prepare(`select ${COLUMNS} from book_pages where who = ? order by updated desc, id desc`).all(who) as Page[];

// A call's page (its notes page, ink/callnotes.ts, what the board drew on it, or a try's versions page from its note:
// booktry.ts) reads like any page, by every job. Only a call about a card for keys (memory.ts keysCall) keeps its pages
// as it keeps its lines, for its own agent (charter rule 8), and a call about a customer (memory.ts customerCall) its
// pages as its lines: the scrap tool put crops of the customer's screen on them, and the agent's notes on those
// (pageRead). A call's own pages are its own (own: a live call reading).
function callRead(p: Page, reader: Reader, own?: number): true | 404 | [403, string] {
  if (p.call == null || p.call === own || !(keysCall(p.call) || customerCall(p.call))) return true;
  return callAccess(p.call, reader);
}
// A customer call's page reads for the call's readers (callAccess) and the jobs a sheet of it went to (as an invited
// person's page: readsPage).
function pageRead(p: Page, reader: Reader, call: ReturnType<typeof callRead>, own?: number) {
  if (p.call == null || p.call === own || !customerCall(p.call)) return call;
  return sentTo(p, reader) || call;
}
// (each call read once)
function readable(pages: Page[], reader: Reader, own?: number) {
  const read = new Map<number, ReturnType<typeof callRead>>();
  return pages.filter(p => {
    if (!readsPage(p, reader)) return false;
    if (p.call == null) return true;
    if (!read.has(p.call)) read.set(p.call, callRead(p, reader, own));
    return pageRead(p, reader, read.get(p.call)!, own) === true;
  });
}
