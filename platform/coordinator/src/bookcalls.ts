// A call's page in the book (book.ts, kind 'call'): what the board and the call's agent drew on a call, each in their
// own ink, numbered as a sheet's notes are. HQ makes it at the call's first mark, so a call nobody drew on leaves none.
//   - Its notes sit on a sheet of their own (status 'call'), which is never sent: the agent on the call heard each one
//     as the Pencil lifted (the voice line fetches it here, forVoice, and counts its picture against the call's).
//   - The agent's ink is a note by the agent (by), drawn on the board's page by HQ as the line asked; it never goes
//     back to the agent, who drew it.
//   - Kept until the board throws the page away in one tap (book.ts deletePage takes its notes with it), with the
//     call's summary on top once the call's follow-up has written it (book.ts summary).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { db } from './db.ts';
import { DIR } from './pagescraps.ts';
import type { Page } from './book.ts';
import type { Refused } from './pagechecks.ts';

const agentOf = (call: number | null) =>
  (db.prepare('select agent from calls where id = ?').get(call) as { agent: string } | undefined)?.agent;

// The sheet a call's page's notes go on (made with its first note), and whom a new note is by: the board's book's
// own (who), or the call's agent
export function onCall(page: Page, by: unknown, who: string) {
  const agent = agentOf(page.call);
  if (!agent) return [404, "this call's page has no call any more"] as Refused;
  if (by !== undefined && by !== agent)
    return [400, `by is the call's agent (${agent}), or left out for the book's own`] as Refused;
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
  return { sheet, by: by === undefined ? who : agent };
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
// (an anchor's address as HQ's own pages name it: its path and query)
function pathOf(url: unknown) {
  const u = new URL(String(url), 'https://x');
  return u.pathname + u.search;
}
