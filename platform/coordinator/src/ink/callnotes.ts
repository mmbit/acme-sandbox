// A call's notes page: an ordinary page of the board's My Notebook, made for the call as it's picked up and titled for
// it ("Call with Juno, 15:34"), open while the call is live. The board writes on it as on any page; the call's agent
// adds to it, through the notebook's own scraps (notebookscraps.ts).
//   - The agent's scraps: on its turn the agent turns what the board said and drew into one scrap per change, each its
//     own focused crop (the voice line's scrap tool, POST /api/voice/scrap): a part of one of the board's notes on this
//     call (bookcalls.ts), or of the board's screen at a moment of the watch-along. Each lands as it's made, a 'book'
//     event for its page, so the Notebook shows them one by one.
//   - The agent's notes: what it records on the call (ledger.ts add) is written on the page too, in type.
//   - Its title: a few words the agent gives once the call's subject is clear (POST /api/voice/title), a title, not a
//     summary.
//   - A page brought to the call by its folded corner (bookshare.js) is its first scrap, in front of both.
//   - The call ended: what the board wrote the old book's way on the page (a mark before the page was the notes page)
//     and the notes no scrap was cut from become groups (notebookcarry.ts), the page is sent as any page is
//     (notebooksend.ts: each group to its agent), and stays among My Notebook's pages like any sent page. A page with
//     nothing on it goes.
// The call engine (the watch-along, the line's driving and drawing) knows nothing of this page: Ink reads the engine
// here, through its routes, and the engine never reads Ink.
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { db, inOneStep } from '../db.ts';
import { companyTime } from '../company.ts';
import { findAgent } from '../jobs.ts';
import { DIR } from '../pagescraps.ts';
import * as watchalong from '../watchalong.ts';
import { regionOf } from '../region.ts';
import type { Region } from '../../../../shared/watchalong/mirror.ts';
import { BOARD, COLUMNS, row, summary, type Page } from './book.ts';
import { pictureOf } from './bookpicture.ts';
import { changed, endOf, newPage, ownNotebook, pageOf, pageRow, shut, type NotebookPage } from '../notebook.ts';
import { stackPicture, stackWords } from '../notebookscraps.ts';
import { RESEND, sendPage } from '../notebooksend.ts';
import { carryParts } from '../notebookcarry.ts';
import type { Note } from './booknotes.ts';
import { onCallPage } from '../ledger.ts';
import { isRefused, labelOf, type Anchor, type Refused } from '../pagechecks.ts';
import { pictureSize } from '../../../../shared/pictures/size.ts';

// The most of its words a scrap carries (its post-it's)
const WORDS_MOST = 280;

// The board's note on the call each scrap was cut from, if it was
db.exec('create table if not exists call_scraps (scrap integer primary key, note integer not null)');

type Live = { id: number; agent: string; ts: string };
const liveCall = (call: number) =>
  db.prepare("select id, agent, ts from calls where id = ? and status = 'live'").get(call) as Live | undefined;

// The call's notes page, made the first time it's asked for while the call is live: a new page of My Notebook. A call
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
    db.prepare("update book_pages set kind = 'call', call = ?, label = ? where id = ?").run(
      call,
      `Call with ${findAgent(c.agent)?.name ?? c.agent}, ${companyTime(Date.parse(c.ts))}`,
      id,
    );
    changed(notebook, id);
    return pageRow(id, BOARD)!;
  });
}

// POST /api/book/page/new { kind: 'call', call }: the call's notes page, open already, is the call's page (the book's
// first mark on a call finds it there), never a second one. null: make the page as the book does.
export function openPageOf(b: any, who: string) {
  if (b?.kind !== 'call' || who !== BOARD) return null;
  const open = openPage(Number(b.call));
  return open ? summary(row(open, who)!) : null;
}
// The call's notes page while it's open (made at pickup or by the agent's first scrap or title), if it has one
function openPage(call: number) {
  const open = db
    .prepare(
      `select id from book_pages where kind = 'call' and call = ? and who = ? and archived = 0 and send_at is null
        and notebook is not null`,
    )
    .get(call, BOARD) as { id: number } | undefined;
  return open?.id;
}

