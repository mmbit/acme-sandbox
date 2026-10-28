// What's going on right now, as a call hears it (call.ts's briefing, and hq now: the eta tool with no query): everyone
// HQ counts at work, each on its run with its seat, thread and window and, while a hold is on, why it runs; and each
// open desk phone card with the work that waits on it.
// (its messages say deliverable, the board's word for a thread)
import { db } from './db.ts';
import { org, companyTime } from './company.ts';
import { boardId, findAgent, nameOf, paused, held, pauseAllowed, pauseLets, FOLLOW_THROUGH } from './jobs.ts';
import * as pauses from './pauses.ts';
import * as redraws from './redraws.ts';
import { teamMembers } from './team.ts';
import { heldFor, isHidden } from './later.ts';
import type { Forecast } from './forecast.ts';

type Run = {
  id: number;
  agent: string;
  title: string;
  step: string | null;
  round: number | null;
  kind: string;
  seat: string | null;
  started: string | null;
  expedite: number;
  call: number | null;
  answers: number | null;
  pr: number | null;
  thread: string | null;
  thread_name: string | null;
  project: string | null;
  deadline: number | null;
  // no pause holds it (jobs.ts pauseLets): the hourly follow-through check, or a pause's wake for its owner
  lets: number;
  follow_through: number;
};
type Holds = {
  company: ReturnType<typeof paused>;
  allowed: Set<number>;
  runs: ReturnType<typeof held>;
  pauses: pauses.Pause[];
};

// The whole of it in words, with the forecast for the threads whose plan counts on a card.
export function words(f: Forecast, now = Date.now()) {
  const holds = holdsNow();
  return `Going on right now, as of ${companyTime(now)}. It changes during the call: the eta tool with no query reads it
again, fresh, whenever the board asks who's at work, whether a hold leaks or what a card holds up.
${atWork(holds)}
Waiting on the board's desk phone, each with the work that waits on it:
${cards(f, holds.pauses)}`;
}

// Everyone HQ counts at work (the agents and team members whose state is working: what HQ's world shows the board),
// then the holds on, then each run.
function atWork(holds: Holds) {
  const people = (org().departments ?? [])
    .flatMap((d: any) => d.agents ?? [])
    .filter((a: any) => a.status?.state === 'working' && !boardId(a.id));
  const runs = db
    .prepare(
      redraws.query(`select j.id, j.agent, j.title, j.step, j.round, j.kind, j.seat, j.started, j.expedite, j.call,
        j.answers, j.pr, j.thread, t.name thread_name, p.name project, t.deadline, ${pauseLets('j')} lets,
        ${FOLLOW_THROUGH('j')} follow_through from jobs j left join threads t on t.id = j.thread
        left join projects p on p.id = t.project where j.status = 'running' order by j.started, j.id`),
    )
    .all() as Run[];
  const working = new Set(people.map((a: any) => a.id as string));
  const members = teamMembers().filter(m => working.has(m.id));
  const agents = people.filter((a: any) => !a.temp);
  const idle = agents.filter((a: any) => !runs.some(r => r.agent === a.id));
  const inside = members.length ? `, and ${many(members.length, 'team member')} inside them` : '';
  const count = `HQ counts ${people.length} at work, as the board sees it: ${many(agents.length, 'agent')} on ${many(runs.length, 'run')}${inside}.`;
  const lines = runs.map(r => {
    const team = members.filter(m => m.job === r.id).map(m => m.name);
    return `- ${runLine(r)}${holdsAny(holds) ? ` Through the hold: ${through(r, holds)}.` : ''}${team.length ? ` Its team: ${team.join(', ')}.` : ''}`;
  });
  for (const a of idle) lines.push(`- ${a.name}: at work in HQ's view, with no run in HQ's records`);
  return `${count}\n${holdLines(holds)}\nAt work (the number is for reach):\n${lines.join('\n') || '- nobody'}`;
}

