// Who decides a review's findings, the thread their tasks go in, and the review that is current for a thread.
import { db } from './db.ts';
import { ceo } from './company.ts';
import { findProject, findThread, type JobThreadAsk } from './projects.ts';
import { jobThread } from './newthread.ts';
import { refusal } from './threadorder.ts';
import { deskLets } from './jobs.ts';
import { shedRefusal } from './pauses.ts';
import type { Item } from './reviewinbox.ts';

export function authorized(item: Item, by: string) {
  const owner = item.project ? findProject(item.project)!.owner : ceo();
  return [owner, ceo()].includes(by) ? undefined : `findings:${item.pr} is ${owner}'s to decide (or the CEO's)`;
}

export function target(item: Item, ask: JobThreadAsk, by: string) {
  const thread = ask.thread ?? (ask.newThread ? undefined : item.thread);
  if (thread == null && !ask.newThread) return { refusal: 'name the thread for this review with --thread' };
  const existing = thread == null ? undefined : findThread(String(thread));
  const project = findProject(String(ask.newThread?.project ?? existing?.project ?? ''));
  if (!project) return { refusal: 'name an existing project or open thread' };
  const refused = refusal(project, by);
  if (refused) return { refusal: refused };
  return jobThread({ ...ask, thread: thread ?? undefined }, { agent: by, onCall: false });
}

export function current(thread: string | null, pr?: number) {
  const canonical = thread ? (findThread(thread)?.id ?? null) : null;
  return db
    .prepare(
      `select r.pr from review_inbox r join prs p on p.number = r.pr
    join proposals q on q.id = r.proposal left join threads t on t.id = r.thread
    where p.status in ('open', 'stuck') and p.round = r.round and p.branch = r.branch
    and p.number = (select max(number) from prs where branch = p.branch)
    and r.decision = 'changes' and q.status != 'dropped' and (t.branch is null or t.branch = p.branch)
    and ($pr is not null and r.pr = $pr or $pr is null and r.thread = $thread)
    order by p.number desc limit 1`,
    )
    .get({ pr: pr ?? null, thread: canonical }) as { pr: number } | undefined;
}

export function bind(item: Item, thread: string) {
  const target = findThread(thread)!;
  if (target.branch && target.branch !== item.branch) return 'that thread already holds another branch';
  // (in no thread: what the desk's pause holds, as regroup.ts moveJob.)
  const on = db
    .prepare(
      `select distinct thread from jobs where coalesce(branch, 'job/' || id) = ?
      and (thread is not null or not ${deskLets('jobs')})`,
    )
    .all(item.branch) as { thread: string | null }[];
  const held = on.map(r => shedRefusal(r.thread, { project: target.project, thread: target.id })).find(Boolean);
  if (held) return held;
  db.prepare("update jobs set thread = ? where coalesce(branch, 'job/' || id) = ?").run(target.id, item.branch);
  db.prepare('update threads set branch = ? where id = ?').run(item.branch, target.id);
  db.prepare('update review_inbox set thread = ?, project = ? where pr = ?').run(target.id, target.project, item.pr);
  db.prepare('update proposals set thread = ?, project = ? where id = ?').run(target.id, target.project, item.proposal);
  item.thread = target.id;
  item.project = target.project;
}
