// A call's notes page: an ordinary page of the board's My journal, made for the call as it's picked up and titled for
// it ("28 Oct, 15:34, Call with Juno"), open while the call is live. The board writes on it as on any page; the call's agent
// adds to it, through the notebook's own scraps (notebookscraps.ts).
//   - The agent's notes: on its turn the agent writes down what the board said and drew, one note per change, each with
//     its own focused crop (the voice line's write_down tool, POST /api/voice/write-down): a part of one of the board's
//     notes on this call (bookcalls.ts), or of the board's screen at a moment of the watch-along. Each lands as it's
//     made, a 'book' event for its page, so the Notebook shows them one by one.
//   - What else the call records (ledger.ts add: a job it queues there) is on the page too, typed on a post-it: one kind
//     of note, its words alone, whoever does it.
//   - Its notes go on the page as its last units, each with room to write under it (notebookscraps.ts).
//   - Its title: the call's date and time, then a short topic the agent gives once the call's subject is clear (POST
//     /api/voice/title; who the call is with until then), whole in the Notebook's bar.
//   - A page brought to the call by its folded corner (bookshare.js) is its first scrap, in front of both.
//   - The board's notes on the call (its scribbles on HQ, bookcalls.ts) are for the agent: none becomes a note by
//     itself, the agent writes down what it judges worth keeping.
//   - The call ended: what the board wrote the old book's way on the page (a mark before the page was the notes page)
//     becomes groups (notebookcarry.ts), and the page is with the call's follow-up: read-only, unstamped, under My
//     journal's Calls (notebookchapters.js). A page with nothing on it goes.
//   - The follow-up has handed out what's on it (the call followed up, ledger.ts finished): the page is sent, its Sent
//     stamp at that time.
// Each note of the agent's on the page is an item on the call's list. Nothing on the page goes to anyone by itself: the
// call's follow-up, with the whole transcript, reads the page and hands each ask out in its brief, with the board's
// context, so nothing is misread or queued twice. Its asks: callasks.ts.
// The call engine (the watch-along, the line's driving and drawing) knows nothing of this page: Ink reads the engine
// here, through its routes, and the engine never reads Ink.
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { db, inOneStep } from '../db.ts';
import { onCall, toList } from '../callitems.ts';
import { ceo, companyTime } from '../company.ts';
import { findAgent } from '../jobs.ts';
import { keysAgent } from '../memory.ts';
import { DIR } from '../pagescraps.ts';
import * as watchalong from '../watchalong.ts';
import { regionOf } from '../region.ts';
import type { Region } from '../../../../shared/watchalong/mirror.ts';
import { BOARD, row, summary, type Page } from './book.ts';
import { pictureOf } from './bookpicture.ts';
import { changed, endOf, newPage, ownNotebook, pageOf, pageRow, shut, type NotebookPage } from '../notebook.ts';
import { addPicture, addWords } from '../notebookscraps.ts';
import { partsOf, type Group } from '../notebookgroups.ts';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';
import { carryParts } from '../notebookcarry.ts';
import { throwAway } from './bookcalls.ts';
import { GOAL, WHAT, onCallPage, oneLine } from '../ledger.ts';
import { asked, saidAtEnd, takenOff } from './callasks.ts';
import { replaced } from './callpage.ts';
import { isRefused, labelOf, refusableStep, RefusedError, type Anchor, type Refused } from '../pagechecks.ts';
import { pictureSize } from '../../../../shared/pictures/size.ts';

// The most characters of a call page's topic, after its date and time: "28 Sept, 22:55, iPad mini walkthrough" is whole
// in the bar's row on an upright iPad mini (book-check's call-title story).
const TOPIC_MOST = 21;
const titleOf = (c: Live, topic: string) => `${companyTime(Date.parse(c.ts))}, ${topic}`;

type Live = { id: number; agent: string; ts: string };
export const liveCall = (call: number) =>
  db.prepare("select id, agent, ts from calls where id = ? and status = 'live'").get(call) as Live | undefined;