function holdsNow(): Holds {
  return { company: paused(), allowed: pauseAllowed() ?? new Set(), runs: held(), pauses: pauses.open() };
}
const holdsAny = (h: Holds) => !!h.company || !!h.runs || h.pauses.length > 0;

// The holds on now: the board's pause of the company, a kind of run holding agents' work, and the paused projects and
// threads, those paused alike together.
function holdLines(h: Holds) {
  if (!holdsAny(h)) return 'No hold is on: nothing is paused.';
  const lines = ['Holds on now:'];
  if (h.company)
    lines.push(
      `- The board's pause of the company, since ${at(h.company.since)}: only the intercom, the board's own word and the work it names start.`,
    );
  if (h.runs) lines.push(`- ${h.runs.line}: it holds the work of ${h.runs.agents.join(', ')} ${h.runs.until}.`);
  const alike = new Map<string, pauses.Pause[]>();
  for (const p of h.pauses) {
    const key = JSON.stringify([p.why, p.until.map(u => u.id), p.decision?.id]);
    alike.set(key, [...(alike.get(key) ?? []), p]);
  }
  for (const group of alike.values()) {
    const [p] = group;
    lines.push(`- Paused: ${group.map(g => g.target).join(', ')}, ${releaseOf(p)}. Why: ${p.why}`);
  }
  return lines.join('\n');
}

// (what wakes its owner never lifts it: only a resume or the board's decision does)
function releaseOf(p: pauses.Pause) {
  const wakes = [
    ...(p.untilTime ? [`${at(p.untilTime)} comes`] : []),
    ...p.until.map(u => `#${u.id} "${u.title}" (${u.agent}'s, ${u.state}) merges or ends`),
  ];
  const woken = wakes.length ? `; once ${wakes.join(' and ')}, its owner judges whether to lift it` : '';
  if (p.decision)
    return `until the board decides "${p.decision.name}"${p.decision.card ? `, on its card "${cardTitle(p.decision.card)}"` : ''}`;
  return `until it's resumed${woken}`;
}

// One run: its number, whose, what, its seat and start, its thread and window
function runLine(r: Run) {
  const what =
    r.kind === 'work' ? 'job' : r.kind === 'chat' ? 'the intercom' : `${r.kind}${r.pr ? ` of PR #${r.pr}` : ''}`;
  const since = r.started ? `, since ${at(r.started)}` : '';
  const where = r.thread
    ? `in "${r.thread_name}" (${r.project}), ${r.deadline ? `window to ${companyTime(r.deadline)}` : 'no window'}`
    : 'in no deliverable';
  return `#${r.id}, ${r.agent}: ${nameOf(r)} (${what}${r.seat ? ` on ${r.seat}` : ''}${since}), ${where}.`;
}

// Why a run goes on while a hold is on, from each hold's own rule: a pause stops what starts, never what's already
// running, so a run that started after the pause that should hold it has leaked.
function through(r: Run, h: Holds) {
  if (r.expedite) return 'expedited, so no hold stops it';
  if (r.kind === 'chat') return 'the intercom, which no hold stops';
  const reasons: string[] = [];
  if (h.company) reasons.push(companyReason(r, h));
  if (h.runs?.agents.includes(r.agent) && r.kind === 'work')
    reasons.push(`${h.runs.line} holds ${r.agent}'s work, and this run is going all the same`);
  const p = r.thread ? h.pauses.find(o => o.target === r.thread || o.target === r.thread!.split('/')[0]) : undefined;
  if (p && r.lets)
    reasons.push(
      `${p.target} is paused, but no pause holds ${r.follow_through ? "HQ's hourly follow-through check" : 'the job that wakes its owner to judge one'}`,
    );
  else if (p)
    reasons.push(
      r.started && r.started < p.at
        ? `it started before ${p.target} was paused (${at(p.at)}), and a pause doesn't stop a run under way`
        : `${p.target} is paused since ${at(p.at)}, yet this started after it: a leak`,
    );
  else if (!r.thread) reasons.push('it is in no deliverable, so no project or deliverable pause reaches it');
  else if (h.pauses.length) reasons.push(`its deliverable isn't paused${r.deadline ? ' (it has a window)' : ''}`);
  return reasons.join('; ');
}

