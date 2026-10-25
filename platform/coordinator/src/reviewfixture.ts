// Recorded author jobs, pull requests and deploys for coordinator tests.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { backup, DatabaseSync } from 'node:sqlite';

export type JobFields = { agent: string; title?: string; prompt?: string; engine?: string; [k: string]: unknown };

export function recordedReviews(db: DatabaseSync, queue: (job: JobFields) => number) {
  // (at: when GitHub merged it, for work whose deploy counts: wakes.ts deployed.)
  const mergedPr = (number: number, at?: number) =>
    db
      .prepare("update prs set status = 'merged', merged_at = coalesce(?, merged_at) where number = ?")
      .run(at === undefined ? null : new Date(at).toISOString(), number);
  // A job recorded as ended with no runs, so no estimate is sized on it, and the pull request of a job's branch stored in
  // a review state (open, stuck, board, merged).
  // (added, removed: its lines, as merged.ts counts them at the merge.)
  const ended = (j: JobFields, status = 'done', decision?: string) => {
    const id = queue(j);
    const output = decision ? JSON.stringify({ decision, summary: 'A recorded ruling', outcomes: [] }) : null;
    db.prepare("update jobs set status = ?, finished = '2026-10-19T08:00:00Z', output = ? where id = ?").run(
      status,
      output,
      id,
    );
    return id;
  };
  const storedPr = storePr.bind(null, db);
  const failedJobs = (...ids: number[]) => {
    for (const id of ids)
      db.prepare("update jobs set status = 'failed', finished = ? where id = ?").run(new Date().toISOString(), id);
  };
  const clearReviewHistory = () => db.exec("delete from prs where status = 'merged'");
  return { mergedPr, ended, storedPr, failedJobs, clearReviewHistory };
}

function storePr(
  db: DatabaseSync,
  number: number,
  job: number,
  status: string,
  files: string[] = [],
  recorded: {
    sha?: string;
    round?: number;
    since?: number;
    added?: number;
    removed?: number;
    reviewClass?: string;
    verdict?: string;
  } = {},
) {
  return db
    .prepare(
      `insert into prs (number, branch, author, status, files, sha, round, since, added, removed, review_class, verdict)
      select ?, 'job/' || id, agent, ?, ?, ?, ?, ?, ?, ?, ?, ? from jobs where id = ? on conflict(number) do update set status = excluded.status, round = excluded.round, sha = excluded.sha`,
    )
    .run(
      number,
      status,
      JSON.stringify(files),
      recorded.sha ?? null,
      recorded.round ?? 0,
      recorded.since ?? 0,
      recorded.added ?? null,
      recorded.removed ?? null,
      recorded.reviewClass ?? null,
      recorded.verdict ?? null,
      job,
    );
}

// Isolated owner-inbox scenarios reuse their PR numbers and thread names.
export function resetReviewInbox(db: DatabaseSync) {
  db.exec(
    'delete from ruling_reports; delete from review_triage; delete from pause_until; delete from pauses; delete from review_holds; delete from review_redraws; delete from waits; delete from thread_needs; delete from thread_aliases; delete from prs; delete from job_replacements; delete from jobs; delete from wakes; delete from proposals; delete from sorts; delete from planning_jobs; delete from threads; delete from review_inbox; delete from review_fix_tasks; delete from messages',
  );
}

// A file's tests sharing one coordinator: from now on, what a test leaves queued or blocked ends cancelled, so later
// claims take their own jobs. The jobs recorded before (a historical fixture's) stay.
export function leftoverJobs(db: DatabaseSync) {
  const first = (db.prepare('select coalesce(max(id), 0) + 1 id from jobs').get() as { id: number }).id;
  return () =>
    db
      .prepare(
        "update jobs set status = 'cancelled', seat = null, finished = ?, note = null where id >= ? and status in ('queued', 'blocked')",
      )
      .run(new Date().toISOString(), first);
}

// A retry the coordinator recorded with its wait, made runnable now
export function retryNow(db: DatabaseSync, job: number) {
  db.prepare('update jobs set not_before = 0 where id = ?').run(job);
}

