// node --test src/matching.test.ts   (throwaway DATA_DIR and the test company): a scheduled job is sized on its own
// entry's earlier runs, else its routine's, else the title matching without its slot; other work is matched as it was.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('matching');
const { db } = h;
const { tick } = await import('./schedule.ts');
const predictions = await import('./predictions.ts');
const accuracy = await import('./accuracy.ts');

const MINUTE = 60_000,
  DAY = 24 * 60 * MINUTE;
const T = Date.now();

// (shared/ is this repo's own: its refactoring routine)
writeFileSync(
  `${h.repo}/company/schedule.yaml`,
  [
    '- { id: refactor-hq, agent: lark, at: "Sat 03:00", title: Refactoring pass (HQ), routine: refactoring }',
    '- { id: refactor-voice, agent: pylon, at: "Sat 03:00", title: Refactoring pass (voice), routine: refactoring }',
    '- { id: tidy, agent: lark, at: "Sat 03:00", title: Tidy the HQ notes, prompt: x }',
  ].join('\n'),
);
const SATURDAY = new Date('2026-10-17T01:30:00Z'); // 03:30 in Amsterdam

// A done job of `agent`'s, `days` ago, of `minutes` of agent time: work an agent queued, or HQ's own (no queued_by), or a
// scheduled entry's run.
let made = 0;
function done(agent: string, title: string, minutes: number, run?: { entry: string; routine?: string; slot: string }) {
  const ended = T - DAY + ++made * MINUTE,
    started = ended - minutes * MINUTE;
  const id = h.pastJob({
    agent,
    title,
    created: started - MINUTE,
    run: { started, ended },
    queued_by: run ? null : 'juno',
  });
  if (run)
    db.prepare('insert into schedule_runs (id, slot, job, routine) values (?, ?, ?, ?)').run(
      run.entry,
      run.slot,
      id,
      run.routine ?? null,
    );
  return id;
}
// HQ's own small jobs of lark's (a message, a late ping, call ledger work), whose titles share "HQ" and October's date
const hqOwn = (agent: string) =>
  [
    'Message from bolt: the HQ panel, 2026-10-15',
    'Running late: HQ sign-in (2026-10-13)',
    'The board on: HQ calls, 2026-10-10',
  ].map(title =>
    h.pastJob({
      agent,
      title,
      queued_by: null,
      finished: T - 2 * DAY + MINUTE,
      run: { started: T - 2 * DAY, ended: T - 2 * DAY + 2 * MINUTE },
    }),
  );

// The job the schedule made for an entry this Saturday, and the size the sweep stored for it.
const scheduled = (entry: string) =>
  (db.prepare('select job from schedule_runs where id = ? and slot = ?').get(entry, '2026-10-17') as { job: number })
    .job;
const storedFor = (job: number) => {
  predictions.sweep();
  return predictions.stored(job)!;
};

// (and the threads the schedule moved those runs into, whose job ids the next test's runs take again)
beforeEach(() =>
  db.exec(
    'delete from jobs; delete from runs; delete from predictions; delete from schedule_runs; delete from threads',
  ),
);

test("a scheduled job is sized on its own entry's earlier runs, whoever ran them, not on HQ's small jobs", async () => {
  hqOwn('lark');
  const runs = [
    done('juno', 'Refactoring pass (HQ) (2026-09-26)', 25, {
      entry: 'refactor-hq',
      routine: 'refactoring',
      slot: '2026-09-26',
    }),
    done('lark', 'Refactoring pass (HQ) (2026-10-03)', 13, {
      entry: 'refactor-hq',
      routine: 'refactoring',
      slot: '2026-10-03',
    }),
    done('lark', 'Refactoring pass (HQ) (2026-10-10)', 19, {
      entry: 'refactor-hq',
      routine: 'refactoring',
      slot: '2026-10-10',
    }),
  ];
  tick(SATURDAY);
  const job = scheduled('refactor-hq');
  const { size, picks, basis } = storedFor(job);
  assert.deepEqual(
    picks.map(p => p.id),
    [...runs].reverse(),
    'the newest first',
  );
  assert.deepEqual(basis, { kind: 'hq', agent: null, words: [], entry: 'refactor-hq' });
  assert.equal(size.agent_ms, 19 * MINUTE, 'the mean of 25, 13 and 19 minutes');

  const reader = await h.start({ agent: 'bolt', title: 'Sizing' });
  const { out } = await h.hq(reader, 'estimate', `#${job}`);
  assert.match(out, /19 min of agent time.*\(the mean of 3 earlier runs of this entry \(refactor-hq\)\)/);
});