function companyReason(r: Run, h: Holds) {
  const since = h.company!.since;
  if (!h.allowed.has(r.id))
    return r.started && r.started < since
      ? 'it started before the board paused the company'
      : "the board's pause of the company doesn't let it start, yet it started after it: a leak";
  if (r.call !== null || r.answers !== null) return "it's the board's own word (a call's work or a card's answer)";
  return "the board's pause lets it through: its own word or the work it names, on its pull request";
}

// Each open card, as the desk phone has it (held or for later, said so), with what waits on it: the jobs queued after
// it, the asker parked on it, the pauses waiting for its decision, and the threads whose plan counts on its answer.
function cards(f: Forecast, paused: pauses.Pause[]) {
  const open = db
    .prepare(
      `select r.id, r.title, r.agent, r.hidden_until, t.name thread from requests r left join jobs j on j.id = r.job
      left join threads t on t.id = j.thread where r.status = 'open' order by r.id`,
    )
    .all() as { id: number; title: string; agent: string | null; hidden_until: string | null; thread: string | null }[];
  const decided = paused.filter(p => p.decision?.card);
  return (
    open
      .map(c => {
        const asked = c.agent
          ? `, asked by ${String(findAgent(c.agent)?.name ?? c.agent)}${c.thread ? ` for "${c.thread}"` : ''}`
          : '';
        return `- ${c.title}${notes(c)}${asked}: ${waitingOn(c.id, f, decided)}`;
      })
      .join('\n') || '- none'
  );
}

function notes(c: { id: number; hidden_until: string | null }) {
  const work = heldFor(c.id);
  const later = isHidden(c.hidden_until) ? ` (for later: off the desk phone until ${at(c.hidden_until!)})` : '';
  return `${work ? ` (held: off the desk phone until ${work} is live)` : ''}${later}`;
}

function waitingOn(card: number, f: Forecast, decided: pauses.Pause[]) {
  const jobs = db
    .prepare(
      `select j.id, j.agent, j.title, j.step, j.round, j.status, t.name thread from jobs j left join threads t on t.id = j.thread
      where j.status in ('queued', 'blocked') and (j.id in (select job from request_waits where request = ?)
        or (j.status = 'blocked' and j.request = ?)) order by j.id`,
    )
    .all(card, card) as (Parameters<typeof nameOf>[0] & {
    id: number;
    agent: string;
    status: string;
    thread: string | null;
  })[];
  const named = new Set(jobs.map(j => j.thread));
  const threads = [...f.threads.values()]
    .filter(o => o.cards.some(c => c.request === card))
    .map(o => threadName(o.thread));
  const counting = threads.filter(t => !named.has(t));
  const parts = [
    ...(jobs.length
      ? [
          `holds up ${jobs.map(j => `#${j.id} "${nameOf(j)}" (${j.agent}'s, ${j.status === 'blocked' ? 'parked on it' : 'queued after it'}${j.thread ? `, in "${j.thread}"` : ''})`).join(', ')}`,
        ]
      : []),
    ...decided.filter(p => p.decision!.card === card).map(p => `keeps ${p.target} paused until it's answered`),
    ...(counting.length ? [`the plan of ${counting.map(t => `"${t}"`).join(', ')} counts on its answer`] : []),
  ];
  return parts.length
    ? `${parts.join('; ')}.`
    : "nothing in HQ waits on it: no job is queued after it, no deliverable's plan counts on it and no pause waits for it.";
}

const threadName = (id: string) =>
  (db.prepare('select name from threads where id = ?').get(id) as { name: string }).name;
const cardTitle = (id: number) =>
  (db.prepare('select title from requests where id = ?').get(id) as { title: string }).title;
const at = (iso: string) => companyTime(Date.parse(iso));
const many = (n: number, thing: string) => `${n} ${thing}${n === 1 ? '' : 's'}`;