// A deploy record as infra/deploys.py writes it, taken in through the coordinator's reader.
export async function recordedDeploy(
  dataDir: string,
  record: {
    fetched: number;
    finished: number;
    sha: string;
    ok: boolean;
    services: string[];
    recreated?: string[];
    reloaded?: string[];
  },
) {
  const dir = `${dataDir}/deploys`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/${record.finished}.json`,
    JSON.stringify({
      ...record,
      fetched: new Date(record.fetched).toISOString(),
      finished: new Date(record.finished).toISOString(),
    }),
  );
  const wakes = await import('./wakes.ts');
  wakes.readDeploys(dir);
}

// Historical deploy rows for queue-size and latency checks.
export function recordedDeployHistory(db: DatabaseSync, records: { fetched: number; finished: number; ok: boolean }[]) {
  const insert = db.prepare(`insert into deploys (file, sha, fetched, finished, ok, recreated, reloaded, services)
    values (?, ?, ?, ?, ?, '[]', '[]', '[]')`);
  for (const [i, record] of records.entries())
    insert.run(
      `history-${i}.json`,
      i.toString(16).padStart(40, '0'),
      new Date(record.fetched).toISOString(),
      new Date(record.finished).toISOString(),
      Number(record.ok),
    );
}

// The saved owner decisions of a running database, before direct redraw edges existed.
export async function historicalRedrawDatabase(db: DatabaseSync) {
  const directory = mkdtempSync(`${tmpdir()}/redraw-startup-`);
  await backup(db, `${directory}/hq.db`);
  const historical = new DatabaseSync(`${directory}/hq.db`);
  historical.exec("drop table review_redraws; delete from migrations where id = 'review-redraw-edges'");
  historical.close();
  return directory;
}

// A saved review whose diff against main now contains only records. Legacy inbox items predate ruling identities.
export async function reviewInboxDatabase(db: DatabaseSync, pr: number, files: string[], legacy: boolean) {
  const directory = mkdtempSync(`${tmpdir()}/review-inbox-startup-`);
  await backup(db, `${directory}/hq.db`);
  const saved = new DatabaseSync(`${directory}/hq.db`);
  saved.prepare('update prs set files = ? where number = ?').run(JSON.stringify(files), pr);
  if (legacy) {
    saved
      .prepare('update proposals set job = null where id = (select proposal from review_inbox where pr = ?)')
      .run(pr);
    saved.prepare('delete from migrations where id = ?').run('2026-10-22-review-inbox-ruling');
  }
  saved.close();
  return directory;
}

// A model's chosen panel for lifecycle scenarios that aren't testing the triage judgment itself.
export async function completeTriage(
  h: Awaited<ReturnType<typeof import('./harness.ts').harness>>,
  pr: number,
  agents?: string[],
  looker: string | null = null,
) {
  const queued = h.db
    .prepare(
      "select id, engine from jobs where pr = ? and stage = 'triage' and status = 'queued' order by id desc limit 1",
    )
    .get(pr) as { id: number; engine: string } | undefined;
  if (!queued) return;
  const panel = await import('./panel.ts');
  const triage = await import('./reviewtriage.ts');
  const row = h.db.prepare('select files, fixes_from from prs where number = ?').get(pr) as {
    files: string;
    fixes_from: string | null;
  };
  const selected = (agents ?? (row.fixes_from ? [] : panel.reviewers(pr).slice(0, 1))).filter(
    agent => !panel.excludedAuthors(pr).has(agent),
  );
  const run = await claimTriage(h, queued);
  await h.finish(run!, {
    output: JSON.stringify({
      decision: 'review',
      reason: 'The scenario supplies its independent reads',
      consolidator: panel.consolidator(pr),
      reviewers: selected.map(agent => ({
        agent,
        reason: 'Read this scenario',
        files: JSON.parse(row.files),
        domain: 'general',
        security: false,
      })),
      looker,
      exceptions: triage
        .blockers(pr)
        .flatMap(finding =>
          finding.by
            .filter(({ agent }) => !selected.includes(agent))
            .map(({ agent }) => ({ agent, reason: 'The consolidator checks these findings in this scenario' })),
        ),
    }),
  });
}

async function claimTriage(
  h: Awaited<ReturnType<typeof import('./harness.ts').harness>>,
  queued: { id: number; engine: string },
) {
  const seat = queued.engine === 'codex' ? 'codex-1' : 'claude-1';
  let run = await h.claim(queued.engine, { seat, util: 0.1 });
  const deferred = new Set<number>();
  while (run && run.id !== queued.id) {
    if (deferred.has(run.id)) throw new Error(`Triage #${queued.id} repeatedly claimed deferred job #${run.id}`);
    deferred.add(run.id);
    await h.finish(run, { status: 'limited', resetAt: Date.now() + 86_400_000 });
    run = await h.claim(queued.engine, { seat, util: 0.1 });
  }
  assertClaim(run?.id, queued.id);
  return run!;
}

function assertClaim(actual: number | undefined, expected: number) {
  if (actual !== expected) throw new Error(`Expected triage job #${expected}, claimed #${actual}`);
}

// A completed model read from a coordinator restart before its handoff ran.
export function completedTriage(db: DatabaseSync, job: number, output: object) {
  db.prepare('update jobs set output = ? where id = ?').run(JSON.stringify(output), job);
}
