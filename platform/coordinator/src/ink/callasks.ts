// A call's notes page's asks (callnotes.ts): each scrap and promise the agent puts on it is an item on the call's list,
// tied to its group as the agent wrote it, and the page as the board leaves it is what goes. Asks follow the groups the
// board joins and lifts apart, one it deletes is dropped, one it changes goes as its note, and each sheet the page goes
// as is the work of the asks it carries (ledger.ts given).
import { db } from '../db.ts';
import type { Page } from './book.ts';
import { drop, given, handedOut, reworded } from '../ledger.ts';
import { onJoined, onSplit, partsOf, type Group } from '../notebookgroups.ts';
import { onDelivered } from './booksheets.ts';
import type { Stroke } from '../pagechecks.ts';

// Each ask on the page (a scrap or a promise, its group) and its item on the call's list. A group the board joins others
// into holds their asks too, and one it lifts an ask's own lines or picture out into takes that ask. wrote: what the
// agent wrote for it ({ texts, pictures, words, ink }: the typed lines, each by its own id and words, the picture files,
// the post-it's words, the strokes it drew), which it is left on the page as
// (leaveAsSent); owner: its group's owner then. A line keeps its id through the
// board's edits, joins and splits, so an ask follows its own lines however the board retypes them
db.exec(`create table if not exists call_asks (grp integer not null, item integer not null, wrote text not null,
  owner text, primary key (grp, item))`);
type Ask = { grp: number; item: number; wrote: string; owner: string | null };
type Writing = { texts: Line[]; pictures: string[]; words: string; ink: Stroke[] };
type Line = { id?: string; text: string };
export function asked(grp: number, item: number) {
  const g = groupRow(grp);
  db.prepare('insert into call_asks (grp, item, wrote, owner) values (?, ?, ?, ?)').run(
    grp,
    item,
    JSON.stringify(writingOf(g)),
    g.owner,
  );
}
// A group's words, pictures and strokes, wherever they are on the page
function writingOf(g: Group): Writing {
  const { ink, texts, pictures } = partsOf(g);
  return {
    texts: (texts as Line[]).map(t => ({ id: t.id, text: t.text })),
    pictures: pictures.map(c => c.file),
    words: g.words,
    ink: ink as Stroke[],
  };
}
// The agent's own change of its note (callpage.ts): what it wrote is the group as it is now, for its ask or its mark (a
// promise for the board), and its ask's item's line the new words
export function rewrote(grp: number, what: string) {
  const wrote = JSON.stringify(writingOf(groupRow(grp)));
  db.prepare('update call_asks set wrote = ? where grp = ?').run(wrote, grp);
  db.prepare('update call_marks set wrote = ? where grp = ?').run(wrote, grp);
  for (const { item } of asksOf(grp)) reworded(item, what);
}
// Whether a group is one note of the agent's, every line of it that one's (its ask's or its mark's): not one the board
// joined others into or typed in, whose lines a change of words would take off the page (callpage.ts newWords)
export function oneNote(grp: number) {
  const mark = db.prepare('select wrote from call_marks where grp = ?').get(grp) as { wrote: string } | undefined;
  const wrote = [...asksOf(grp).map(a => a.wrote), ...(mark ? [mark.wrote] : [])];
  if (wrote.length !== 1) return false;
  const ids = (JSON.parse(wrote[0]) as Writing).texts.map(t => t.id);
  return writingOf(groupRow(grp)).texts.every(t => t.id !== undefined && ids.includes(t.id));
}
export const asksOf = (grp: number) =>
  db.prepare('select * from call_asks where grp = ? order by item').all(grp) as Ask[];

// What the agent drew on the page that asks for nothing (a shape, a pen line, a highlight: callpage.ts), or typed (a
// promise for the board: callnotes.ts noted), as it put it there: it stays on the page as sent, unless the board changed
// it
db.exec('create table if not exists call_marks (grp integer primary key, wrote text not null)');
export const marked = (grp: number) =>
  void db
    .prepare('insert or replace into call_marks (grp, wrote) values (?, ?)')
    .run(grp, JSON.stringify(writingOf(groupRow(grp))));
const groupRow = (id: number) => db.prepare('select * from notebook_groups where id = ?').get(id) as Group;

