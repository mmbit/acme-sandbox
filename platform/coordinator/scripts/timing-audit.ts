// node scripts/timing-audit.ts <tooling.json> <estimate-sample.json> <snapshots.json>
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PastJob } from '../src/matching.ts';
import { timingFlags } from '../src/timing.ts';

type Run = { job: number; kind: string; started: string; ended: string; outcome: string; minutes: number };
type Shown = {
  id: number;
  agent: string;
  title: string;
  engine: string;
  origin: PastJob['origin'];
  finished: string;
  rebuilt: boolean;
  runs: number;
  agent_minutes: number;
  wall_minutes: number;
  spend: number | null;
  unit: PastJob['unit'];
  pr: { number: number; status: string; merged_at: string | null } | null;
};
const paths = process.argv.slice(2);
if (paths.length !== 3) throw new Error('Pass the tooling, estimate sample and snapshot JSON exports.');
const ledger = JSON.parse(readFileSync(paths[0], 'utf8')) as { since: string; until: string; runs: Run[] };
const exported = JSON.parse(readFileSync(paths[1], 'utf8')) as Shown[];
const sample = exported.filter(job => job.finished <= ledger.until);
const snapshots = JSON.parse(readFileSync(paths[2], 'utf8')) as {
  snapshots: { snapshot: { jobs: { id: number; created: number }[] } }[];
};
const created = new Map(
  snapshots.snapshots.flatMap(snapshot => snapshot.snapshot.jobs.map(job => [job.id, job.created] as const)),
);
const runsByJob = new Map<number, Run[]>();
for (const run of ledger.runs) {
  if (run.ended > ledger.until) continue;
  const runs = runsByJob.get(run.job) ?? [];
  runs.push(run);
  runsByJob.set(run.job, runs);
}
const evidenceFor = (runs: Run[]) => ({
  runs: runs.length,
  outcomes: [...new Set(runs.map(run => run.outcome))].join(','),
  invalid_runs: runs.filter(run => !(run.minutes > 0)).length,
  unknown_seats: 0,
  replaced: 0,
});
const work = [...runsByJob.values()].filter(runs => runs[0].kind === 'work');
const terminalDone = work.filter(
  runs => [...runs].sort((a, b) => a.ended.localeCompare(b.ended)).at(-1)!.outcome === 'done',
);
const terminalRebuilt = work.filter(
  runs => [...runs].sort((a, b) => a.ended.localeCompare(b.ended)).at(-1)!.outcome === 'rebuilt',
);
const rows = sample.map(job => historical(job, runsByJob.get(job.id) ?? []));
const directory = mkdtempSync(join(tmpdir(), 'timing-audit-'));
process.env.DATA_DIR = directory;
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
const { rawPicksFor, picksFor, sizeOf, timingAudit } = await import('../src/matching.ts');
const holdouts = rows.filter(job => created.has(job.id) && !job.timing_flags?.length);
const pairs: { old: number; clean: number; actual: number }[] = [];
for (const job of holdouts) {
  const pool = rows.filter(previous => previous.finished < job.created);
  const old = sizeOf(rawPicksFor(job, pool).picks);
  const clean = sizeOf(picksFor(job, pool).picks);
  if (old && clean) pairs.push({ old: old.agent_ms, clean: clean.agent_ms, actual: job.agent_ms });
}
console.log(
  JSON.stringify(
    {
      interval: { since: ledger.since, until: ledger.until },
      ledger: {
        closed_runs: [...runsByJob.values()].flat().length,
        work_runs: work.flat().length,
        reconstructed_work_runs: work.flat().filter(run => run.outcome === 'rebuilt').length,
        jobs_ending_rebuilt: terminalRebuilt.length,
        first_run: ledger.runs[0]?.started ?? null,
      },
      terminal_done_proxy: timingAudit(
        terminalDone.map(
          (runs, index) =>
            ({
              id: index,
              timing_flags: timingFlags(evidenceFor(runs)),
            }) as PastJob,
        ),
      ),
      known_done_sample: timingAudit(rows),
      sample: {
        exported: exported.length,
        excluded_after_cutoff: exported.length - sample.length,
        missing_ledger_runs: sample.filter(job => !runsByJob.has(job.id)).length,
        first_finished: sample.map(job => job.finished).sort()[0] ?? null,
        last_finished:
          sample
            .map(job => job.finished)
            .sort()
            .at(-1) ?? null,
        rebuilt: sample.filter(job => job.rebuilt).length,
        by_engine: byEngine(rows),
      },
      sample_jobs_with_queue_time: rows.filter(job => created.has(job.id)).length,
      clean_holdouts: holdouts.length,
      paired_predictions: pairs.length,
      old: score(pairs.map(pair => [pair.old, pair.actual])),
      filtered: score(pairs.map(pair => [pair.clean, pair.actual])),
    },
    null,
    2,
  ),
);

function historical(job: Shown, runs: Run[]): PastJob {
  const evidence = evidenceFor(runs);
  // The live endpoint combines reconstructed runs and missing seats in this one indicator.
  evidence.unknown_seats = Number(job.rebuilt && !runs.some(run => run.outcome === 'rebuilt'));
  return {
    ...job,
    created: created.has(job.id) ? new Date(created.get(job.id)!).toISOString() : '',
    agent_ms: runs.reduce((sum, run) => sum + run.minutes * 60_000, 0),
    wall_ms: job.wall_minutes * 60_000,
    rebuilt: Number(job.rebuilt),
    pr: job.pr?.number ?? null,
    pr_status: job.pr?.status ?? null,
    merged_at: job.pr?.merged_at ?? null,
    files: '[]',
    added: null,
    removed: null,
    thread: null,
    entry: null,
    routine: null,
    slot: null,
    timing_flags: timingFlags(evidence),
  };
}
function byEngine(rows: PastJob[]) {
  return Object.fromEntries(
    [...new Set(rows.map(job => job.engine))].map(engine => [
      engine,
      timingAudit(rows.filter(job => job.engine === engine)),
    ]),
  );
}
function score(pairs: number[][]) {
  if (!pairs.length) return null;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean_absolute_error_minutes: mean(pairs.map(([predicted, actual]) => Math.abs(predicted - actual) / 60_000)),
    within_factor_two:
      pairs.filter(([predicted, actual]) => predicted >= actual / 2 && predicted <= actual * 2).length / pairs.length,
  };
}
