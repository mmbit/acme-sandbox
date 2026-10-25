// Jobs that ended before a coordinator test began, written straight to its database: no route makes one, so a test of
// what reads history (estimates, the play, the backtest, the counts) sets it here. The harness gives it as h.pastJob.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { recordedReviews } from './reviewfixture.ts';

// The columns a test names (as the jobs table has them), with times in ms. run: its one run on claude-a, whose started
// and ended are also the job's started and finished unless overridden; runs: several, in order, the first's start and
// the last's end the job's. merged: its pull request merged then (numbered as the job's `pr` if named), changing
// `files`, with review's lines and verdict; byBranch: that pull request known by the job's branch alone, the job's `pr`
// left unset (a work job's). sized: the agent time the estimate stored when the job was queued.
export type PastJobFields = {
  created?: number;
  finished?: number;
  run?: Run;
  runs?: Run[];
  merged?: number;
  files?: string[];
  review?: { added?: number; removed?: number; verdict?: string };
  byBranch?: boolean;
  sized?: number;
  [column: string]: unknown;
};
type Run = { started: number; ended: number; outcome?: string; seat?: string | null };

// The columns a test leaves out: kit's work, queued by juno, done.
const DEFAULTS = {
  agent: 'kit',
  title: 'Paint the harbour',
  prompt: 'x',
  engine: 'claude',
  status: 'done',
  queued_by: 'juno',
};

export function recordedPastJobs(
  db: DatabaseSync,
  { storedPr, mergedPr }: Pick<ReturnType<typeof recordedReviews>, 'storedPr' | 'mergedPr'>,
) {
  let prs = 9000;
  return ({
    run,
    runs = run ? [run] : [],
    merged,
    files = [],
    review,
    byBranch,
    sized,
    created,
    finished,
    ...columns
  }: PastJobFields) => {
    const [first, last] = [runs[0], runs.at(-1)];
    const ended = finished ?? last?.ended ?? Date.now();
    const row: Record<string, unknown> = {
      ...DEFAULTS,
      created: at(created ?? first?.started ?? ended),
      started: first && at(first.started),
      finished: at(ended),
      ...columns,
      pr: byBranch ? undefined : columns.pr,
    };
    const names = Object.keys(row).filter(name => row[name] !== undefined);
    const statement = db.prepare(`insert into jobs (${names}) values (${names.map(() => '?')})`);
    const values = names.map(name => row[name]) as SQLInputValue[];
    const { lastInsertRowid } = statement.run(...values);
    const id = Number(lastInsertRowid);
    storeRuns(db, id, runs);
    if (merged !== undefined) {
      const number = Number(columns.pr ?? ++prs);
      storedPr(number, id, 'merged', files, review);
      mergedPr(number, merged);
    }
    if (sized !== undefined)
      db.prepare(
        `insert into predictions (job, made, agent_ms, picks, basis, slow_agent_ms)
        values (?, ?, ?, '[]', '{"kind":"work","agent":null,"words":[]}', ?)`,
      ).run(id, String(row.created), sized, sized);
    return id;
  };
}

// A job's runs, each on claude-a and done unless it names its seat and outcome
function storeRuns(db: DatabaseSync, job: number, runs: Run[]) {
  for (const run of runs)
    db.prepare('insert into runs (job, seat, started, ended, ended_as) values (?, ?, ?, ?, ?)').run(
      job,
      run.seat === undefined ? 'claude-a' : run.seat,
      at(run.started),
      at(run.ended),
      run.outcome ?? 'done',
    );
}

const at = (ms: number) => new Date(ms).toISOString();