// The call's notes page, made the first time it's asked for while the call is live: a new page of My journal. A call
// page the book made for the board's first mark before this one (book.ts, kind 'call') becomes it.
export function pageFor(call: number): NotebookPage | null {
  const found = db
    .prepare(
      `select id, notebook from book_pages where kind = 'call' and call = ? and who = ? and archived = 0
        and send_at is null order by id desc limit 1`,
    )
    .get(call, BOARD) as { id: number; notebook: number | null } | undefined;
  if (found?.notebook) return pageRow(found.id, BOARD)!;
  const c = liveCall(call);
  if (!c) return null;
  return inOneStep(() => {
    // (not mine(): it would carry the book's page in as an old one, its call's notes as sent)
    const notebook = ownNotebook(BOARD);
    const id = found?.id ?? newPage(notebook);
    if (found)
      db.prepare('update book_pages set notebook = ?, pos = ? where id = ?').run(notebook, endOf(notebook), id);
    // (a call about a card for keys owns its page, so what the board sends from it goes to the call's agent:
    // notebooksend.ts.)
    db.prepare("update book_pages set kind = 'call', call = ?, owner = ?, label = ? where id = ?").run(
      call,
      keysAgent(call),
      titleOf(c, `Call with ${findAgent(c.agent)?.name ?? c.agent}`),
      id,
    );
    changed(notebook, id);
    return pageRow(id, BOARD)!;
  });
}

// POST /api/book/page/new { kind: 'call', call }: a live call's page is its notes page, made now if it isn't yet (the
// book's first mark on a call, a walk-through's as it's picked up), never a second one. null: make the page as the book
// does.
export function openPageOf(b: any, who: string) {
  if (b?.kind !== 'call' || who !== BOARD) return null;
  const call = Number(b.call);
  const p = Number.isInteger(call) && call > 0 ? pageFor(call) : null;
  return p ? summary(row(p.id, who)!) : null;
}
// The call's notes page while it's open (made at pickup or by the agent's first scrap or title), if it has one
function openPage(call: number) {
  const open = db
    .prepare(`select id from book_pages where ${CALL_PAGE} and who = ? and archived = 0 and send_at is null`)
    .get(call, BOARD) as { id: number } | undefined;
  return open?.id;
}

// POST /api/notebooks/call { call, page?, design? }: the live call's notes page, for HQ to open as the call starts;
// page: one of the board's pages brought to the call by its folded corner, put on it as its first scrap (once); design
// (true): it's a design session's, a sketch page from now on (notebook.ts sketch), its units so far pinned where the
// masonry laid them as HQ first lays it as a canvas (sketchcanvas.js).
export async function openFor(b: any) {
  const call = Number(b?.call);
  const p = Number.isInteger(call) && call > 0 ? pageFor(call) : null;
  if (!p) return [404, 'no live call of yours by that number'] as Refused;
  if (b.design != null && b.design !== true) return [400, 'design is true'] as Refused;
  if (b.design && !p.sketch) {
    db.prepare('update book_pages set sketch = 1 where id = ?').run(p.id);
    changed(p.notebook, p.id);
  }
  const brought = b.page == null ? null : (pageRow(Number(b.page), BOARD) ?? null);
  if (b.page != null && !brought) return [404, 'no such page to bring'] as Refused;
  if (brought && brought.id !== p.id && !hasGroups(p.id)) await bring(p, brought);
  return { notebook: p.notebook, page: pageOf(pageRow(p.id, BOARD)!), day: p.day };
}
async function bring(p: NotebookPage, brought: NotebookPage) {
  const file = await pictureOf(brought as Page);
  if (!file) return;
  const picture = { type: 'image/png', clean: readFileSync(`${DIR}/${file}`) };
  place(p, BOARD, picture, { words: brought.label, anchor: pageAnchor(brought.id), owner: null });
}