// POST /api/notebooks/call { call, page? }: the live call's notes page, for HQ to open as the call starts; page: one of
// the board's pages brought to the call by its folded corner, put on it as its first scrap (once)
export async function openFor(b: any) {
  const call = Number(b?.call);
  const p = Number.isInteger(call) && call > 0 ? pageFor(call) : null;
  if (!p) return [404, 'no live call of yours by that number'] as Refused;
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

// POST /api/voice/scrap { call, from, region, words, owner? }: one change the board asked for on the call, as a scrap
// on its notes page: the part of what the board drew or showed that the change is about (region, fractions of the
// picture from its top left), with the agent's words for the change. from: 'note 3' (the board's note 3 on this
// call), or a moment of the shown screen ('now', '-20s', '17:03:12', '#12'). owner: the agent whose work it is, who
// gets it when the page is sent (none: the routing check decides).
export async function scrap(b: any) {
  const call = Number(b?.call);
  const c = Number.isInteger(call) && call > 0 ? liveCall(call) : undefined;
  if (!c) return [404, 'This call has ended: its page has gone in.'] as Refused;
  const words = typeof b.words === 'string' ? b.words.replace(/\s+/g, ' ').trim() : '';
  if (!words || [...words].length > WORDS_MOST)
    return [400, `words: the one change, in a line of at most ${WORDS_MOST} characters`] as Refused;
  const region = regionOf(b.region);
  if (!region)
    return [
      400,
      'region: { x, y, width, height }, the part of the picture the change is about, fractions from 0 to 1',
    ] as Refused;
  if (b.owner != null && !(typeof b.owner === 'string' && findAgent(b.owner)))
    return [400, 'owner: the id of the agent whose work it is, or left out'] as Refused;
  const cut = await cutOf(call, String(b.from ?? '').trim(), region);
  if (isRefused(cut)) return cut;
  // (the call ended while its picture was cut: its page has started to send)
  if (!liveCall(call)) return [404, 'This call has ended: its page has gone in.'] as Refused;
  const p = pageFor(call)!;
  if (shut(p)) return [409, 'This call’s page has gone in.'] as Refused;
  const g = place(p, c.agent, cut.picture, { words, anchor: cut.anchor, owner: b.owner ?? null });
  if (cut.note) db.prepare('insert into call_scraps (scrap, note) values (?, ?)').run(g.id, cut.note);
  const n = (
    db
      .prepare(
        "select count(*) n from notebook_groups where page = ? and kind = 'scrap' and by = ? and deleted is null",
      )
      .get(p.id, c.agent) as { n: number }
  ).n;
  return { ok: `Scrap ${n} is on the call's page, popping in as the board watches: “${words}”.`, id: g.id };
}
// The picture a scrap cuts from, and where it was: one of the board's notes on the call, or the screen at a moment
async function cutOf(call: number, from: string, region: Region) {
  const note = /^note\s*#?(\d{1,4})$/i.exec(from);
  if (note) {
    const n = db
      .prepare(
        `select n.id, n.snip, n.anchor from book_notes n join book_pages p on p.id = n.page
          where p.kind = 'call' and p.call = ? and n.n = ? and n.by = p.who order by n.id desc limit 1`,
      )
      .get(call, Number(note[1])) as { id: number; snip: string | null; anchor: string } | undefined;
    if (!n?.snip || !existsSync(`${DIR}/${n.snip}`))
      return [404, `The board has no note ${note[1]} with a picture on this call.`] as Refused;
    const whole = readFileSync(`${DIR}/${n.snip}`);
    return {
      picture: { type: 'image/png', clean: await cropped(whole, region) },
      anchor: JSON.parse(n.anchor) as Anchor,
      note: n.id,
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
    note: null,
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
// A scrap under what's on the page
const place = (
  p: NotebookPage,
  by: string,
  picture: { type: string; clean: Buffer },
  more: { words: string; anchor: Anchor; owner: string | null },
) => stackPicture(p, by, picture, { ...more, said: more.words ? 'typed' : null });

// POST /api/voice/title { call, title }: the page's title, a few words for what the call is about
export function title(b: any) {
  const call = Number(b?.call);
  const c = Number.isInteger(call) && call > 0 ? liveCall(call) : undefined;
  if (!c) return [404, 'This call has ended: its page has gone in.'] as Refused;
  const t = labelOf(b.title);
  if (isRefused(t)) return t;
  if (!t || t.split(' ').length > 8)
    return [400, 'title: a few words (at most 8) naming what the call is about'] as Refused;
  const p = pageFor(call)!;
  if (p.title_by === 'board') return { ok: "The board's title stays on the call's page." };
  db.prepare("update book_pages set label = ?, title_by = 'agent' where id = ?").run(t, p.id);
  changed(p.notebook, p.id);
  return { ok: `The call's page is titled “${t}”.` };
}

// What the agent records on a live call (ledger.ts add), written on its page in type. Only on a page the call has: a
// call on the phone has none
export function noted(call: number, item: { kind: string; owner: string; what: string }) {
  const c = liveCall(call);
  const open = c && openPage(call);
  if (!c || !open) return;
  const p = pageRow(open, BOARD)!;
  const owner = findAgent(item.owner)?.name ?? (item.owner === 'board' ? 'you' : item.owner);
  const text = `${item.kind[0].toUpperCase()}${item.kind.slice(1)} for ${owner}: ${item.what}`;
  stackWords(p, c.agent, text, {});
}

// The call has ended (call.ts handOver, ledger.ts sweep): its page sent, staying where it is, or gone if nothing is on it
export async function ended(call: number) {
  const p = db
    .prepare(
      `select ${COLUMNS}, notebook from book_pages where kind = 'call' and call = ? and archived = 0 and send_at is null
        and notebook is not null order by id desc`,
    )
    .get(call) as (Page & { notebook: number }) | undefined;
  if (!p || pageRow(p.id, BOARD)!.send_at !== null) return;
  // (what the book wrote on it the old way, and the board's notes no scrap was cut from: nothing it drew is lost. A
  // note the shelf carried is on the page already)
  const uncut = db
    .prepare(
      `select * from book_notes where page = ? and by = ? and id not in (select c.note from call_scraps c
        join notebook_groups g on g.id = c.scrap where g.deleted is null) order by id`,
    )
    .all(p.id, p.who) as Note[];
  const carried = (
    db.prepare('select note from notebook_groups where page = ? and note is not null').all(p.id) as { note: number }[]
  ).map(g => g.note);
  carryParts(
    p,
    uncut.filter(n => !carried.includes(n.id)),
  );
  // (the call's sheet is never sent, so the Notebook's carry takes its notes as gone: they go with the page, each to the
  // routing check)
  db.prepare(
    `update notebook_groups set status = 'open', note = null, owner = null where page = ? and kind = 'scrap'
      and note in (select value from json_each(?))`,
  ).run(p.id, JSON.stringify(uncut.map(n => n.id)));
  // (the agent's own typed notes go back to nobody: what it recorded is its follow-up's. One the board wrote on goes.)
  db.prepare(
    `update notebook_groups set status = 'sent' where page = ? and kind = 'drawing' and by != ? and status = 'open'
      and ink = '[]' and pictures = '[]'`,
  ).run(p.id, p.who);
  if (!hasGroups(p.id)) {
    db.prepare('delete from book_pages where id = ?').run(p.id);
    return changed(p.notebook, null);
  }
  const open = db
    .prepare("select 1 from notebook_groups where page = ? and parent is null and deleted is null and status = 'open'")
    .get(p.id);
  // (only the agent's typed notes on it: nothing to send, so it goes in as it is, not left as My Notebook's open page)
  if (open) await send(call, p.id);
  else db.prepare('update book_pages set send_at = ? where id = ?').run(Date.now(), p.id);
  // (the fresh page a send makes: My Notebook's own current page stays its current one)
  const fresh = pageRow(p.id, BOARD)!.fresh;
  if (fresh) db.prepare('delete from book_pages where id = ?').run(fresh);
  changed(p.notebook, p.id);
}
// The call's page sent, again while the board changes it in the Notebook as it goes; any other refusal leaves it open on
// the shelf
async function send(call: number, page: number) {
  let sent = await sendPage({ id: page });
  for (let tries = 1; isRefused(sent) && sent[1] === RESEND && tries < 3; tries++) sent = await sendPage({ id: page });
  if (isRefused(sent) || typeof sent !== 'object')
    throw new Error(
      `Call #${call}: its notes page #${page} wasn't sent (${JSON.stringify(sent)}); it stays open on the shelf`,
    );
}
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
onCallPage({ noted, ended });
