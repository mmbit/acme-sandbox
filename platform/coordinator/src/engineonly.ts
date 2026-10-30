// Work only one engine and model do (org.yaml `engineOnly`). A job declared to do it (hq job --only <id>), or on a pull
// request, branch or thread whose pushes change its paths, runs on that model and never falls back to another (jobs.ts
// onlyFor and modelOf). A review judges those paths only on it (judgedOn). A push of them from another engine's run goes
// back to its author before any review, to restore and redo them on the right one (owedRedo).
import { matchesGlob } from 'node:path';
import { db } from './db.ts';
import { yamlFile } from './company.ts';
import type { Seat } from './panel.ts';

export type EngineOnly = { id: string; what: string; engine: string; model: string; paths: string[] };

export function rules(): EngineOnly[] {
  return yamlFile('company/org.yaml').engineOnly ?? [];
}

export const byId = (id: string | null | undefined) => rules().find(rule => rule.id === id);

const held = (rule: EngineOnly, files: string[]) =>
  files.filter(file => rule.paths.some(path => matchesGlob(file, path)));

// The rule these files fall under, and which of them it holds (the first rule any of them matches)
export function ruleFor(files: string[]) {
  for (const rule of rules()) {
    const theirs = held(rule, files);
    if (theirs.length) return { ...rule, files: theirs };
  }
}

// The rule a job on this pull request or branch falls under: by every file its pushes changed
export function onWork(pr?: number | null, branch?: string | null) {
  if (!pr && !branch) return undefined;
  const rows = db
    .prepare(
      `select files from prs where number = $pr or branch = $branch
      union all select s.files from pushes s join prs p on p.number = s.pr where p.number = $pr or p.branch = $branch`,
    )
    .all({ pr: pr ?? null, branch: branch ?? null }) as { files: string }[];
  return ruleFor([...new Set(rows.flatMap(row => JSON.parse(row.files) as string[]))]);
}

// Queued work that a push shows to be the rule's moves to its engine and model before any seat takes it: the jobs on the
// pull request or branch and the tasks of its thread that haven't started. A review's own files decided its engine.
export function repin(pr: number, branch: string, rule: EngineOnly) {
  db.prepare(
    `update jobs set engine = $engine, cli = null, for_seat = null, model = $model, engine_only = $id
    where status = 'queued' and started is null and kind != 'review' and engine_only is null
    and (branch = $branch or pr = $pr or thread in (select id from threads where branch = $branch
      union select thread from jobs where thread is not null and coalesce(branch, 'job/' || id) = $branch))`,
  ).run({ engine: rule.engine, model: rule.model, id: rule.id, branch, pr });
}

// A review panel's seats, with work only one engine does judged on that engine alone. A seat on another engine that has
// other files too keeps those, so its independent read of them stays on its own engine, and hands the rule's to a seat
// on the rule's engine: the panel's first, else the first of `reviewers` on it, who joins. A seat with nothing else
// keeps them, and its review runs on the rule's engine (jobs.ts onlyFor), as does one no reviewer could take them from.
export function judgedOn(seats: Seat[], engineOf: (agent: string) => string | undefined, reviewers: string[]) {
  const judged = seats.map(seat => ({ ...seat }));
  for (const rule of rules())
    for (const seat of judged) {
      const theirs = held(rule, seat.files);
      if (!theirs.length || theirs.length === seat.files.length || engineOf(seat.agent) === rule.engine) continue;
      const judge = judgeOn(rule.engine, judged, engineOf, reviewers);
      if (!judge) continue;
      seat.files = seat.files.filter(file => !theirs.includes(file));
      judge.files = [...new Set([...judge.files, ...theirs])];
      judge.domains = [...new Set([...judge.domains, ...seat.domains])];
      // The seat that takes a security reader's files reads for security too.
      if (seat.security) judge.security = true;
    }
  return judged;
}
function judgeOn(engine: string, judged: Seat[], engineOf: (agent: string) => string | undefined, reviewers: string[]) {
  const seated = judged.find(seat => engineOf(seat.agent) === engine);
  if (seated) return seated;
  const agent = reviewers.find(reviewer => engineOf(reviewer) === engine);
  if (!agent) return undefined;
  const seat: Seat = { agent, files: [], domains: [], slice: false, security: false };
  judged.push(seat);
  return seat;
}

// The rule's files a pull request still owes a redo of, after this push (`changed`: what it changed since the head
// before it, `since`). A run on another engine adds the rule's files it changed, from the head before its push; a run on
// the rule's engine clears those it changed again. What's left goes back to the author before any review.
export function owedRedo(pr: number, changed: string[], since: string | undefined, branch: string) {
  const owed = db.prepare('select files, since from engine_redo where pr = ?').get(pr) as
    { files: string; since: string | null } | undefined;
  const before = owed ? (JSON.parse(owed.files) as string[]) : [];
  // (the rule first: most pushes fall under none, and need no look at who pushed.)
  const rule = ruleFor([...before, ...changed]),
    ranOn = rule && pushedOn(branch);
  if (!rule || !ranOn) return undefined;
  const wrong = ranOn !== rule.engine,
    pushed = held(rule, changed);
  const files = wrong ? [...new Set([...before, ...pushed])] : before.filter(file => !pushed.includes(file));
  const from = before.length ? (owed?.since ?? null) : (since ?? null);
  if (!files.length) db.prepare('delete from engine_redo where pr = ?').run(pr);
  else
    db.prepare(
      'insert into engine_redo (pr, files, since) values (?, ?, ?) on conflict(pr) do update set files = excluded.files, since = excluded.since',
    ).run(pr, JSON.stringify(files), from);
  return files.length ? { rule, files, ranOn, since: from } : undefined;
}

// The engine the last run that pushed to a branch ran on (its work or chat job, just ended when its push comes). The jobs
// that can be on the branch come by index first (its own, its thread's, the job it's named after: panel.ts authors),
// then the rule decides: alone, it would read every done job's row, seconds with the file off the disk.
function pushedOn(branch: string) {
  const row = db
    .prepare(
      `with maybe as (
        select id from jobs where branch = ?1
        union select j.id from threads t cross join jobs j on j.thread = t.id where t.branch = ?1 and j.branch is null
        union select id from jobs where ?1 like 'job/%' and id = cast(substr(?1, 5) as integer)
      ) select j.engine from maybe cross join jobs j on j.id = maybe.id left join threads t on t.id = j.thread
      where j.kind in ('work', 'chat') and j.status = 'done' and coalesce(j.branch, t.branch, 'job/' || j.id) = ?1
      order by j.finished desc, j.id desc limit 1`,
    )
    .get(branch) as { engine: string } | undefined;
  return row?.engine;
}

// What a push's author hears when work only one engine does goes back to it: start those files over from the head
// before the other engine's run, and draw them anew
export function redoPrompt(owed: NonNullable<ReturnType<typeof owedRedo>>) {
  const { rule, files, ranOn, since } = owed,
    base = since ?? '$(git merge-base origin/main HEAD)';
  return (
    `A run on ${ranOn} changed ${rule.what} on this branch: ${files.join(', ')}. That work is done on ${rule.model} ` +
    `only (org.yaml engineOnly), so this run is. Start those files over: restore each to the branch before that run ` +
    `(\`git checkout ${base} -- <file>\`, and \`git rm\` one that run added), then make what the task needs in them ` +
    `yourself, without reading or reusing what that run made. Keeping its work, however good it looks, doesn't count: ` +
    `each of these files has to change in your push, or it comes back to you. Then check it the way the craft notes ` +
    `ask (shared/craft, and the company's own).`
  );
}
