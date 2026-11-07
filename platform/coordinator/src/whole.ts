// A whole milestone (a project) or deliverable (a thread) going live, as a card's hold (later.ts), a pause's --until
// (pauses.ts) and a job's --when deployed: (wakes.ts) wait for it: every deliverable of it open now or filed later, but
// those a pause of their own keeps out of a milestone. It's live once nothing in it is open and its last merge is
// deployed.
// Its SQL builders are function declarations: agreements.ts builds its SQL from wholeOpen as it loads, which the import
// cycle through jobs.ts can reach before this module has run.
import { db, workBranch } from './db.ts';
import { pauseHolds } from './jobs.ts';
import { deployed } from './wakes.ts';

// A milestone's or deliverable's name as --until and --when deployed: take it
export const WHOLE_NAME = /^[a-z][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?$/i;

// One piece's work, not a whole: a deployed: wake's '<job>' or 'pr:<n>'
export const isPiece = (work: string) => /^(pr:)?\d+$/.test(work);
// A wake on a whole milestone or deliverable live, not on one piece's work deployed (wakes.ts, queuedjob.ts)
export const onWhole = (w: { kind: string; arg: string }) => w.kind === 'deployed' && !isPiece(w.arg);
// Whether a whole's id is a deliverable's ('<project>/<slug>'), not a milestone's
export const ofDeliverable = (id: string) => id.includes('/');

// The id of the milestone or deliverable named (a moved deliverable by its old id too), or null for one HQ doesn't have
export function wholeId(named: string) {
  const found = ofDeliverable(named)
    ? db
        .prepare('select id from threads where id = coalesce((select id from thread_aliases where old = ?1), ?1)')
        .get(named)
    : db.prepare('select id from projects where id = ?').get(named);
  return (found as { id: string } | undefined)?.id ?? null;
}
export const noWhole = (named: string) =>
  `there's no milestone (project) or deliverable ${named}: hq projects lists them`;

// Whether a whole is live. `except`: the deliverable of the job that waits for it, left out, as that job would wait for
// itself.
export function wholeLive(id: string, except: string | null = null) {
  const params = { id, except };
  if (db.prepare(`select 1 from threads t where ${openIn('t', '$id', '$except')}`).get(params)) return false;
  const counted = `${inWhole('t', '$id')} and t.id is not $except and not ${keptOut('t', '$id')}`;
  const last = db
    .prepare(
      `select p.number from prs p where p.status = 'merged' and p.branch in (select ${workBranch('j')} from jobs j
      join threads t on t.id = j.thread where j.kind = 'work' and ${counted})
      order by p.merged_at desc limit 1`,
    )
    .get(params) as { number: number } | undefined;
  return !last || deployed(`pr:${last.number}`) !== null;
}

// Whether a whole (`whole`, an SQL expression for its id) has a deliverable open in it, as SQL: what holds it short of
// live but its last deploy (agreements.ts)
export function wholeOpen(whole: string) {
  return `exists (select 1 from threads t where ${openIn('t', whole)})`;
}
// The work jobs in a whole's open deliverables (`whole`, an SQL expression for its id; `except` as openIn's), as a
// select of their ids: what a pause until it waits for in the plan (pauses.ts, pausewake.ts, queuedjob.ts)
export function wholeWork(whole: string, except = 'null') {
  return `select j.id from threads t join jobs j on j.thread = t.id where j.kind = 'work' and ${openIn('t', whole, except)}`;
}

// A deliverable (`t`, its row's alias) the whole `whole` (an SQL expression for its id) counts as open: open, in it, and
// neither kept out nor `except` (an SQL expression: the deliverable of what waits for the whole, as wholeLive's). What
// holds it short of live, and what a pause until it waits for in the plan (jobs.ts dependencyEdges).
export function openIn(t: string, whole: string, except = 'null') {
  return `(${inWhole(t, whole)} and ${t}.status = 'open' and ${t}.id is not ${except} and not ${keptOut(t, whole)})`;
}
// A thread (`t`) of the whole `whole`: the deliverable itself (moved, by its old id), or one of the milestone's
function inWhole(t: string, whole: string) {
  return `(${t}.id = coalesce((select id from thread_aliases where old = ${whole}), ${whole}) or ${t}.project = ${whole})`;
}
// Whether a whole (its id) takes in a thread (its id), as inWhole does in SQL. hq job reads it on a whole its --when just
// resolved (wakes.ts readWhen) and the thread it names now, so neither is an old id (threadrelease.ts).
export const covers = (whole: string, thread: string) => whole === thread || whole === thread.split('/')[0];
// A milestone's deliverable (`t`) that a pause of its own keeps out of it
function keptOut(t: string, whole: string) {
  return `(${t}.project = ${whole} and ${ownPause(t)})`;
}
// Whether a pause of its own holds deliverable `t` (its row's alias), which keeps it out of its whole milestone: out of
// the milestone's urgency (a pause holds urgent work), of a card held on it, and of what a pause beside it leaves to go
// on (urgency.ts, later.ts, pauses.ts).
export function ownPause(t: string) {
  return `exists (select 1 from pauses own where own.thread = ${t}.id and ${pauseHolds('own')})`;
}
// A milestone's open deliverables, each with whether its own pause keeps it out (ownPause)
export const openDeliverables = (project: string) =>
  db
    .prepare(
      `select t.id, t.name, ${ownPause('t')} kept from threads t where t.project = ? and t.status = 'open' order by t.id`,
    )
    .all(project) as { id: string; name: string; kept: number }[];

// A whole in a few words: "Ink's whole milestone", or the deliverable "Tips"
export function wholeName(id: string) {
  if (ofDeliverable(id)) {
    const thread = db.prepare(`select t.name from threads t where ${inWhole('t', '?1')}`).get(id) as { name: string };
    return `the deliverable "${thread.name}"`;
  }
  const { name } = db.prepare('select name from projects where id = ?').get(id) as { name: string };
  return `${name}'s whole milestone`;
}
// A whole in words, a milestone's with what it covers and keeps out now (`except` as wholeLive's)
export function wholeWords(id: string, except: string | null = null) {
  if (ofDeliverable(id)) return wholeName(id);
  const all = openDeliverables(id);
  const own = all.some(t => t.id === except);
  const open = all.filter(t => t.id !== except);
  const covered = open.filter(t => !t.kept).length;
  const kept = open.filter(t => t.kept).map(t => `"${t.name}"`);
  return `${wholeName(id)} (${covered} open deliverable${covered === 1 ? '' : 's'} and any filed in it later${
    kept.length ? `, not ${kept.join(', ')}, kept out by ${kept.length === 1 ? 'its' : 'their'} own pause` : ''
  }${own ? ", not this job's own" : ''})`;
}