// POST /api/voice/write-down { call, from?, region?, words, goal, owner?, deadline?, board_set?, job?, deliverable? }:
// one thing to be done, written down in the call's notes: a scrap, the part of what the board drew or showed that it's
// about (region, fractions of the picture from its top left) with the agent's words for it, or with neither from nor
// region a plain note, the words alone on a post-it. from: 'note 3' (the board's note 3 on this call), or
// a moment of the shown screen ('now', '-20s', '17:03:12', '#12'). owner: the agent who sees it through, for the call's
// follow-up to hand it to (none: the follow-up decides; on a call about a card for keys only the call's agent, its
// owner left out too). It's an item on the call's list too, a task (the CEO's to see through without an owner) with
// goal, the board's why, and its time and the work under way it's about, as callitems.ts checks them before anything is
// written in. The agent's: the board's Undo never takes it off (the board deletes it by hand).
export async function writeDown(b: any) {
  const call = Number(b?.call);
  const c = Number.isInteger(call) && call > 0 ? liveCall(call) : undefined;
  if (!c) return [404, 'This call has ended: its notes have gone in.'] as Refused;
  const note = noteOf(b, call);
  if (isRefused(note)) return note;
  const { words, goal, owner } = note;
  const plain = b.from == null && b.region == null;
  const cut = plain ? null : await cutFrom(call, b);
  if (isRefused(cut)) return cut;
  // (the call ended while its picture was cut: its page has started to send)
  if (!liveCall(call)) return [404, 'This call has ended: its notes have gone in.'] as Refused;
  const p = pageFor(call)!;
  if (shut(p)) return [409, 'This call’s notes have gone in.'] as Refused;
  const time = { deadline: b.deadline, board_set: b.board_set, job: b.job, thread: b.deliverable };
  const item = { kind: 'task', owner: owner ?? ceo(), what: words, goal, quote: words, ...time };
  const listed = toList(call, item, onCall(c), false);
  if (isRefused(listed)) return listed;
  // (its item first, so a refused one leaves nothing in the notes; a note that can't go in takes its item back with it)
  return refusableStep(() => {
    const added = listed();
    if (isRefused(added)) return added;
    const g = cut
      ? place(p, c.agent, cut.picture, { words, anchor: cut.anchor, owner })
      : addWords(p, c.agent, words, { owner });
    if (isRefused(g)) throw new RefusedError(g);
    asked(g.id, { id: added.id, what: words });
    return { ok: writtenDown(g, !!cut, added.id, words), id: g.id };
  });
}
// A note's words, goal and owner (none: the follow-up decides), or why not
function noteOf(b: any, call: number) {
  const words = typeof b.words === 'string' ? b.words.replace(/\s+/g, ' ').trim() : '';
  // (a scrap's words, its post-it's, are its item's line)
  if (!words || [...words].length > WHAT)
    return [400, `words: the one change, in a line of at most ${WHAT} characters`] as Refused;
  const goal = oneLine(b.goal, GOAL);
  if (!goal)
    return [400, `goal: why the board wants it, in its own terms, one line of at most ${GOAL} characters`] as Refused;
  if (b.owner != null && !(typeof b.owner === 'string' && findAgent(b.owner)))
    return [400, 'owner: the id of the agent whose work it is, or left out'] as Refused;
  // (a call about a card for keys is its own agent's alone: memory.ts keysAgent.)
  const keys = keysAgent(call);
  if (keys && b.owner != null && b.owner !== keys)
    return [
      400,
      `owner: this call is about a card for keys, so its work is ${keys}'s alone: name ${keys} or leave it out`,
    ] as Refused;
  return { words, goal, owner: (b.owner ?? keys) as string | null };
}
// write_down's answer: the note's id and its item's, and a picture's box
function writtenDown(g: Group, pictured: boolean, item: number, words: string) {
  // (a picture's box, for the agent to circle the spot on it with mark_notes.)
  const box = pictured ? boxOf(partsOf(g)) : null;
  const listedAs = `#${g.id}; item #${item} on the call's list`;
  const what = box
    ? `Written down (${listedAs}), its picture at ${boxWords(box)}`
    : `Written down (${listedAs}), your words alone with no picture`;
  const circle = box ? ' Circle the spot on it with mark_notes where that helps.' : '';
  return `${what}, appearing as the board watches: “${words}”.${circle}`;
}
// A group's box as the agent reads it, read_notes and write_down alike: x, y, width and height in the page's px
export const boxWords = (box: { x: number; y: number; w: number; h: number }) =>
  [box.x, box.y, box.w, box.h].map(Math.round).join(', ');
