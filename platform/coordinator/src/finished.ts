// What finished since the last check, for the CEO's summary (summary.ts): the threads their owners called done (hq plan
// done) and the board's tasks and promises whose work ended (agreements.ts), each once its work is live, the last of its
// pull requests merged and a deploy that has it (wakes.ts). A thread's done is its owner's word and needs nothing merged,
// so its work's merges are read here: a fix round is on its job's branch, and a re-land and the job for a card's answer
// are on the same thread. It tells nobody: whether the board hears is the CEO's call.
// (its messages say deliverable, the board's word for a thread)
import { db } from './db.ts';
import * as wakes from './wakes.ts';
import * as agreements from './agreements.ts';
import * as memory from './memory.ts';
import { clock, dropped, finished } from './windows.ts';
import { lastCheck } from './threats.ts';
import { ownerOf } from './projects.ts';

// Each line, and whether it carries the board's word (a call item, or a card the board answered): only such a line brings
// the CEO the hourly check by itself (summary.ts worth), as the board may have asked to hear the moment it's ready; other
// finished threads show beside what does.
export function lines(now: number) {
  const since = lastCheck(now);
  const moved = movedSince(since);
  const threads = threadsDone(since, now, moved);
  const named = new Set(threads.flatMap(t => t.items));
  const items = agreements.ended().flatMap(i => {
    if (named.has(i.id) || !i.carriers.some(id => moved.has(id))) return [];
    const live = liveAt(i.carriers);
    if (!live || live.at <= since) return [];
    const work = i.carriers.map(id => `#${id}`).join(', ');
    const when = live.deployed
      ? `deployed ${clock(live.at, now)}`
      : `ended ${clock(live.at, now)} with nothing to deploy`;
    return [
      {
        line: `item #${i.id} (call ${i.call}, ${i.kind} for ${i.owner}): ${words(i)}. Its work (${work}) ${when}${i.status === 'ready' ? YES : ''}`,
        board: true,
      },
    ];
  });
  return [...threads, ...items];
}

// Finished isn't delivered: a ready item stays on what the board asked for until the CEO records its yes (ledger.ts
// done)
const YES = ". It's ready, not delivered: open until the board has it and says yes (hq item done)";

// Done threads appear once their remaining work is live and nothing is open (windows.ts).
// Their items must still be handled: closing work reopens its items (ledger.ts reopen).
// Items and answered cards follow a failed job through its replacement (hq job --lands).
// Abandoned work contributes neither items nor cards.
// Only the threads whose work can have gone live since the last check are read: done since, or a job of theirs moved
// since (movedSince).
function threadsDone(since: number, now: number, moved: Set<number>) {
  const done = db
    .prepare(
      `select t.id, t.name, t.project, t.done from threads t where t.status = 'done' and (t.done > $at
        or exists (select 1 from jobs j indexed by jobs_thread_state where j.thread = t.id
          and j.id in (select value from json_each($moved))))
      order by t.done`,
    )
    .all({ at: new Date(since).toISOString(), moved: JSON.stringify([...moved]) }) as {
    id: string;
    name: string;
    project: string;
    done: string;
  }[];
  // (a thread's jobs from its index, their kind and status from db.ts jobs_state: never their rows, cold behind their
  // briefs.)
  const ofThread = db.prepare(`select s.id, s.kind, s.status from jobs j indexed by jobs_thread_state
    cross join jobs s indexed by jobs_state on s.id = j.id where j.thread = ?`);
  return done.flatMap(t => {
    const jobs = ofThread.all(t.id) as { id: number; kind: string; status: string }[];
    const work = jobs.filter(j => j.kind === 'work' && j.status !== 'cancelled');
    const kept = jobs.filter(j => !dropped(j.id));
    const doneJobs = work.filter(j => j.status === 'done' && kept.includes(j)).map(j => j.id);
    if (work.some(j => ['queued', 'running', 'blocked'].includes(j.status)) || !doneJobs.every(id => finished(id)))
      return [];
    const live = liveAt(doneJobs);
    const at = Math.max(Date.parse(t.done), live?.at ?? 0);
    if (!live || at <= since) return [];
    const { items, cards } = carried(kept.map(j => j.id));
    const carries = [
      ...items.map(
        i =>
          `item #${i.id} (call ${i.call}, ${i.kind}${i.status === 'ready' ? ', ready for the board to say yes' : ''}): ${words(i)}`,
      ),
      ...cards.map(c => `card #${c.id} "${c.title}"`),
    ];
    const deployed = live.deployed ? `its work deployed ${clock(live.at, now)}` : 'nothing of it to deploy';
    return [
      {
        line: `deliverable ${t.id} (${t.name}, ${ownerOf(t)}'s): done ${clock(Date.parse(t.done), now)}, ${deployed}${carries.length ? `. It carries ${carries.join('; ')}` : ''}`,
        board: carries.length > 0,
        items: items.map(i => i.id),
      },
    ];
  });
}

