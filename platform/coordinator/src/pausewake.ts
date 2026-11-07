// What wakes a pause's owner (pauses.ts): once its time has come, its --until jobs have all merged or ended and the
// milestones and deliverables it waits for are live (whole.ts), HQ queues them a job to judge it, and the pause stays
// on. They lift it, take the results to the board, or keep it on for what's still missing; nothing but a resume lifts
// it. A pause waiting for the board's decision is lifted by the board's
// answer.
// (its messages say deliverable, the board's word for a thread)
import { db, inOneStep, mergePending } from './db.ts';
import { ceo, projects } from './company.ts';
import { deliveredWords } from './followthroughwords.ts';
import { publish } from './events.ts';
import * as jobs from './jobs.ts';
import * as redraws from './redraws.ts';
import { made, madeCode } from './made.ts';
import { STANDING } from './jobcodes.ts';
import { targetOf, untilsOf, wholesOf, type Row } from './pausewords.ts';
import { isPiece, noWhole, openIn, wholeId, wholeLive, wholeName, wholeWork } from './whole.ts';
import { parse as parseTime } from './windows.ts';
import { readDeploys } from './wakes.ts';

// (the most of each waited-on job's report a wake's brief carries: the rest is in hq history)
const REPORT_MAX = 2_000;

// Every minute: a pause waiting for a decision the board answered or released has resumed (the claim already lets its
// work go): recorded, and said on HQ's feed. A pause whose time has come, whose --until jobs have all settled and whose
// wholes are all live at once wakes its owner (wake), and stays on.
export function sweep(t = Date.now()) {
  const decided = db
    .prepare(
      redraws.query(`select p.* from pauses p where p.resumed is null and p.decision is not null
      and not (${jobs.pauseHolds('p')})`),
    )
    .all() as Row[];
  for (const p of decided) {
    db.prepare('update pauses set resumed = ? where id = ?').run(new Date(t).toISOString(), p.id);
    publish({ type: 'log', agent: p.by, text: `${targetOf(p)} resumed: the board decided` });
  }
  const met = db
    .prepare(
      redraws.query(`select p.* from pauses p where ${jobs.pauseHolds('p')} and p.woken is null
      and (p.until_time is not null or exists (select 1 from pause_until u where u.pause = p.id)
        or exists (select 1 from pause_until_whole w where w.pause = p.id))
      and (p.until_time is null or p.until_time <= ?) and not ${unsettled('p')}`),
    )
    .all(new Date(t).toISOString()) as Row[];
  const wholes = wholesOf(met.map(p => p.id));
  if (wholes.size) readDeploys();
  for (const p of met) if ((wholes.get(p.id) ?? []).every(w => wholeLive(w))) wake(p, t);
}
// Whether a pause (`p`) still waits for one of its --until jobs: not merged, not on main by a closed pull request, and
// that job (or what replaced it) still able to merge. Wrap statements using this in redraws.query().
const unsettled = (p: string) => `exists (select 1 from pause_until u where u.pause = ${p}.id and u.on_main = 0
    and not exists (select 1 from jobs prior where prior.id = u.job and ${jobs.merged('prior')})
    and exists (select 1 from jobs cur where cur.id = ${redraws.current('u.job')} and ${mergePending('cur')}))`;

// A job for the pause's owner (the CEO for one carrying the board's item), now that what it waited for is met: with the
// pause's why, what was met and how that work ended, so they judge what's next. Never held by a pause (jobs.ts
// pauseLets) nor the company's (its allow list, as alarms.ts), and as soon as it can, which pacing lets through, on a
// one-task thread where projects.yaml's made names the alarms' project. The pause stays on.
function wake(p: Row, t: number) {
  const owner = p.item != null ? ceo() : p.by;
  const name = jobs.pauseName(targetOf(p));
  inOneStep(() => {
    const { id } = jobs.createJob({
      agent: owner,
      code: madeCode('alarms', 'hq', STANDING.pauseMet),
      title: `Judge the pause on ${name}: what it waited for is met`,
      prompt: wakeBrief(p, t, owner),
      effort: 'medium',
    });
    made('alarms', 'hq', { id }, projects().made.alarms?.hq ? { asap: t } : undefined);
    db.prepare(
      "update settings set value = json_set(value, '$.allow', json_insert(coalesce(json_extract(value, '$.allow'), json('[]')), '$[#]', ?)) where key = 'company.paused'",
    ).run(id);
    db.prepare('update pauses set woken = ? where id = ?').run(id, p.id);
    db.prepare('insert into pause_wakes (job, pause) values (?, ?)').run(id, p.id);
  });
  publish({
    type: 'log',
    agent: owner,
    text: `${name} stays paused: what it waited for is met, and ${owner} judges what's next`,
  });
}

