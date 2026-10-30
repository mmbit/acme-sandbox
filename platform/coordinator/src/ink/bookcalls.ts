// A call's page in the book (book.ts, kind 'call'): what the board drew on a call, numbered as a sheet's notes are. A
// live call's is its notes page (callnotes.ts openPageOf); an old-book one stays for a call that ended without one.
//   - Its notes sit on a sheet of their own (status 'call'), which is never sent: the agent on the call heard each one
//     as the Pencil lifted (the voice line fetches it here, forVoice, and counts its picture against the call's).
//   - The agent's ink is never here: its rings only catch the board's eye on the call, over the page, and go with it
//   - Kept until the board throws the page away in one tap (book.ts deletePage takes its notes with it), with the
//     call's summary on top once the call's follow-up has written it (book.ts summary). One nobody wrote on goes by
//     itself once its call is gone (sweep).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { db, once } from '../db.ts';
import { DIR } from '../pagescraps.ts';
import { deletePage, type Page } from './book.ts';
import type { Refused } from '../pagechecks.ts';
import { PREVIEW } from '../config.ts';

const agentOf = (call: number | null) =>
  (db.prepare('select agent from calls where id = ?').get(call) as { agent: string } | undefined)?.agent;

// The sheet a call's page's notes go on (made with its first note)
export function onCall(page: Page) {
  const agent = agentOf(page.call);
  if (!agent) return [404, "this call's page has no call any more"] as Refused;
  const found = db
    .prepare(
      "select s.id from book_sheets s join book_notes n on n.sheet = s.id where n.page = ? and s.status = 'call' limit 1",
    )
    .get(page.id) as { id: number } | undefined;
  const sheet =
    found?.id ??
    Number(
      db
        .prepare("insert into book_sheets (who, owner, status, created) values (?, ?, 'call', ?)")
        .run(page.who, agent, new Date().toISOString()).lastInsertRowid,
    );
  return { sheet };
}

// A call's page thrown away: its notes, their snips and their sheet go with it
export function throwAway(page: number) {
  const notes = db.prepare('select id, sheet, snip from book_notes where page = ?').all(page) as {
    id: number;
    sheet: number;
    snip: string | null;
  }[];
  for (const n of notes) if (n.snip) rmSync(`${DIR}/${n.snip}`, { force: true });
  db.prepare('delete from book_notes where page = ?').run(page);
  for (const sheet of new Set(notes.map(n => n.sheet)))
    db.prepare(
      "delete from book_sheets where id = ? and status = 'call' and not exists (select 1 from book_notes where sheet = ?)",
    ).run(sheet, sheet);
}

// GET /api/voice/note?id=&call=: a note the board drew on a live call, for the call's agent: its number on the call's
// page, its words, the HQ page it's on and its snip (the page around the mark, the ink on it), or null without one
export function forVoice(id: number, call: number) {
  const n = db
    .prepare(
      `select n.n, n.words, n.anchor, n.snip from book_notes n join book_pages p on p.id = n.page
        join calls c on c.id = p.call where n.id = ? and p.call = ? and p.kind = 'call' and n.by = p.who and c.status = 'live'`,
    )
    .get(id, call) as { n: number; words: string; anchor: string; snip: string | null } | undefined;
  if (!n) return 404;
  const file = n.snip && `${DIR}/${n.snip}`;
  const picture =
    file && existsSync(file)
      ? { type: file.endsWith('.png') ? 'image/png' : 'image/jpeg', data: readFileSync(file).toString('base64') }
      : null;
  return { n: n.n, words: n.words, url: pathOf(JSON.parse(n.anchor).url), picture };
}
// (an anchor's address as HQ's own pages name it: its path and query; a preview's in HQ's viewer, its whole address, so
// the agent knows it's not HQ's.)
function pathOf(url: unknown) {
  const u = new URL(String(url), 'https://x');
  return (u.host.endsWith(PREVIEW) ? u.origin : '') + u.pathname + u.search;
}

// The call's agent's rings that older calls kept as notes on their pages: gone, with a page they leave with nothing of
// the board's on it. The board's own notes, ink, pictures and words stay as they are.
export function dropAgentInk() {
  const rings = db
    .prepare(
      `select n.id, n.page, n.sheet, n.snip, p.who from book_notes n join book_pages p on p.id = n.page
        where p.kind = 'call' and n.by != p.who`,
    )
    .all() as { id: number; page: number; sheet: number; snip: string | null; who: string }[];
  for (const n of rings) {
    if (n.snip) rmSync(`${DIR}/${n.snip}`, { force: true });
    db.prepare('delete from book_notes where id = ?').run(n.id);
  }
  for (const sheet of new Set(rings.map(n => n.sheet)))
    db.prepare(
      "delete from book_sheets where id = ? and status = 'call' and not exists (select 1 from book_notes where sheet = ?)",
    ).run(sheet, sheet);
  const pages = [...new Map(rings.map(n => [n.page, n.who])).entries()];
  for (const [page, who] of pages)
    if (
      db
        .prepare(
          `select 1 from book_pages p where p.id = ? and p.strokes = 0 and p.scraps = '[]' and p.texts = '[]'
            and not exists (select 1 from book_notes n where n.page = p.id)`,
        )
        .get(page)
    )
      deletePage(page, who);
  return rings.length;
}

// The sweep (every 5 minutes, startSweep): a call's page nobody wrote on, once its call is gone (nothing was said on it:
// call.ts handOver). Written on: the book's own ink or pictures on it, or a note (the board's, by the page's owner, p.who). Never a call's notes
// page, whose call sends and archives it (callnotes.ts).
const SETTLED_MS = 60_000;
export function sweep(now = Date.now()) {
  const before = new Date(now - SETTLED_MS).toISOString();
  const unwritten = db
    .prepare(
      `select p.id, p.who, p.call from book_pages p
        where p.kind = 'call' and p.notebook is null and p.strokes = 0 and p.scraps = '[]' and p.created < ?
          and not exists (select 1 from book_notes n where n.page = p.id and n.by = p.who)`,
    )
    .all(before) as { id: number; who: string; call: number | null }[];
  for (const p of unwritten) if (!agentOf(p.call)) deletePage(p.id, p.who);
}
// (and, once on the first start with it, the agent's kept rings: dropAgentInk. Here, at the start, not as this file
// loads: book.ts imports this file, so it loads before book.ts has run its migrations or defined deletePage's row.
export function startSweep() {
  once('2026-10-27-no-agent-ink', () => void dropAgentInk());
  return setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.error('Could not sweep the empty call pages:', err);
    }
  }, 5 * 60_000).unref();
}