// A scrap's cut: its region of what it's cut from
async function cutFrom(call: number, b: any) {
  const region = regionOf(b.region);
  if (!region)
    return [
      400,
      'region: { x, y, width, height }, the part of the picture the change is about, fractions from 0 to 1',
    ] as Refused;
  return cutOf(call, String(b.from ?? '').trim(), region);
}
// The picture a scrap cuts from, and where it was: one of the board's notes on the call, or the screen at a moment
async function cutOf(call: number, from: string, region: Region) {
  const note = /^note\s*#?(\d{1,4})$/i.exec(from);
  if (note) {
    const n = db
      .prepare(
        `select n.snip, n.anchor from book_notes n join book_pages p on p.id = n.page
          where p.kind = 'call' and p.call = ? and n.n = ? and n.by = p.who order by n.id desc limit 1`,
      )
      .get(call, Number(note[1])) as { snip: string | null; anchor: string } | undefined;
    if (!n?.snip || !existsSync(`${DIR}/${n.snip}`))
      return [404, `The board has no note ${note[1]} with a picture on this call.`] as Refused;
    const whole = readFileSync(`${DIR}/${n.snip}`);
    return {
      picture: { type: 'image/png', clean: await cropped(whole, region) },
      anchor: JSON.parse(n.anchor) as Anchor,
    };
  }
  if (!from)
    return [
      400,
      "from: 'note 3' (one of the board's notes on this call) or a moment of the shown screen ('now', '-20s', '17:03:12', '#12')",
    ] as Refused;
  const got = await watchalong.screen({ purpose: 'call', ref: String(call), at: from, region });
  if (Array.isArray(got)) return [got[0], got[1]] as Refused;
  const shot = (got as { picture?: { data: string } }).picture;
  if (!shot) return [404, watchalong.NOTHING] as Refused;
  return {
    picture: { type: 'image/jpeg', clean: Buffer.from(shot.data, 'base64') },
    anchor: { v: 1, url: `/?call=${call}`, el: null, view: { x: 0, y: 0, w: 0, h: 0, dpr: 1 }, ink: [] } as Anchor,
  };
}
// A region of a picture (fractions), at least a pixel each way
export async function cropped(picture: Buffer, r: Region) {
  const { width, height } = pictureSize(picture)!;
  const left = Math.min(width - 1, Math.floor(r.x * width)),
    top = Math.min(height - 1, Math.floor(r.y * height));
  const w = Math.max(1, Math.min(width - left, Math.round(r.width * width))),
    h = Math.max(1, Math.min(height - top, Math.round(r.height * height)));
  return sharp(picture).extract({ left, top, width: w, height: h }).png().toBuffer();
}
// A scrap as the page's last
const place = (
  p: NotebookPage,
  by: string,
  picture: { type: string; clean: Buffer },
  more: { words: string; anchor: Anchor; owner: string | null },
) => addPicture(p, by, picture, { ...more, said: more.words ? 'typed' : null });

