// node --test src/keptpool.test.ts   (throwaway DATA_DIR and the test company): the done jobs an estimate stands on are
// kept, read again only where their rows changed, and always as a whole read gives them, whatever trigger code an
// earlier version left in the database, read ahead in slices at a start or not, and ahead for a caller that can wait
// where it would be read whole.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('keptpool');
const { db } = h;
const matching = await import('./matching.ts');
const { keptPool } = await import('./keptpool.ts');
const { inOneStep } = await import('./db.ts');
const { recordUsage } = await import('./usage.ts');
const { runStarted } = await import('./agenttime.ts');
const { tick } = await import('./schedule.ts');
const { handOver } = await import('./call.ts');

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
const T = Date.now();
mock.timers.enable({ apis: ['Date'], now: T });
test.after(() => mock.timers.reset());
writeFileSync(
  `${h.repo}/company/schedule.yaml`,
  '- { id: tidy, agent: lark, at: "Sat 03:00", title: Tidy the notes, prompt: x }',
);

const ids = () => (db.prepare('select id from jobs').all() as { id: number }[]).map(r => r.id);
// (a read of every job by id: the same rows by another path than the kept pool's)
const same = (pastJobs = matching.pastJobs) => assert.deepEqual(pastJobs(), pastJobs(ids()));
const [a, b, c] = ['Paint the harbour', 'Glaze the tiles', 'Box the prints'].map((title, i) =>
  h.pastJob({ title, merged: T - DAY, run: { started: T - (2 + i) * HOUR, ended: T - (1 + i) * HOUR } }),
);

test('the done jobs are read again only where their rows changed, and always as a whole read gives them', () => {
  const { pastJobs } = matching;
  const first = pastJobs();
  assert.equal(pastJobs(), first);
  same();

  db.prepare("update jobs set title = 'Paint the old harbour' where id = ?").run(a);
  const changed = pastJobs();
  assert.equal(
    changed.find(j => j.id === b),
    first.find(j => j.id === b),
  );
  same();

  // each kind of change it's read from, made as HQ makes it: usage, a pull request closed unmerged, a run under way, a
  // scheduled run, a replacement link (as a job is queued, and on a done job), a credential call
  const changes = [
    () =>
      recordUsage({
        job: b,
        engine: 'claude',
        usage: { models: { 'claude-opus-5-5': { input: 1, output: 1 } }, cost: 2.5 },
      }),
    () => db.prepare("update prs set status = 'closed', merged_at = null where branch = ?").run(`job/${c}`),
    () => runStarted(c, 'claude-a'),
    () => tick(new Date('2026-10-17T01:30:00Z')), // (03:30 on a Saturday in Amsterdam)
    () => h.queue({ agent: 'kit', title: 'Glaze the tiles again', queuedBy: 'juno', insteadOf: [b, a] }),
    () => db.prepare('insert into job_replacements (job, replaces) values (?, ?)').run(b, a),
    () => {
      const card = h.jobs.createRequest({ agent: 'kit', kind: 'credential', title: 'A key', body: 'The key' });
      handOver('kit', ['board: here it is'], (card as { id: number }).id);
    },
  ];
  for (const change of changes) {
    const before = pastJobs();
    change();
    assert.notEqual(pastJobs(), before);
    same();
  }

  // a column set to the value it had notes nothing, so the pool is the same one (a push sent back sets its pull
  // request's same files)
  const unchanged = pastJobs();
  db.prepare('update prs set files = files where branch = ?').run(`job/${c}`);
  db.prepare('update jobs set title = title where id = ?').run(a);
  assert.equal(pastJobs(), unchanged);

  // a job no longer done
  db.prepare("update jobs set status = 'failed' where id = ?").run(a);
  assert.ok(!pastJobs().some(j => j.id === a));
  same();

  // a change in a step rolled back leaves the pool as it was
  const kept = pastJobs();
  assert.throws(() =>
    inOneStep(() => {
      db.prepare("update jobs set title = 'Box the old prints' where id = ?").run(b);
      assert.equal(pastJobs().find(j => j.id === b)!.title, 'Box the old prints');
      throw new Error('undone');
    }),
  );
  assert.equal(pastJobs().find(j => j.id === b)!.title, kept.find(j => j.id === b)!.title);
  same();

  // a pool older than the changes still noted is read whole
  pastJobs();
  db.prepare("update jobs set title = 'Glaze the blue tiles' where id = ?").run(b);
  db.exec('delete from past_changes');
  db.prepare("update jobs set engine = 'codex' where id = ?").run(c);
  assert.equal(pastJobs().find(j => j.id === b)!.title, 'Glaze the blue tiles');
});

