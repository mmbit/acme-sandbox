// A fix: an agent's answer that proposes a change (hq answer --fix "<the change>"), written beside its words or drawn
// (its ink or picture: the after, the board's note the before). It shows as a box to tick (shared/review/slip.js).
// Ticked, nothing happens yet: when the board sends the page, its note goes to the agent who answered, the fix in its
// brief to build (notebooksend.ts asNotes, booksheets.ts deliver), and the slip says it's being built. A fix is
// ticked only while its scrap waits on its page: after the send there's nobody to hand it to, and once built its tick
// stays.
import { db } from '../db.ts';
import { findAgent } from '../jobs.ts';
import type { Refused } from '../pagechecks.ts';
import type { Note } from './booknotes.ts';
import type { Slip } from './bookslips.ts';
import { groupOfNote, groupOn, rootOf, type Group } from '../notebookgroups.ts';

// The fixes ticked on a group's thread (the group and the replies under it, not deleted) and not handed on yet, in the
// order ticked
const tickedOn = (top: Group) =>
  db
    .prepare(
      `select * from book_slips where fix is not null and ticked is not null and built is null
      and grp in (select id from notebook_groups where (id = ? or parent = ?) and deleted is null) order by ticked, id`,
    )
    .all(top.id, top.id) as Slip[];

// Who a group sent goes to when a fix on it is ticked: the agent who proposed the first ticked (undefined: none)
export const fixerOf = (g: Group) => tickedOn(rootOf(g))[0]?.by;

// Whether the board may tick (or untick) a fix: only while its scrap is on its page, unsent (null: it may)
export function tickRefused(slip: Slip, ticked: boolean): Refused | null {
  if (slip.built !== null) return [409, 'this fix has gone to be built'];
  const g = groupOn(slip);
  if (ticked && g && rootOf(g).status !== 'open')
    return [409, 'this page has been sent: write under the fix to have it built'];
  return null;
}

// The fixes ticked on a note's group, when it's the board's scrap sent with its page (a reply under an answer goes on
// its own, its scrap still on the page)
function fixesFor(n: Note) {
  const g = groupOfNote(n.id);
  return g && g.parent === null ? { page: g.page, fixes: tickedOn(g) } : { page: 0, fixes: [] };
}
// Each note's text for the job it goes to, with the fixes the board ticked on its group: what to build
export function withFixes(notes: Note[], texts: string[]) {
  return texts.map((text, i) => {
    const { page, fixes } = fixesFor(notes[i]);
    return [text, ...fixes.map(f => fixLine(f, page))].join('\n');
  });
}
function fixLine(f: Slip, page: number) {
  const name = findAgent(f.by)?.name ?? f.by;
  const said = f.text ? ` (its answer: “${f.text}”)` : '';
  const drawn =
    f.ink || f.picture ? `; its drawing is on its slip under the note, which \`hq sketch ${page}\` shows` : '';
  return `The board ticked ${name}’s fix “${f.fix}”${said}${drawn}: build it, to review and live.`;
}
// The ticked fixes on these notes' groups handed to the job they went to: their slips say they're being built
export function fixesWent(notes: Note[], job: number) {
  for (const n of notes)
    for (const f of fixesFor(n).fixes) db.prepare('update book_slips set built = ? where id = ?').run(job, f.id);
}