test("an entry with too few runs stands on its routine's entries, its own first; with too few of those, on the matching without its slot", async () => {
  hqOwn('pylon');
  const voice = done('pylon', 'Refactoring pass (voice) (2026-10-03)', 30, {
    entry: 'refactor-voice',
    routine: 'refactoring',
    slot: '2026-10-03',
  });
  const hq = [
    done('lark', 'Refactoring pass (HQ) (2026-10-03)', 13, {
      entry: 'refactor-hq',
      routine: 'refactoring',
      slot: '2026-10-03',
    }),
    done('lark', 'Refactoring pass (HQ) (2026-10-10)', 19, {
      entry: 'refactor-hq',
      routine: 'refactoring',
      slot: '2026-10-10',
    }),
  ];
  done('lark', 'Tidy the HQ notes (2026-10-10)', 12, { entry: 'tidy', slot: '2026-10-10' });
  tick(SATURDAY);
  const routine = storedFor(scheduled('refactor-voice'));
  assert.deepEqual(
    routine.picks.map(p => p.id),
    [voice, hq[1], hq[0]],
  );
  assert.deepEqual(routine.basis, { kind: 'hq', agent: null, words: [], routine: 'refactoring' });

  // an entry with no routine and one run: the matching, over HQ's jobs of lark's, and never on the slot's date
  const matched = storedFor(scheduled('tidy'));
  assert.equal(matched.basis.entry, undefined);
  assert.equal(matched.basis.routine, undefined);
  assert.deepEqual(matched.basis.words, ['tidy', 'hq', 'notes']);
  assert.ok(!matched.basis.words.some(w => /\d/.test(w)));
});

test('a job whose title ends in a date and that no schedule made is matched as before, its date words and all', async () => {
  const parcels = [
    done('dex', 'Test parcel (2026-10-11)', 8),
    done('dex', 'Test parcel (2026-10-12)', 10),
    done('dex', 'Test parcel (2026-10-13)', 12),
    done('dex', 'Shop copy for the 2026 catalogue', 30),
  ];
  const job = h.queue({ agent: 'dex', title: 'Test parcel (2026-10-18)', queuedBy: 'juno' });
  const { basis, picks, size } = storedFor(job);
  assert.deepEqual(basis, { kind: 'work', agent: 'dex', words: ['test', 'parcel', '2026', '10'] });
  assert.deepEqual(picks.map(p => p.id).sort(), parcels.sort());
  assert.equal(size.agent_ms, 15 * MINUTE);

  // hq estimate --accuracy: the rest sized as before, the matching alone and HQ's way now alike
  const report = accuracy.report({ days: 7 }) as any;
  const rest = report.matching_by_schedule.rest;
  assert.deepEqual(rest.now, rest.matching_alone);
  assert.equal(report.matching_by_schedule.scheduled.jobs, 0);
});

test("a title in the board's German is matched on its own words, its small words aside", async () => {
  done('dex', 'Die Speisekarte im Laden', 25);
  done('dex', 'Der Newsletter für die Woche', 40);
  const job = h.queue({ agent: 'dex', title: 'Die Speisekarte für den Laden und das Menü', queuedBy: 'juno' });
  assert.deepEqual(storedFor(job).basis.words, ['speisekarte', 'laden']); // (für is in the newsletter's title too)
});
