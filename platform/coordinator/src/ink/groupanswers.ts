// A notebook group's answers as HQ reads them with the group (notebookgroups.ts groupOf): the slips on the notes it and
// its replies went as, the answers made on it before or after its page was sent, each once; the answer still coming on
// it or a reply of its (the writing placeholder); its try (booktry.ts), whose versions are among its answers and drawn
// under it (bookversions.js), or null; and the agents' desk-phone cards on those notes (bookasks.ts).
import { db } from '../db.ts';
import { findAgent, jobAgent } from '../jobs.ts';
import { ceo } from '../company.ts';
import { answersOnGroups, comingOf, going, slipsOf, waitingOf, type Listed } from './bookslips.ts';
import { asksBy, asksOn } from './bookasks.ts';
import type { Group } from '../notebookgroups.ts';

// What HQ reads of a group with its answers: its own parts (head), its owner and the
// agent's name, and its children, the answers and the board's replies under them, in the order they came
export function readOf<H extends object, A extends { created: string }, R extends { created: string }>(
  head: H,
  owner: string | null,
  answers: A[],
  replies: R[],
) {
  return {
    ...head,
    owner,
    owner_name: owner ? (findAgent(owner)?.name ?? owner) : null,
    children: [
      ...answers.map(a => ({ kind: 'answer' as const, ...a })),
      ...replies.map(r => ({ ...r, kind: 'reply' as const })),
    ].sort((a, b) => a.created.localeCompare(b.created)),
  };
}

export function answersOf(g: Group, replies: Group[], listed: Listed) {
  const notes = [g, ...replies].flatMap(x => (x.note ? [x.note] : [])),
    onNotes = notes.flatMap(n => slipsOf(n, listed));
  const onGroups = answersOnGroups(
    [g, ...replies].map(x => x.id),
    listed,
  ).filter(a => !onNotes.some(n => n.id === a.id));
  const top = g.parent === null,
    asking = top ? [g, ...replies] : [];
  return {
    answers: [...onNotes, ...onGroups],
    // (an answer coming on the note or a reply before why an ended ask brought none)
    waiting: asking.map(comingOf).find(w => w) ?? asking.map(waitingOf).find(w => w) ?? null,
    try: top ? tryOf(g, [...onNotes, ...onGroups]) : null,
    // (and the card it is, an agent's design ask on an Asks page: askpages.ts)
    asks: [...(g.request && top ? asksBy(g.request) : []), ...notes.flatMap(asksOn)],
  };
}
// A group's try (booktry.ts), as its versions block shows it under the group: coming while its run is queued or going
// (a frame of pencil dots for each version said and not made yet), made once it ended with versions, and empty once it
// ended with none, saying why in plain words. So a try never shows a count of versions that don't exist. null: never
// tried.
type Tried = Group & { tried?: number | null };
export function tryOf(g: Tried, answers: { style: string }[]) {
  if (!g.tried) return null;
  const job = db.prepare('select status, result from jobs where id = ?').get(g.tried) as
    { status: string; result: string | null } | undefined;
  const by = jobAgent(g.tried) ?? g.owner ?? ceo(),
    name = findAgent(by)?.name ?? by;
  const made = answers.filter(a => a.style === 'version').length;
  const state = going(g.tried) ? 'coming' : made ? 'made' : 'empty';
  return { state, expect: g.expect, by, name, reason: state === 'empty' ? endedEmpty(name, job) : null };
}
// Why a try that ended has no version, as the board reads it in the versions' place: the run's own last line when it
// ended well (the brief asks it to say why it made none)
function endedEmpty(name: string, job?: { status: string; result: string | null }) {
  if (job?.status === 'stopped') return `${name}'s try was stopped before it made a version.`;
  const said = job?.status === 'done' && job.result?.trim().split('\n').at(-1)?.trim();
  if (said) return `${name} made no version: ${said}`;
  return `${name}'s try ended without a version. Write on the scrap to ask again.`;
}