// An item whose ask is on a call's page that hasn't gone yet: the page takes it to its owner, or drops it if the board
// took it off (ledger.ts handOut). Not on a page the board archived: the call's end never sends that one
// (callnotes.ts ended).
export const going = (item: number) =>
  !!db
    .prepare(
      `select 1 from call_asks a join notebook_groups g on g.id = a.grp join book_pages p on p.id = g.page
        where a.item = ? and (g.status = 'open' and p.archived = 0 and p.send_at is null and p.notebook is not null
          or g.deleted is null and exists (select 1 from book_notes n join book_sheets s on s.id = n.sheet
            where n.id = g.note and s.status != 'sent'))`,
    )
    .get(item);
// A sheet of a call's page gone: each ask's item has the job it went as (handed out by the call itself), whose own work
// it is (ledger.ts given: a sheet carries several, so the job carries none), beside the board's notes or not
function delivered(sheet: number, job: number) {
  const items = (
    db
      .prepare(
        `select a.item from call_asks a join notebook_groups g on g.id = a.grp join book_notes n on n.id = g.note
        join call_items i on i.id = a.item where n.sheet = ? and i.status = 'open' and i.job is null`,
      )
      .all(sheet) as { item: number }[]
  ).map(a => a.item);
  // (more: the sheet's other notes, or a routing check's, which sorts others' notes too: routing.ts)
  const more = db
    .prepare(
      `select 1 from book_notes n join notebook_groups g on g.note = n.id where n.sheet = ? and not exists (select 1
        from call_asks a where a.grp = g.id and a.item in (select value from json_each(?)))
      union all select 1 from note_routes where job = ?`,
    )
    .get(sheet, JSON.stringify(items), job);
  for (const item of items) handedOut(item, job, null);
  given(items, job, !!more);
}

// An ask the board took off the call's page doesn't go, whether the page goes or the board archived it: its item is
// dropped, why for the board to read, and work the call queued for it that hasn't started is cancelled (ledger.ts drop):
// a job queued on the call (call.ts queuedOn), carrying it. One linked to work under way (any other job, queued off the
// call during it too, a card, a ref) stays as it was: that work isn't the ask's.
export function takenOff(call: number) {
  const off = db
    .prepare(
      `select a.item from call_asks a join notebook_groups g on g.id = a.grp join book_pages p on p.id = g.page
        join call_items i on i.id = a.item where p.kind = 'call' and p.call = $call and g.deleted is not null
        and i.status = 'open' and (i.job is null and i.request is null and i.ref is null
          or exists (select 1 from call_jobs q join jobs j on j.id = q.job where q.call = $call and q.job = i.job
            and j.item = i.id))`,
    )
    .all({ call }) as { item: number }[];
  for (const { item } of off) drop(item, "taken off the call's page", null);
}
// What the agent put on the page that goes no further, left on it as sent: asks that all reached their owners another
// way on the call (each item handed out to a job, linked to work under way, or corrected), its marks and its typed note
// that's no ask (a promise for the board), and the agent's own lines the board lifted out of an ask's note as they were.
// One the board changed (its ink, typed or struck words, post-it or pictures) goes, as the board's note to that owner:
// an item with a job keeps it.
export function leaveAsSent(p: Page) {
  const open = db
    .prepare('select * from notebook_groups where page = ? and by != ? and status = ?')
    .all(p.id, p.who, 'open') as Group[];
  for (const g of open.filter(leftBehind))
    db.prepare("update notebook_groups set status = 'sent' where id = ?").run(g.id);
}
function leftBehind(g: Group) {
  const asks = db
    .prepare(
      `select a.wrote, i.status, i.job, i.request, i.ref from call_asks a join call_items i on i.id = a.item
        where a.grp = ?`,
    )
    .all(g.id) as { wrote: string; status: string; job: number | null; request: number | null; ref: string | null }[];
  if (!asks.length) {
    const mark = db.prepare('select wrote from call_marks where grp = ?').get(g.id) as { wrote: string } | undefined;
    if (mark) return sameWriting(writingOf(g), JSON.parse(mark.wrote) as Writing);
    return ownLines(g);
  }
  if (asks.some(a => a.status === 'open' && a.job === null && a.request === null && a.ref === null)) return false;
  const wrote = asks.map(a => JSON.parse(a.wrote) as Writing);
  const asWritten = {
    texts: wrote.flatMap(w => w.texts),
    pictures: wrote.flatMap(w => w.pictures),
    words: wrote.map(w => w.words).find(Boolean) ?? '',
  };
  return sameWriting(writingOf(g), { ...asWritten, ink: wrote.flatMap(w => w.ink) });
}
// Whether a group of no ask holds only typed lines the agent wrote on the page, each as it wrote it (lifted out of its
// ask's note): no line the board typed or retyped, no ink, picture or post-it words
function ownLines(g: Group) {
  const w = writingOf(g),
    wrote = (
      db
        .prepare(
          `select a.wrote from call_asks a join notebook_groups o on o.id = a.grp where o.page = $page
            union all select m.wrote from call_marks m join notebook_groups o on o.id = m.grp where o.page = $page`,
        )
        .all({ page: g.page }) as { wrote: string }[]
    ).flatMap(r => (JSON.parse(r.wrote) as Writing).texts.map(lineKey));
  return !w.ink.length && !w.pictures.length && !w.words && w.texts.every(t => t.id && wrote.includes(lineKey(t)));
}
// (the same words, pictures and strokes, all moved alike: moved, or the board's stroke wiped off again, is unchanged;
// one stroke for another is the board's)
const sameWriting = (a: Writing, b: Writing) =>
  a.words === b.words &&
  same(a.texts.map(lineKey), b.texts.map(lineKey)) &&
  same(a.pictures, b.pictures) &&
  sameInk(a.ink, b.ink);