// The jobs whose work can have gone live since the last check (`since`): ended since, or on a branch whose pull request
// merged no earlier than the last deploy finished by then was fetched (one merged before went live with that deploy at
// the latest: wakes.ts deployed). Read from indexes (db.ts jobs_counts, prs_merged, jobs_branch), never a job's row, so
// the summary reads only their threads and items, not every one ever done.
function movedSince(since: number) {
  const at = new Date(since).toISOString();
  const deployed =
    (
      db.prepare('select max(fetched) fetched from deploys where ok = 1 and finished <= ?').get(at) as {
        fetched: string | null;
      }
    ).fetched ?? '';
  const ended = db.prepare('select id from jobs indexed by jobs_counts where finished > ?').all(at) as { id: number }[];
  // (merged_at is an ISO time, so its first 19 characters bound the index's range)
  const branches = (
    db
      .prepare(
        `select branch from prs where merged_at >= substr($deployed, 1, 19) and status = 'merged'
        and strftime('%Y-%m-%dT%H:%M:%fZ', merged_at) >= $deployed`,
      )
      .all({ deployed }) as { branch: string }[]
  ).map(p => p.branch);
  // a branch is its job's own (job/<id>) or the one jobs name (a thread's)
  const named = db
    .prepare('select id from jobs indexed by jobs_branch where branch in (select value from json_each(?))')
    .all(JSON.stringify(branches)) as { id: number }[];
  const own = branches
    .map(b => /^job\/(\d+)$/.exec(b)?.[1])
    .filter(id => id !== undefined)
    .map(Number);
  return new Set([...ended.map(j => j.id), ...named.map(j => j.id), ...own]);
}

// The board's handled and ready items and answered cards that work (its kept jobs' ids) carries, through each job's replacements:
// the jobs and every job they replaced read once (`line`), then each item and card against them, not against each job
function carried(ids: number[]) {
  const json = JSON.stringify(ids);
  const line = `with recursive line(id) as (select value from json_each($ids)
    union select r.replaces from line join job_replacement_links r on r.job = line.id)`;
  const items = db
    .prepare(
      `${line} select id, call, kind, what, status from call_items i where status in ('handled', 'ready') and (i.job in (select id from line)
      or i.id in (select item from jobs indexed by jobs_item where item is not null and id in (select value from json_each($ids))))
      order by id`,
    )
    .all({ ids: json }) as { id: number; call: number; kind: string; what: string; status: string }[];
  const cards = db
    .prepare(
      `${line} select id, title from requests where customers = 0 and id in (select answers from jobs
      where id in (select id from line)) order by id`,
    )
    .all({ ids: json }) as { id: number; title: string }[];
  return { items, cards };
}

// When work (its jobs' ids) went live: the first deploy that has the last of its merges, or with none merged, when its
// last job ended; null while that deploy is still to come.
function liveAt(ids: number[]) {
  const json = JSON.stringify(ids);
  const lastEnd = db
    .prepare("select max(finished) at from jobs where id in (select value from json_each(?)) and status = 'done'")
    .get(json) as { at: string | null };
  const end = lastEnd.at ? Date.parse(lastEnd.at) : 0;
  const last = db
    .prepare(
      `select p.number from jobs j join prs p on p.branch = coalesce(j.branch, 'job/' || j.id)
      where j.id in (select value from json_each(?)) and p.status = 'merged' order by p.merged_at desc limit 1`,
    )
    .get(json) as { number: number } | undefined;
  if (!last) return { at: end, deployed: false };
  const live = wakes.deployed(`pr:${last.number}`);
  if (!live || 'never' in live) return null;
  return { at: Math.max(end, Date.parse(live.deploy.finished)), deployed: true };
}

// An item's words, only from a call every job reads (memory.ts readByAll): the summary is read for no one job, and the
// hourly check's prompt carries it, so a call about a customer, a card for keys or one still live keeps its words to
// hq call, which shows them to the jobs it may.
const words = (i: { call: number; what: string }) =>
  memory.readByAll(i.call) ? i.what : 'its words left out (hq call shows this call only to the jobs it may)';