// What the woken owner reads: the pause, what was met, each job it waited for as it ended (its report, and whether its
// work is on main), what counts as delivered (company.ts deliveredWords) and the three ways on. A report marked before
// as holding a customer's details stays with its job, as its reference: a brief is a new record, whoever reads it.
function wakeBrief(p: Row, t: number, owner: string) {
  const name = jobs.pauseName(targetOf(p));
  const kind = p.thread ? 'deliverable' : 'project';
  const until = untilsOf([p.id]).get(p.id) ?? [];
  const reports = new Map(
    (
      db
        .prepare('select id, result, customers from jobs where id in (select value from json_each(?))')
        .all(JSON.stringify(until.map(u => u.id))) as { id: number; result: string | null; customers: number }[]
    ).map(r => [r.id, r]),
  );
  const at = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  const jobsMet = until.map(u => {
    const r = reports.get(u.id)!;
    const report = (r.result ?? '').trim();
    const cut = report.length > REPORT_MAX ? `${report.slice(0, REPORT_MAX)}… (the rest: hq history)` : report;
    const said = r.customers ? `(${jobs.REPORT_LEFT_OUT})` : cut || 'none';
    return `- #${u.id} ${u.agent}: ${u.title}. It ended ${u.state}.\n  Its report: ${said}`;
  });
  const metParts = [
    ...(p.until_time ? [`its time came (${at(p.until_time)})`] : []),
    ...(wholesOf([p.id]).get(p.id) ?? []).map(id => `${wholeName(id)} is live`),
    ...(until.length ? [`every job it waited for has ended:\n${jobsMet.join('\n')}`] : []),
  ];
  const text = [
    `The pause on ${name} (paused by ${p.by}, ${at(p.at)}): ${p.why}`,
    p.item != null
      ? `It carries the board's call item #${p.item} (\`hq followthrough\` shows it in the board's words).`
      : '',
    `What it waited for is met: ${metParts.join(', and ')}${until.length ? '' : '.'}`,
    `The pause is still on, as of ${at(new Date(t).toISOString())}: nothing lifts it but a resume. Judge against what it was for, read in its why and the board's words, not against whether those jobs ended. Delivered means ${deliveredWords()} Then one of:`,
    `- It has what it waited for: lift it (\`hq ${kind} resume ${targetOf(p)}\`), and where the board waits for those results, take them to it (a card on the desk phone with what was found and your recommendation).`,
    `- What it waited for ended without what the hold needs (no results, a failure, a step still missing): queue what's missing and keep holding on it: \`hq ${kind} pause ${targetOf(p)} "why" --until <that job>\` keeps the pause on and wakes you again when that ends (\`--until <its project>\`: once its whole milestone is live, work filed there later too).`,
    `- Only the board can judge it: ${owner === ceo() ? '' : `ask the CEO (${ceo()}, \`hq say\`), who alone names a decision of the board's, to `}make the pause wait for its answer, which lifts it: ${BOARD_WAITS(targetOf(p))}.`,
    `Say in your report which you did and why.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return text;
}
// How a pause waits for the board (decisions.ts create, and the card that asks it): the woken owner's third way and the
// hourly check's (followthrough.ts)
export const BOARD_WAITS = (target: string) =>
  `\`hq decision "<what the board decides>" --blocks ${target}\` (it keeps the pause on, now on that decision), then its card, \`hq ask ... --decides <its id>\``;

// A pull request closed with every commit of its branch on main (review.ts close): its work in a pause's --until is
// on main, as it meets the waits on it. The next sweep wakes the pause's owner if nothing else is left.
export function landed(branch: string) {
  db.prepare(
    `update pause_until set on_main = 1 where job in (select id from jobs where branch = ? and kind = 'work')`,
  ).run(branch);
}

// What wakes the owner of a pause on `project` (`thread`, or all of it), from hq's --until (jobs: `until`; milestones and
// deliverables: `untilWhole`) and --until-time, each one a pause there can wait for, or why not
export function conditionsOf(
  ask: { until?: unknown[]; untilWhole?: unknown[]; untilTime?: unknown },
  project: string,
  thread: string | null,
  now: number,
) {
  const until = [...new Set((ask.until ?? []).map(Number))];
  for (const id of until) {
    const refused = untilRefusal(id, project, thread);
    if (refused) return refused;
  }
  const wholes = new Set<string>();
  for (const given of new Set((ask.untilWhole ?? []).map(String))) {
    const id = isPiece(given) ? null : wholeId(given);
    if (id === null) return noWhole(given);
    const refused = untilWholeRefusal(id, project, thread);
    if (refused) return refused;
    wholes.add(id);
  }
  const time = ask.untilTime == null ? null : parseTime(String(ask.untilTime), now, false, '--until-time');
  if (typeof time === 'string') return time;
  return { until, wholes: [...wholes], untilTime: time === null ? null : new Date(time).toISOString() };
}

// A job the pause can wait for: work that hasn't ended or merged yet, and that neither it nor any job it needs first (at
// any depth) is held short of its merge (the pause would hold them, and never wake its owner).
export function untilRefusal(id: number, project: string, thread: string | null) {
  if (!Number.isSafeInteger(id) || id <= 0) return '--until takes a job number';
  const j = db
    .prepare(
      redraws.query(`select j.status, ${jobs.merged('j')} merged, ${mergePending('j')} pending from jobs j
      where j.id = ? and j.kind = 'work'`),
    )
    .get(id) as { status: string; merged: number; pending: number | null } | undefined;
  if (!j) return `there's no job #${id}`;
  if (j.merged) return `#${id} is done and merged already: nothing is left for it to wake you about`;
  if (!j.pending)
    return `#${id} ${j.status === 'done' ? 'ended without work that can merge' : j.status}: nothing is left for it to wake you about`;
  const held = jobs.prerequisites([id], { ordered: true }).filter(n => heldShort(n, project, thread));
  const where = (n: { thread: string | null }) => n.thread ?? jobs.pauseName(jobs.DESK);
  const root = held.find(n => n.id === id),
    first = held.find(n => n.id !== id);
  if (root) return `#${id} is on ${where(root)}, which the pause would hold: it would never end and wake you`;
  if (first)
    return `#${id} needs #${first.id} first, on ${where(first)}, which the pause would hold: it would never end and wake you`;
  return null;
}

// A milestone or deliverable (`id`, whole.ts) the pause can wait for to go live: not live already, not what the pause
// holds, and none of its open work, nor any job that work or its open deliverables (one with no tasks yet too) need
// first, held short of its merge by the pause. A deliverable's pause leaves it out of its milestone (its own pause
// keeps it out: whole.ts).
export function untilWholeRefusal(id: string, project: string, thread: string | null) {
  const name = wholeName(id);
  if (thread === id || (thread === null && (id === project || id.startsWith(`${project}/`))))
    return `the pause would hold ${name}: it would never go live and wake you`;
  const work = (
    db
      .prepare(`select x.id from (${wholeWork('?1', '?2')}) x join jobs j on j.id = x.id where ${mergePending('j')}`)
      .all(id, thread) as { id: number }[]
  ).map(j => j.id);
  const open = (
    db.prepare(`select t.id from threads t where ${openIn('t', '?1', '?2')}`).all(id, thread) as {
      id: string;
    }[]
  ).map(t => t.id);
  const held = jobs.prerequisites(work, { ordered: true, threads: open }).find(n => heldShort(n, project, thread));
  if (held)
    return `${name} needs #${held.id} first, on ${held.thread ?? jobs.pauseName(jobs.DESK)}, which the pause would hold: it would never go live and wake you`;
  // A deliverable it needs with no tasks yet: the pause would hold the first one filed there
  const needed =
    project === jobs.DESK
      ? undefined
      : jobs.prerequisiteDeliverables(work, open).find(t => (thread ? t === thread : t.startsWith(`${project}/`)));
  if (needed) return `${name} needs ${needed} first, which the pause would hold: it would never go live and wake you`;
  if (wholeLive(id, thread)) return `${name} is live already: nothing is left for it to wake you about`;
  return null;
}

// Whether the pause on `project` (`thread`, or all of it) holds job `n` short of its merge: it's on what the pause pauses,
// and runs there, or merges only through the review, rulings and fixes its pull request's rounds make there (they
// take its thread: jobs.ts threadFrom). Of what the desk's pause lets go (jobs.ts deskLets), expedited work merges on
// its checks ahead of its review, and a meeting merges nothing. A call's follow-up runs, but its review would wait.
function heldShort(
  n: { thread: string | null; kind: string; expedite: number },
  project: string,
  thread: string | null,
) {
  if (project === jobs.DESK) return n.thread === null && !n.expedite && n.kind !== 'meeting';
  return !!n.thread && (thread ? n.thread === thread : n.thread.startsWith(`${project}/`));
}