function sameInk(a: Stroke[], b: Stroke[]) {
  const [as, bs] = [a, b].map(ink => [...ink].sort((s, t) => strokeKey(s).localeCompare(strokeKey(t))));
  const shift = (i: number) => [0, 1].map(k => bs[i].points[0][k] - as[i].points[0][k]);
  return (
    as.length === bs.length &&
    as.every((s, i) => strokeKey(s) === strokeKey(bs[i]) && shift(i).every((d, k) => Math.abs(d - shift(0)[k]) < SHIFT))
  );
}
// (a stroke as drawn wherever it is: its points from its first, to a hundredth of a px as the page keeps typed boxes)
const strokeKey = (s: Stroke) => {
  const [x0, y0] = s.points[0];
  const at = (n: number) => Math.round(n * 100) / 100;
  return JSON.stringify([
    s.color,
    s.size,
    s.alpha ?? null,
    s.fill ?? false,
    s.points.map(([x, y, ...r]) => [at(x - x0), at(y - y0), ...r]),
  ]);
};
const SHIFT = 0.01; // (px: what a move adds is off by less)
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const lineKey = (t: Line) => JSON.stringify([t.id ?? null, t.text]);

// (each sheet the page goes as gives its asks' items their job)
onDelivered(delivered);
// (the asks of groups the board joins go with the group they joined into)
onJoined((into, away) =>
  db
    .prepare('update call_asks set grp = ? where grp in (select value from json_each(?))')
    .run(into, JSON.stringify(away)),
);
// (an ask goes with its own typed lines, by their ids however the board retyped them, or its picture when the board
// lifts them out of a group, and each side is its asks' owner's)
onSplit((from, lifted) => {
  const asks = asksOf(from);
  const [left, out] = [writingOf(groupRow(from)), writingOf(groupRow(lifted))];
  const moved = asks.filter(a => sharedWith(a, out) > sharedWith(a, left));
  if (!moved.length) return;
  for (const a of moved)
    db.prepare('update call_asks set grp = ? where grp = ? and item = ?').run(lifted, from, a.item);
  const stayed = asks.find(a => !moved.includes(a));
  db.prepare('update notebook_groups set owner = ? where id = ?').run(moved[0].owner, lifted);
  if (stayed) db.prepare('update notebook_groups set owner = ? where id = ?').run(stayed.owner, from);
});
// How many of an ask's own lines (by id) and pictures a group holds
function sharedWith(a: Ask, w: Writing) {
  const wrote = JSON.parse(a.wrote) as Writing,
    ids = w.texts.map(t => t.id).filter(Boolean);
  return wrote.texts.filter(t => ids.includes(t.id)).length + wrote.pictures.filter(f => w.pictures.includes(f)).length;
}
