// node --test src/stalls.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('stalls', { serve: false });
const { db, jobs } = h;
const { stallSweep, stalled, STALLED_FOR_MS } = await import('./stalls.ts');
const { ceo } = await import('./company.ts');
const { remember, setting } = await import('./db.ts');

const MIN = 60_000;
const reset = () => {
  db.exec(
    "delete from jobs; delete from runs; delete from seats; delete from seat_list; delete from settings where key like 'stall.%' or key = 'company.paused'",
  );
  db.prepare(
    "insert into seats (id, engine, state, until) values ('codex-1', 'codex', 'ready', 0), ('claude-1', 'claude', 'ready', 0)",
  ).run();
};
const codexWork = () =>
  jobs.createJob({ agent: 'bolt', title: 'A Codex review', prompt: 'x', engine: 'codex', kind: 'review' }).id;
// The summary's lines, and HQ's jobs for the CEO: there are none
const told = () => stalled();
const ceoJobs = () => db.prepare('select id from jobs where agent = ?').all(ceo());
const spell = () => JSON.parse(setting('stall.codex') ?? 'null');

test('a ready Codex seat whose waiting work starts nothing for 15 minutes is a line in the summary, and no job', () => {
  reset();
  codexWork();
  const t = Date.now();
  stallSweep(t);
  assert.equal(spell().since, t);
  stallSweep(t + STALLED_FOR_MS - MIN);
  assert.equal(told().length, 0);
  stallSweep(t + STALLED_FOR_MS);
  assert.equal(told().length, 1);
  assert.match(told()[0], /^Codex has started nothing for 15 min/);
  assert.deepEqual(ceoJobs(), []);
  assert.match(
    spell().line,
    /^Codex has started nothing for 15 min .*codex-1 ready, 1 job ready for it, none running\.$/,
  );
  stallSweep(t + STALLED_FOR_MS + MIN);
  assert.equal(told().length, 1); // one line a spell
  assert.match(spell().line, /for 16 min/);
});

test('a job of the engine starting ends the spell', () => {
  reset();
  codexWork();
  codexWork();
  const t = Date.now();
  stallSweep(t - 20 * MIN);
  jobs.claim('codex-1', 'codex');
  stallSweep(t);
  assert.equal(spell(), null);
  assert.equal(told().length, 0);
});

test('one that started and ended between two sweeps starts the spell over', () => {
  reset();
  codexWork();
  const id = codexWork(),
    t = Date.now();
  stallSweep(t - 20 * MIN);
  db.prepare("insert into runs (job, seat, started, ended) values (?, 'codex-1', ?, ?)").run(
    id,
    new Date(t - MIN).toISOString(),
    new Date(t - MIN).toISOString(),
  );
  stallSweep(t);
  assert.equal(spell().since, t);
  assert.equal(told().length, 0);
});

test("no spell for paused work, a paused or unavailable seat, or work that isn't ready", () => {
  reset();
  jobs.createJob({ agent: 'bolt', title: 'Ordinary work', prompt: 'x', engine: 'codex' });
  db.prepare("insert into seat_list (id, provider, paused, added) values ('codex-1', 'openai', 1, 'now')").run();
  stallSweep();
  assert.equal(spell(), null);
  db.exec("delete from seat_list; update seats set state = 'sleeping', until = 9e15 where id = 'codex-1'");
  stallSweep();
  assert.equal(spell(), null);
  db.exec("update seats set state = 'ready', until = 0");
  remember('company.paused', JSON.stringify({ since: new Date().toISOString() }));
  stallSweep();
  assert.equal(spell(), null);
  remember('company.paused', null);
  db.exec('update jobs set not_before = 9e15');
  stallSweep();
  assert.equal(spell(), null);
  db.exec('update jobs set not_before = 0, downtime = 1'); // (downtime work waits for spare capacity by design)
  stallSweep();
  assert.equal(spell(), null);
});

test('a company pause still alarms for stalled reviews and consolidations of a pull request it names, and for work it names', () => {
  for (const kind of ['review', 'consolidate', 'work'] as const) {
    reset();
    jobs.createJob({ agent: 'bolt', title: 'Paused work', prompt: 'x', engine: 'codex' });
    const pr = kind === 'work' ? undefined : 9;
    const { id } = jobs.createJob({ agent: 'bolt', title: 'Allowed work', prompt: 'x', engine: 'codex', kind, pr });
    remember(
      'company.paused',
      JSON.stringify({ since: new Date().toISOString(), allow: kind === 'work' ? [id] : [], prs: pr ? [pr] : [] }),
    );
    const t = Date.now();
    stallSweep(t);
    assert.deepEqual(spell(), { since: t });
    stallSweep(t + STALLED_FOR_MS);
    assert.equal(told().length, 1);
    assert.match(spell().line, /1 job ready for it/);
    assert.equal(jobs.claim('codex-1', 'codex')?.id, id);
  }
});

// Whether any ready seat's own claim starts a job, paced as the worker sends it. This claims the job.
const startsAny = () =>
  (
    db.prepare("select id, iif(pace is null, null, week_resets) until from seats where state = 'ready'").all() as {
      id: string;
      until: number | null;
    }[]
  ).some(s => jobs.claim(s.id, 'codex', undefined, 1, false, undefined, undefined, s.until ?? undefined));
const WEEK_RESETS = Date.now() + 2 * 24 * 3600_000;

test('work pinned to a paced seat that can wait for its reset is not waiting, though another seat is unpaced', () => {
  reset();
  jobs.setSeat('codex-1', 'codex', 'ready', 0, undefined, { week: 0.6, weekResets: WEEK_RESETS, pace: true });
  jobs.setSeat('codex-2', 'codex', 'ready', 0);
  jobs.createJob({
    agent: 'bolt',
    title: 'A review',
    prompt: 'x',
    engine: 'codex',
    kind: 'review',
    forSeat: 'codex-1',
  });
  stallSweep();
  assert.equal(spell(), null);
  assert.equal(startsAny(), false);
});

test('work for a CLI no ready seat runs is not waiting', () => {
  reset();
  jobs.createJob({ agent: 'bolt', title: 'A review', prompt: 'x', engine: 'codex', kind: 'review', cli: 'vibe' });
  stallSweep();
  assert.equal(spell(), null);
  assert.equal(startsAny(), false);
  db.exec("update seats set cli = 'vibe' where id = 'codex-1'");
  stallSweep();
  assert.notEqual(spell(), null);
});

test("a paced seat's work that must start before its weekly reset is waiting, and undated work isn't", () => {
  reset();
  jobs.setSeat('codex-1', 'codex', 'ready', 0, undefined, { week: 0.6, weekResets: WEEK_RESETS, pace: true });
  jobs.createJob({ agent: 'bolt', title: 'Undated work', prompt: 'x', engine: 'codex' });
  stallSweep();
  assert.equal(spell(), null);
  jobs.createJob({
    agent: 'bolt',
    title: 'Due work',
    prompt: 'x',
    engine: 'codex',
    thread: h.dueThread({ deadline: Date.now() + 3600_000 }),
  });
  stallSweep();
  assert.notEqual(spell(), null);
  assert.equal(startsAny(), true);
});
