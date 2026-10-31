// A call's notes page's asks (callnotes.ts): each scrap and promise the agent puts on it is an item on the call's list,
// tied to its group as the agent wrote it, for the call's follow-up to hand out. Asks follow what the board lifts
// apart, and one it deletes is dropped.
import { db } from '../db.ts';
import { drop, reworded } from '../ledger.ts';
import { onSplit, partsOf, type Group } from '../notebookgroups.ts';

// Each ask on the page (a scrap or a promise, its group) and its item on the call's list. A group the board lifts an
// ask's own lines or picture out into takes that ask. wrote: what the agent
// wrote for it ({ texts, pictures, words }: the typed lines, each by its own id and words, the picture files, the
// post-it's words); owner: its group's owner then. A line keeps its id through the board's edits and splits, so an ask
// follows its own lines however the board retypes them. An ask's typed line carries what: the item's line it says; and
// posts are the post-it's words the agent gave it, each with its item's line then
db.exec(`create table if not exists call_asks (grp integer not null, item integer not null, wrote text not null,
  owner text, primary key (grp, item))`);
type Ask = { grp: number; item: number; wrote: string; owner: string | null };
type Writing = { texts: Line[]; pictures: string[]; words: string; posts?: Post[] };
type Line = { id?: string; text: string; what?: string };
type Post = { words: string; what: string };
// An ask the agent made: its group as it wrote it, each typed line and the post-it's words saying its item's line
export function asked(grp: number, item: { id: number; what: string }) {
  const g = groupRow(grp),
    w = writingOf(g);
  db.prepare('insert into call_asks (grp, item, wrote, owner) values (?, ?, ?, ?)').run(
    grp,
    item.id,
    JSON.stringify({
      ...w,
      texts: w.texts.map(t => ({ ...t, what: item.what })),
      posts: [{ words: w.words, what: item.what }],
    }),
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
// promise for the board), still with the lines it wrote before, which the board's Undo of the change brings back; and
// its ask's item's line the new words, which its new lines and its post-it's words now say
export function rewrote(grp: number, what: string) {
  const now = writingOf(groupRow(grp));
  const withBefore = (before: string, what?: string) => {
    const was = JSON.parse(before) as Writing,
      earlier = was.texts.filter(t => !now.texts.some(n => n.id === t.id));
    if (what === undefined) return JSON.stringify({ ...now, texts: [...earlier, ...now.texts] });
    const texts = now.texts.map(t => ({ ...t, what }));
    const posts = [...(was.posts ?? []), { words: now.words, what }];
    return JSON.stringify({ ...now, texts: [...earlier, ...texts], posts });
  };
  for (const a of asksOf(grp)) {
    db.prepare('update call_asks set wrote = ? where grp = ? and item = ?').run(withBefore(a.wrote, what), grp, a.item);
    reworded(a.item, what);
  }
  const mark = markOf(grp);
  if (mark) db.prepare('update call_marks set wrote = ? where grp = ?').run(withBefore(mark.wrote), grp);
}
// Whether a group is one note of the agent's, every line of it that one's (its ask's or its mark's): not one the board
// typed in, whose lines a change of words would take off the page (callpage.ts newWords)
export function oneNote(grp: number) {
  const mark = markOf(grp);
  const wrote = [...asksOf(grp).map(a => a.wrote), ...(mark ? [mark.wrote] : [])];
  if (wrote.length !== 1) return false;
  const ids = (JSON.parse(wrote[0]) as Writing).texts.map(t => t.id);
  return writingOf(groupRow(grp)).texts.every(t => t.id !== undefined && ids.includes(t.id));
}
export const asksOf = (grp: number) =>
  db.prepare('select * from call_asks where grp = ? order by item').all(grp) as Ask[];
const markOf = (grp: number) =>
  db.prepare('select wrote from call_marks where grp = ?').get(grp) as { wrote: string } | undefined;

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
// At the call's end each ask's item's line is what its note says then, so the board's Undo of the agent's change of
// its words takes the line back too: a scrap's, the line the agent gave with its post-it's words (none for words the
// board wrote there), or the item's line of the newest of the ask's typed lines the note still holds
export function saidAtEnd(call: number) {
  const asks = db
    .prepare(
      `select a.item, a.wrote, g.kind, g.words, g.texts from call_asks a join notebook_groups g on g.id = a.grp
        join book_pages p on p.id = g.page where p.kind = 'call' and p.call = ? and g.deleted is null`,
    )
    .all(call) as (Pick<Ask, 'item' | 'wrote'> & Pick<Group, 'kind' | 'words' | 'texts'>)[];
  for (const a of asks) {
    const wrote = JSON.parse(a.wrote) as Writing,
      ids = (JSON.parse(a.texts) as Line[]).map(t => t.id);
    const what =
      a.kind === 'scrap'
        ? wrote.posts?.findLast(p => p.words === a.words)?.what
        : wrote.texts.findLast(t => ids.includes(t.id))?.what;
    if (what) reworded(a.item, what);
  }
}
// (an ask goes with its own typed lines, by their ids however the board retyped them, or its picture when the board
// lifts them out of a group, and each side is its asks' owner's. A promise for the board goes with its lines the same
// way, and a post-it is the agent's words: each side of one is a note while it holds an ask's or the promise's lines,
// and plain typed words once it holds only the board's.)
onSplit((from, lifted) => {
  const asks = asksOf(from),
    mark = markOf(from),
    wasNote = groupRow(from).kind === 'note' && (asks.length > 0 || !!mark);
  const [left, out] = [writingOf(groupRow(from)), writingOf(groupRow(lifted))];
  const moved = asks.filter(a => sharedWith(a, out) > sharedWith(a, left));
  for (const a of moved)
    db.prepare('update call_asks set grp = ? where grp = ? and item = ?').run(lifted, from, a.item);
  const markMoved = !!mark && sharedWith(mark, out) > sharedWith(mark, left);
  if (markMoved) db.prepare('update call_marks set grp = ? where grp = ?').run(lifted, from);
  if (wasNote) {
    const fromHoldsAgents = moved.length < asks.length || (!!mark && !markMoved),
      liftedHoldsAgents = moved.length > 0 || markMoved;
    db.prepare('update notebook_groups set kind = ? where id = ?').run(fromHoldsAgents ? 'note' : 'drawing', from);
    db.prepare('update notebook_groups set kind = ? where id = ?').run(liftedHoldsAgents ? 'note' : 'drawing', lifted);
  }
  if (!moved.length) return;
  const stayed = asks.find(a => !moved.includes(a));
  db.prepare('update notebook_groups set owner = ? where id = ?').run(moved[0].owner, lifted);
  if (stayed) db.prepare('update notebook_groups set owner = ? where id = ?').run(stayed.owner, from);
});
// How many of an ask's (or a mark's) own lines (by id) and pictures a group holds
function sharedWith(a: { wrote: string }, w: Writing) {
  const wrote = JSON.parse(a.wrote) as Writing,
    ids = w.texts.map(t => t.id).filter(Boolean);
  return wrote.texts.filter(t => ids.includes(t.id)).length + wrote.pictures.filter(f => w.pictures.includes(f)).length;
}
