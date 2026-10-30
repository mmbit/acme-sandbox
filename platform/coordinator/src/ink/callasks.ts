// A call's notes page's asks (callnotes.ts): each scrap and promise the agent puts on it is an item on the call's list,
// tied to its group as the agent wrote it, for the call's follow-up to hand out. Asks follow the groups the board joins
// and lifts apart, and one it deletes is dropped.
import { db } from '../db.ts';
import { drop, reworded } from '../ledger.ts';
import { onJoined, onSplit, partsOf, type Group } from '../notebookgroups.ts';

// Each ask on the page (a scrap or a promise, its group) and its item on the call's list. A group the board joins others
// into holds their asks too, and one it lifts an ask's own lines or picture out into takes that ask. wrote: what the
// agent wrote for it ({ texts, pictures, words }: the typed lines, each by its own id and words, the picture files, the
// post-it's words); owner: its group's owner then. A line keeps its id through the board's edits, joins and splits, so
// an ask follows its own lines however the board retypes them
db.exec(`create table if not exists call_asks (grp integer not null, item integer not null, wrote text not null,
  owner text, primary key (grp, item))`);
type Ask = { grp: number; item: number; wrote: string; owner: string | null };
type Writing = { texts: Line[]; pictures: string[]; words: string };
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
// A group's words and pictures, wherever they are on the page
function writingOf(g: Group): Writing {
  const { texts, pictures } = partsOf(g);
  return {
    texts: (texts as Line[]).map(t => ({ id: t.id, text: t.text })),
    pictures: pictures.map(c => c.file),
    words: g.words,
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
// promise for the board: callnotes.ts noted), as it put it there: no ask, so the agent may change its words (oneNote)
db.exec('create table if not exists call_marks (grp integer primary key, wrote text not null)');
export const marked = (grp: number) =>
  void db
    .prepare('insert or replace into call_marks (grp, wrote) values (?, ?)')
    .run(grp, JSON.stringify(writingOf(groupRow(grp))));
const groupRow = (id: number) => db.prepare('select * from notebook_groups where id = ?').get(id) as Group;

// An ask the board took off the call's page isn't handed out, archived page or not: at the call's end its item is
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