// POST /api/voice/title { call, title }: the page's topic, a few words for what the call is about, after its date and time
export function title(b: any) {
  const call = Number(b?.call);
  const c = Number.isInteger(call) && call > 0 ? liveCall(call) : undefined;
  if (!c) return [404, 'This call has ended: its notes have gone in.'] as Refused;
  const t = labelOf(b.title);
  if (isRefused(t)) return t;
  if (!t || [...t].length > TOPIC_MOST)
    return [
      400,
      `title: what the call is about in at most ${TOPIC_MOST} characters ("Shop page prices"); the page keeps the call's date and time in front of it`,
    ] as Refused;
  const p = pageFor(call)!;
  if (p.title_by === 'board') return { ok: "The board's own title for the call's notes stays." };
  const label = titleOf(c, t);
  db.prepare("update book_pages set label = ?, title_by = 'agent' where id = ?").run(label, p.id);
  changed(p.notebook, p.id);
  return { ok: `The call's notes are titled “${label}”.` };
}

// What else a live call records (ledger.ts add: a job it queues), written on its page in type as any note of the agent's,
// its words alone: an ask for its owner, which the follow-up hands out. Only on a page the call has: a call on the phone
// has none
export function noted(call: number, item: { id: number; kind: string; owner: string; what: string }) {
  const c = liveCall(call);
  const open = c && openPage(call);
  if (!c || !open) return;
  const p = pageRow(open, BOARD)!;
  const g = addWords(p, c.agent, item.what, { owner: item.owner });
  if (!isRefused(g)) asked(g.id, item);
}
// The call has ended (call.ts handOver, ledger.ts sweep): its page is shut as it is, staying where it is, with the
// call's follow-up till it's handed out (followed), or is deleted if nothing is on it. Nothing on it goes to anyone: the call's follow-up reads it with the transcript and hands each ask
// out with the board's context
export function ended(call: number) {
  takenOff(call);
  saidAtEnd(call);
  const open = openPage(call);
  if (!open) return;
  const p = pageRow(open, BOARD)!;
  // (what the book wrote on it the old way. The board's notes stay the call's: none goes in by itself.)
  carryParts(p, []);
  if (!hasGroups(p.id)) {
    throwAway(p.id);
    db.prepare('delete from book_pages where id = ?').run(p.id);
    return changed(p.notebook, null);
  }
  db.prepare("update notebook_groups set status = 'sent' where page = ? and status = 'open'").run(p.id);
  db.prepare('update book_pages set send_at = ? where id = ?').run(Date.now(), p.id);
  changed(p.notebook, p.id);
}
// The call's follow-up has handed out what's on its notes page (the call followed up, ledger.ts finished): the page is
// sent, stamped Sent at this moment, once (a later follow-up of the same call stamps nothing again).
export function followed(call: number) {
  const p = db
    .prepare(`select id, notebook from book_pages where ${CALL_PAGE} and send_at is not null and followed is null`)
    .get(call) as { id: number; notebook: number } | undefined;
  if (!p) return;
  db.prepare('update book_pages set followed = ? where id = ?').run(Date.now(), p.id);
  changed(p.notebook, p.id);
}
// The call's notes page, gone in or still open, for its follow-up to read (hq sketch): none if it had nothing on it
const pageOfCall = (call: number) =>
  (db.prepare(`select id from book_pages where ${CALL_PAGE} order by id desc`).get(call) as { id: number } | undefined)
    ?.id;
// Which page is the call's (the call's number its one parameter.)
const CALL_PAGE = "kind = 'call' and call = ? and notebook is not null";
const hasGroups = (page: number) =>
  !!db.prepare('select 1 from notebook_groups where page = ? and parent is null and deleted is null limit 1').get(page);
const pageAnchor = (id: number): Anchor => ({
  v: 1,
  url: `/api/book/picture?id=${id}`,
  el: null,
  view: { x: 0, y: 0, w: 0, h: 0, dpr: 1 },
  ink: [],
});

// what's recorded on a call and its end reach the page through the ledger's hook (the ledger loads no Ink)
onCallPage({
  noted,
  replaced,
  ended,
  followed,
  page: pageOfCall,
  open: call => !!(liveCall(call) && openPage(call)),
});
