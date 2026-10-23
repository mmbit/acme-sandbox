// node --test src/playtime.test.ts   (uses a throwaway DATA_DIR): the queue's play (forecast.ts refresh: the snapshot,
// both paces' sizes and plays, the threads and the prediction log) on a queue of HQ's size stays well under a second.
// Realistic brief lengths make repeated full-table scans expensive enough for this timing check to detect.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { recordedDeployHistory } from './reviewfixture.ts';

const h = await harness('playtime');
const forecast = await import('./forecast.ts');
const redraws = await import('./redraws.ts');
const ordering = await import('./ordering.ts');
const { remember } = await import('./db.ts');
const predictions = await import('./predictions.ts');
await import('./predictionlog.ts');
// (its schedule_runs, which the play's matching reads for a scheduled job: the server loads it)
await import('./schedule.ts');

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
const NOW = Date.now();
const at = (ms: number) => new Date(ms).toISOString();
const BRIEF = 'A brief as long as most: what to do, what is done already, and how to check it. '.repeat(120);
const AGENTS = ['kit', 'bolt', 'juno', 'chime'];
const THREADS = Array.from({ length: 30 }, (_, i) => h.dueThread(i < 15 ? { deadline: NOW + HOUR } : {}));
const WORDS = 'paint harbour map seat review fix call card thread estimate queue play site chat mail deploy film'.split(
  ' ',
);
const titleOf = (i: number) => Array.from({ length: 6 }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(' ');

// Live-shaped history: 1,600 merged work jobs and three review runs each across twelve days, plus 1,000 deploys.
// Thirty replacements still await merge. The open queue also has 250 work jobs: 60 queued, 20 running,
// 100 done in review with a review queued, and 70 queued behind others. Some have a deadline today or waits on others.
// Recent review and deploy history both affect a fresh plan.
function grow() {
  const inserts = jobInserts();
  h.db.exec('begin');
  const prs = completedHistory();
  openQueue(inserts, prs);
  redrawHistory();
  recordedDeployHistory(
    h.db,
    Array.from({ length: 1000 }, (_, i) => {
      const fetched = NOW - 12 * DAY + i * 17 * 60_000;
      return { fetched, finished: fetched + 90_000, ok: i % 7 !== 0 };
    }),
  );
  h.db.exec('commit');
  h.db.exec('analyze');
  // each open job's stored size, as the server's minute sweep gives it
  predictions.sweep(NOW);
}

function jobInserts() {
  const job = h.db.prepare(`insert into jobs (created, agent, title, prompt, engine, status, queued_by, finished, kind,
    pr, branch, thread, after, round) values ($created, $agent, $title, $prompt, 'claude', $status, 'kit', $finished,
    $kind, $pr, $branch, $thread, $after, $round)`);
  const run = h.db.prepare(
    "insert into runs (job, seat, started, ended, ended_as) values (?, 'claude-a', ?, ?, 'done')",
  );
  const pr = h.db.prepare(`insert into prs (number, branch, author, status, merged_at, files)
    values (?, ?, 'kit', ?, ?, '["src/work.ts"]')`);
  const addJob = (fields: Record<string, string | number | null>) =>
    Number(
      job.run({
        prompt: BRIEF,
        finished: null,
        pr: null,
        branch: null,
        thread: null,
        after: null,
        round: null,
        ...fields,
      }).lastInsertRowid,
    );
  return { addJob, run, pr };
}

function completedHistory() {
  let prs = 0;
  const byKit = { prompt: BRIEF, queued_by: 'kit' };
  for (let i = 0; i < 1600; i++) {
    const t = NOW - 12 * DAY + i * 10 * 60_000;
    const done = h.pastJob({
      ...byKit,
      agent: AGENTS[i % 4],
      title: titleOf(i),
      kind: 'work',
      thread: THREADS[i % 30],
      run: { started: t, ended: t + HOUR },
      pr: ++prs,
      merged: t + 3 * HOUR,
      sized: HOUR,
      files: ['src/work.ts'],
    });
    for (const kind of ['review', 'review', 'consolidate'])
      h.pastJob({
        ...byKit,
        agent: 'bolt',
        title: `Review #${prs}`,
        kind,
        pr: prs,
        branch: `job/${done}`,
        round: 1,
        created: t + HOUR,
        finished: t + 2 * HOUR,
        run: { started: t + HOUR, ended: t + 1.5 * HOUR },
      });
  }
  return prs;
}

// Closed branches retain redraws after replacement work merges. Pending ones still hold their thread's tasks.
function redrawHistory() {
  for (let i = 0; i < 60; i++) {
    const thread = THREADS[i % THREADS.length];
    const source = h.pastJob({ agent: 'kit', thread, run: { started: NOW - DAY, ended: NOW - DAY + HOUR } });
    const replacement = h.pastJob({ agent: 'kit', thread, run: { started: NOW - HOUR, ended: NOW }, sized: HOUR });
    h.storedPr(8000 + i, source, 'closed');
    h.storedPr(9000 + i, replacement, i % 2 ? 'merged' : 'open');
    redraws.close(8000 + i, `job/${source}`);
    redraws.accept(8000 + i, replacement);
  }
}

function openQueue({ addJob, run, pr }: ReturnType<typeof jobInserts>, prs: number) {
  const open: number[] = [];
  for (let i = 0; i < 250; i++) {
    const t = NOW - 2 * DAY + i * 60_000;
    const status = i < 60 || i >= 180 ? 'queued' : i < 80 ? 'running' : 'done';
    const after = i >= 180 ? open[(i * 13) % open.length] : null;
    const work = addJob({
      created: at(t),
      agent: AGENTS[i % 4],
      title: titleOf(i),
      status,
      finished: status === 'done' ? at(t + HOUR) : null,
      kind: 'work',
      thread: THREADS[i % 30],
      after,
    });
    if (status !== 'queued') run.run(work, at(t), status === 'done' ? at(t + HOUR) : null);
    if (status === 'done') {
      pr.run(++prs, `job/${work}`, 'open', null);
      h.db.prepare('update jobs set pr = ? where id = ?').run(prs, work);
      addJob({
        created: at(t + HOUR),
        agent: 'bolt',
        title: `Review #${prs}`,
        status: 'queued',
        kind: 'review',
        pr: prs,
        branch: `job/${work}`,
        round: 1,
      });
    }
    if (i >= 100 && i < 160) h.db.prepare('insert into waits (job, on_job) values (?, ?)').run(work, open[i - 100]);
    open.push(work);
  }
}

before(async () => {
  await h.capacity({ claude: 4 });
  grow();
  predictions.keepSpotSizes();
});

test("the queue's play at HQ's size, briefs and all, takes well under a second", t => {
  const times = [0, 1].map(() => {
    const start = performance.now();
    const f = forecast.refresh(NOW);
    assert.ok(f.snapshot.jobs.length >= 350 && f.threads.size === 30, `${f.snapshot.jobs.length} jobs`);
    return performance.now() - start;
  });
  // (the faster of two: the first also reads each title's words once, and the machine is shared)
  const fastest = Math.round(Math.min(...times));
  t.diagnostic(`forecast plays: ${times.map(ms => Math.round(ms)).join(', ')} ms`);
  assert.ok(fastest < 1000, `the play took ${fastest} ms`);
});

// One tenth of the worker's one-second claim interval, without ordering.start()'s kept plan.
test("the claim's fresh plan at HQ's size takes under a tenth of its claim interval", t => {
  remember('planning.mode', 'threads');
  for (let i = 0; i < 2; i++) {
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const plan = ordering.current(NOW);
    const ms = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    assert.ok(plan.timings.size >= 350);
    t.diagnostic(`fresh claim plan: ${Math.round(ms)} ms, CPU ${Math.round((cpu.user + cpu.system) / 1000)} ms`);
    assert.ok(ms < 100, `the claim's plan took ${Math.round(ms)} ms`);
  }
});
