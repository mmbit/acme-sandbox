// The executive's summary (hq summary): the company's picture in a few plain lines, for the CEO to judge. What the board
// asked for and how long each has waited, what finished since the last check (finished.ts: threads done and the board's
// items, merged and deployed), the threads whose work is in for their owners to judge (threadjudge.ts), the platform's
// alarms on now (alarms.ts), what threatens the plan (threats.ts), what
// waits for a decision of the board's, the work proposed to the CEO, and whether the queue grew faster than it drained.
// It's read from the minute's forecast and HQ's own records, and it tells nobody: the CEO's hourly follow-through check
// carries it (followthrough.ts), and whether the board hears any of it, work it asked to hear about the moment it's
// ready included, is the CEO's call.
import { db } from './db.ts';
import { agreements } from './agreements.ts';
import * as jobs from './jobs.ts';
import * as threats from './threats.ts';
import * as finished from './finished.ts';
import * as threadjudge from './threadjudge.ts';
import * as proposals from './proposals.ts';
import * as decisions from './decisions.ts';
import * as alarms from './alarms.ts';
import * as routing from './routing.ts';
import type { Forecast } from './forecast.ts';

const HOUR_MS = 3_600_000;
// The queue's growth is counted over this many hours.
const QUEUE_HOURS = 6;

type Part = { head: string; lines: string[] };

// The summary as hq summary prints it, and whether anything in it is for the CEO to look at (the follow-through check
// is queued for it): a line in any part but the finished one, where only work carrying the board's word counts (a
// finished thread of the company's own is news, not a reason to look). The queue's line is always there.
//
export function read(f: Forecast) {
  const done = finished.lines(f.now);
  const news: Part = { head: 'Finished since the last check (merged and deployed)', lines: done.map(d => d.line) };
  const parts: Part[] = [
    { head: 'The board asked for (and how long it has waited)', lines: asked(f.now) },
    news,
    {
      head: 'Ready to judge (each owner closes it with hq plan done or draws its next task)',
      lines: threadjudge.lines(f.now),
    },
    { head: 'Alarms on now (HQ told you and nobody else)', lines: alarms.lines() },
    { head: 'What threatens the plan', lines: threats.lines(f) },
    { head: "Held for the board's decision", lines: decisions.awaited() },
    { head: "Proposed, each for its project's owner (hq inbox --all)", lines: proposals.waiting() },
  ];
  const shown = parts.filter(p => p.lines.length).map(p => `${p.head}:\n${p.lines.map(l => `- ${l}`).join('\n')}`);
  const worth = parts.some(p => p !== news && p.lines.length > 0) || done.some(d => d.board);
  return { text: [...shown, queueLine(f.now)].join('\n\n'), worth };
}

// The call items still open or whose work is (agreements.ts: a decision handled is a standing rule, not a wait), the
// cards the board answered whose work is still open, the products that owe the board a return after its feedback
// (owed.ts), the board's notes on a pull request still being worked in, and its sent notes a routing check ended without
// routing (routing.ts). A customer's card stays out (house rule 7).
// (The cards' jobs' status and branch from db.ts jobs_state, not their rows.)
function asked(now: number) {
  const since = (iso: string) => threats.age(now - Date.parse(iso));
  const items = agreements()
    .filter(a => a.status === 'open' || a.kind !== 'decision')
    .map(a => {
      const { ts } = db.prepare('select ts from calls where id = ?').get(a.call) as { ts: string };
      return `item #${a.id} (call ${a.call}, ${a.kind} for ${a.owner}, ${a.status}), waiting ${since(ts)}: ${a.what}`;
    });
  const cards = (
    db
      .prepare(
        `select r.id, r.title, r.answered, j.id job, j.agent, j.status from requests r
        join jobs j indexed by jobs_state on j.id = r.heard_by where r.status = 'answered' and r.customers = 0 and (j.status in ('queued', 'running', 'blocked')
          or j.status = 'done' and ${unmerged('j')}) order by r.answered`,
      )
      .all() as { id: number; title: string; answered: string; job: number; agent: string; status: string }[]
  ).map(c => `card #${c.id} "${c.title}", answered ${since(c.answered)} ago: #${c.job} (${c.agent}, ${c.status})`);
  const owed = (
    db.prepare('select slug, agent, opened, job from owed where closed is null order by opened').all() as {
      slug: string;
      agent: string;
      opened: string;
      job: number | null;
    }[]
  ).map(o => `${o.slug} owes the board a return on its feedback, waiting ${since(o.opened)}: ${o.agent}'s (hq owed)`);
  const notes = (
    db
      .prepare(
        `select id, agent, title, step, round, created from jobs where stage = 'feedback' and status in ('queued', 'running', 'blocked')
        order by id`,
      )
      .all() as {
      id: number;
      agent: string;
      title: string;
      step: string | null;
      round: number | null;
      created: string;
    }[]
  ).map(j => `#${j.id} (${j.agent}: ${jobs.nameOf(j)}), waiting ${since(j.created)}`);
  const unrouted = routing
    .leftUnrouted()
    .map(
      r =>
        `notes ${r.notes.map(n => `#${n}`).join(', ')} the board sent ${since(r.sent)} ago: check #${r.job} ended without routing them (hq route)`,
    );
  return [...items, ...cards, ...owed, ...notes, ...unrouted];
}

// The open jobs (not the intercom's), and how many came in and ended over the last QUEUE_HOURS (read from db.ts
// jobs_counts, not the rows).
function queueLine(now: number) {
  const since = new Date(now - QUEUE_HOURS * HOUR_MS).toISOString();
  const { open, came, went } = db
    .prepare(
      `select sum(status in ('queued', 'running', 'blocked')) open, sum(created > $since) came,
        sum(status in ('done', 'failed', 'cancelled') and finished > $since) went from jobs indexed by jobs_counts
        where kind != 'chat'`,
    )
    .get({ since }) as { open: number | null; came: number | null; went: number | null };
  const [n, inn, out] = [open ?? 0, came ?? 0, went ?? 0];
  const change = inn > out ? `it grew by ${inn - out}` : inn < out ? `it shrank by ${out - inn}` : 'it held steady';
  return `Queue: ${n} open jobs. In the last ${QUEUE_HOURS} h, ${inn} came in and ${out} ended: ${change}.`;
}

// Work done with the latest pull request on its branch not merged yet (`j`: the job's alias)
const unmerged = (j: string) => `exists (select 1 from prs p where p.branch = coalesce(${j}.branch, 'job/' || ${j}.id)
  and p.status in ('open', 'stuck', 'board'))`;
