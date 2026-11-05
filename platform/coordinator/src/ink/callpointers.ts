// Pointer ink on a live call's notes page: what the board (or its guest) draws there on an artifact of the call's
// agent, one of its scraps or versions, or on a prototype from another screen, points while it talks; it's no note of
// its own. It reaches the call's agent as a mark once the drawing rests (callguests.ts markForVoice, HQ's calldraw.js
// relayMarks), never a judge or a run of its own (bookjudge.ts leaves a call's page be), and once the agent's turn on it
// is done it goes (clear, from the voice line): the agent keeps what it settled in its own notes. What the board draws
// on the page beside them is its own and stays.
//   - On the agent's scrap: the strokes drawn on it by someone else are kept here (ink), and only those go.
//   - A reply on one of its versions (notebooksend.ts replyTo), and a mark on a prototype from a screen that isn't the
//     call's (callprototypes.ts markOnCall), are pointer ink whole (whole): the group goes.
import { db } from '../db.ts';
import { pageRow } from '../notebook.ts';
import { partsOf, putAside, row, write, type Group } from '../notebookgroups.ts';
import type { Refused } from '../pagechecks.ts';

db.exec(`create table if not exists call_pointers (grp integer primary key, call integer not null, by text not null,
  ink text not null default '[]', whole integer not null default 0)`);
type Pointer = { grp: number; call: number; by: string; ink: string; whole: number };

// The live call whose notes page `page` is, with its agent (undefined: none, or the call has ended)
export const liveOn = (page: number) =>
  db
    .prepare(
      `select c.id, c.agent from book_pages p join calls c on c.id = p.call
        where p.id = ? and p.kind = 'call' and c.status = 'live'`,
    )
    .get(page) as { id: number; agent: string } | undefined;

// A unit of the agent's on a live call's page drawn on by someone else (notebookgroups.ts editGroup, before it's
// written): the strokes it adds kept as pointer ink
export function drawnOn(g: Group, by: string, ink: unknown[]) {
  const live = g.parent === null ? liveOn(g.page) : undefined;
  if (!live || g.by !== live.agent || by === g.by) return;
  const had = new Set(partsOf(g).ink.map(s => JSON.stringify(s))),
    kept = pointerOf(g.id);
  const added = ink.map(s => JSON.stringify(s)).filter(s => !had.has(s));
  if (!added.length) return;
  const pointing = [...(kept ? (JSON.parse(kept.ink) as string[]) : []), ...added];
  db.prepare(
    `insert into call_pointers (grp, call, by, ink) values (?, ?, ?, ?)
      on conflict(grp) do update set by = excluded.by, ink = excluded.ink`,
  ).run(g.id, live.id, by, JSON.stringify(pointing));
}
// A group that's pointer ink whole, on a live call's page (false: the page isn't one)
export function pointedWhole(g: Group) {
  const live = liveOn(g.page);
  if (!live) return false;
  db.prepare('insert or replace into call_pointers (grp, call, by, whole) values (?, ?, ?, 1)').run(
    g.id,
    live.id,
    g.by,
  );
  return true;
}
export const pointerOf = (grp: number) =>
  db.prepare('select * from call_pointers where grp = ?').get(grp) as Pointer | undefined;

// POST /api/voice/pointed { id, call, updated }: the agent's turn on a pointer it heard as `updated` is done, so its ink
// goes; drawn on since, it stays and comes to the agent again. 404: no pointer of that call's.
export function clear(b: any): { cleared: boolean } | Refused | 404 {
  const p = pointerOf(Number(b?.id)),
    g = p && row(p.grp);
  if (!p || !g || p.call !== Number(b?.call)) return 404;
  if (g.deleted !== null) return forget(g.id);
  if (typeof b.updated !== 'string') return [400, 'updated: the mark as it was heard'];
  if (g.updated !== b.updated) return { cleared: false };
  const page = pageRow(g.page, null);
  if (!page) return forget(g.id);
  if (p.whole) putAside(g, page);
  else {
    const pointing = new Set(JSON.parse(p.ink) as string[]);
    const parts = partsOf(g);
    write(g.id, { ...parts, ink: parts.ink.filter(s => !pointing.has(JSON.stringify(s))) }, {});
  }
  return forget(g.id);
}
const forget = (grp: number) => {
  db.prepare('delete from call_pointers where grp = ?').run(grp);
  return { cleared: true };
};