test("a trigger an earlier version made, blind to a column the read takes now, is made again before it's trusted", async () => {
  // (the version before: its triggers on jobs and on pull requests saw no title and no status)
  db.exec(`drop trigger past_jobs_changed;
    create trigger past_jobs_changed after update of id, agent on jobs for each row begin
      insert into past_changes (job) values (new.id);
    end;
    drop trigger past_prs_changed;
    create trigger past_prs_changed after update of number, branch on prs for each row begin
      insert into past_changes (job) values (null);
    end`);
  const restarted = './matching.ts?restart';
  const { pastJobs } = (await import(restarted)) as typeof matching;
  pastJobs();
  db.prepare("update jobs set title = 'Glaze the tiles once more' where id = ?").run(b);
  assert.equal(pastJobs().find(j => j.id === b)!.title, 'Glaze the tiles once more');
  same(pastJobs);
  db.prepare("update prs set status = 'closed', merged_at = null where branch = ?").run(`job/${b}`);
  same(pastJobs);

  // made as their code stands, a whole read again leaves them be
  const version = () => (db.prepare('pragma schema_version').get() as { schema_version: number }).schema_version,
    was = version();
  db.exec('delete from past_changes');
  db.prepare("update jobs set engine = 'codex' where id = ?").run(b);
  pastJobs();
  assert.equal(version(), was);
});

test("the start's read ahead, a slice at a time, is the whole read's, and a change during the slicing is read again", async () => {
  // more than two slices of done work. The reviews among them are runs the pool leaves out.
  for (let i = 0; i < 1100; i++) {
    const ended = T - DAY + i * 60_000;
    h.pastJob({ title: `Paint tile ${i}`, run: { started: ended - 10 * 60_000, ended } });
    if (i % 3 === 0) h.pastJob({ kind: 'review', title: `Review tile ${i}`, run: { started: ended - 60_000, ended } });
  }
  const fresh = './matching.ts?ahead',
    started = (await import(fresh)) as typeof matching;
  const ahead = await started.readPastAhead();
  assert.ok(ahead.length > 1100);
  assert.equal(started.pastJobs(), ahead, 'the first call reads none of it again');
  same(started.pastJobs);

  // The read ahead reads its first slice before it yields. b's row is in that slice and changes after it. A new job is
  // done meanwhile.
  const later = './matching.ts?again',
    again = (await import(later)) as typeof matching,
    reading = again.readPastAhead();
  db.prepare("update jobs set title = 'Glaze the tiles at dusk' where id = ?").run(b);
  const late = h.pastJob({ title: 'Box the late prints', run: { started: T - HOUR, ended: T } });
  await reading;
  assert.equal(again.pastJobs().find(j => j.id === b)!.title, 'Glaze the tiles at dusk');
  assert.ok(again.pastJobs().some(j => j.id === late));
  same(again.pastJobs);
});

test('a caller that can wait reads the pool ahead only where pool() would read it whole', async () => {
  const read = (only?: number[]) =>
    (only
      ? db.prepare('select id, title from jobs where id in (select value from json_each(?))').all(JSON.stringify(only))
      : db.prepare('select id, title from jobs').all()) as { id: number; title: string }[];
  // (a job titled Anywhere is noted as any job's change)
  const probe = keptPool('wholeprobe', () => 'select id, title from jobs', read, {
    jobs: { of: row => `select iif(${row}.title = 'Anywhere', null, ${row}.id)` },
  });
  assert.ok(probe.whole(), 'none kept yet');
  probe.pool();
  assert.ok(!probe.whole());
  db.prepare("update jobs set title = 'Glaze the tiles again' where id = ?").run(b);
  assert.ok(!probe.whole(), "one job's change is read alone");
  db.prepare("update jobs set title = 'Anywhere' where id = ?").run(c);
  assert.ok(probe.whole());
  probe.pool();
  assert.ok(!probe.whole());

  const fresh = './matching.ts?soon',
    soon = (await import(fresh)) as typeof matching;
  assert.deepEqual(await soon.pastJobsSoon(), soon.pastJobs(ids()));
  assert.equal(await soon.pastJobsSoon(), soon.pastJobs(), 'then the kept pool');
});

test('a read that takes a table its notes leave out is refused, so no change to it goes unnoted', () => {
  const read = (only?: number[]) => (only ? [] : (db.prepare('select id from jobs').all() as { id: number }[]));
  assert.throws(
    () =>
      keptPool('probe', () => 'select j.id, p.status from jobs j join prs p', read, {
        jobs: { of: () => 'select null' },
      }).pool(),
    /prs/,
  );
  assert.throws(
    () =>
      keptPool('probe', () => 'select id from jobs', read, {
        jobs: { of: () => 'select null' },
        prs: { of: () => 'select null' },
      }).pool(),
    /prs/,
  );
});
