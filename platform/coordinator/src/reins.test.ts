// node --test src/reins.test.ts   (uses a throwaway DATA_DIR): each job is held to its share of HQ's time, so jobs past
// theirs can't keep the board (or anyone else) from an answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hqReports } from '../../worker/src/reports.ts';
import { harness, WORKER_TOKEN } from './harness.ts';

const h = await harness('reins');
const reins = await import('./reins.ts');

test("jobs joining or leaving while a job's time drains change its share from then on, not what it drained", () => {
  // (played first, its clock well before the next test's, which plays before the server's clock now)
  const start = performance.now() - 30 * 60_000,
    heavy = 900_001,
    others = Array.from({ length: 13 }, (_, i) => heavy + 1 + i);
  // Alone, its share is half of HQ: it drains 30 s of time to 0.5 s in 59 s, within the minute's 30 s
  reins.spend(heavy, 30_000, start);
  assert.equal(reins.heldFor(heavy, start + 59_000), 0);
  // Thirteen more jobs ask: its share is a fourteenth of half from now on, and 2 s more puts it past by 0.36 s
  for (const job of others) reins.spend(job, 0, start + 59_000);
  assert.equal(reins.heldFor(heavy, start + 59_000), 0, 'jobs joining brought back time it had drained');
  reins.spend(heavy, 2_000, start + 59_000);
  const share = 0.5 / 14;
  assert.ok(Math.abs(reins.heldFor(heavy, start + 59_000) - (2_500 - 60_000 * share) / share) < 1);
  // The thirteen leave the minute at 119 s, and it drains at half of HQ again from then on only
  reins.spend(heavy, 40_000, start + 100_000);
  const level = 2_500 - 41_000 * share + 40_000 - 19_000 * share - 11_000 * 0.5;
  const held = reins.heldFor(heavy, start + 130_000);
  assert.ok(Math.abs(held - (level - 30_000) / 0.5) < 1, `held ${held} ms: jobs leaving erased time it hadn't drained`);
});

test('a job leaving the minute at a fractional clock reading stops counting at its exact expiry', async () => {
  // A reading where (seen + 60 s) - 60 s rounds below seen, as about one in 80 do: the stretch from its expiry must drain
  // at the share without it. Only readings above zero round so, and in a fresh process the clocks this file plays are
  // below zero: the case plays on its own copy of the reins, so the shared one's clock stays where the next test starts.
  const own: typeof reins = await import(new URL('./reins.ts?expiry', import.meta.url).href);
  const at = 96.421893,
    job = 900_101,
    leaving = 900_102;
  own.spend(job, 60_000, at - 0.1);
  own.spend(leaving, 0, at);
  own.spend(job, 0, at + 58_999.9);
  // 60 s drains a tenth of a ms at half, 60 s at a quarter with the other, then 30 s at half again: back to its 30 s
  assert.equal(own.heldFor(job, at + 89_999.9), 0, 'a job that had left the minute still counted');
});

test("fourteen runs whose every request holds HQ 3.5 s take half of it, and the board's requests are answered", () => {
  // HQ's one event loop, played on a clock of its own a tenth of a second at a time. Each job asks again as soon as it's
  // answered, and its request goes in line once the reins let it (a held one is still asking, as the server's wait has
  // it). The board asks every second. The line is served in order, one request at a time.
  const COST_MS = 3_500,
    STEP_MS = 100,
    PLAYED_MS = 10 * 60_000,
    SETTLED_MS = 2 * 60_000;
  // (played ending well before the server's clock now, so its jobs are long gone by the next test)
  const start = performance.now() - 2 * PLAYED_MS;
  const answeredAt = new Map(Array.from({ length: 14 }, (_, i) => [1_000_001 + i, 0]));
  const line: number[] = [],
    boardWaits: number[] = [];
  let loopFree = 0,
    jobsMs = 0;
  for (let t = 0; t < PLAYED_MS; t += STEP_MS) {
    for (const [job, at] of answeredAt) {
      if (at > t || line.includes(job)) continue;
      if (reins.heldFor(job, start + t) === 0) line.push(job);
      else reins.spend(job, 0, start + t);
    }
    if (t % 1_000 === 0 && t >= SETTLED_MS) boardWaits.push(Math.max(0, loopFree - t) + line.length * COST_MS);
    while (loopFree <= t && line.length) {
      const job = line.shift()!;
      reins.spend(job, COST_MS, start + t);
      if (t >= SETTLED_MS) jobsMs += COST_MS;
      loopFree = t + COST_MS;
      answeredAt.set(job, loopFree);
    }
  }
  const jobsShare = jobsMs / (PLAYED_MS - SETTLED_MS);
  assert.ok(jobsShare <= 0.55, `the jobs took ${Math.round(jobsShare * 100)}% of HQ`);
  const sorted = boardWaits.sort((a, b) => a - b),
    median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median < COST_MS, `half the board's requests waited ${median} ms or more`);
  assert.ok(sorted.at(-1)! <= 3 * COST_MS, `a board request waited ${sorted.at(-1)} ms`);
});

test("fourteen runs' heartbeats, once a minute whether or not the last was answered, take half of HQ and don't pile up", () => {
  // The worker's ownRun beats every minute, answered or not, and the server never holds a beat (its lease would lapse),
  // so each goes in line at once and is served in order. A beat whose job is past its share keeps its lease and hears a
  // pause or room yield from the kept room (a few ms); its window check's replay, 3.5 s here, waits for a beat within the
  // share (jobs.ts heartbeat's reined).
  const COST_MS = 3_500,
    LEASE_MS = 5,
    STEP_MS = 100,
    PLAYED_MS = 7 * 60_000,
    SETTLED_MS = 2 * 60_000;
  // (once the test before's jobs have left the minute, and ending over a minute before the server's clock now)
  const start = performance.now() - PLAYED_MS - 80_000;
  const runs = Array.from({ length: 14 }, (_, i) => ({ job: 2_000_001 + i, beatsAt: i * 4_100 }));
  const line: number[] = [];
  let loopFree = 0,
    jobsMs = 0,
    longest = 0;
  for (let t = 0; t < PLAYED_MS; t += STEP_MS) {
    for (const run of runs) if (t % 60_000 === run.beatsAt) line.push(run.job);
    longest = Math.max(longest, line.length);
    while (loopFree <= t && line.length) {
      const job = line.shift()!,
        ms = reins.heldFor(job, start + t) > 0 ? LEASE_MS : COST_MS;
      reins.spend(job, ms, start + t);
      if (t >= SETTLED_MS) jobsMs += ms;
      loopFree = t + ms;
    }
  }
  const jobsShare = jobsMs / (PLAYED_MS - SETTLED_MS);
  assert.ok(jobsShare <= 0.55, `the runs' heartbeats took ${Math.round(jobsShare * 100)}% of HQ`);
  assert.ok(longest <= runs.length, `${longest} heartbeats were waiting at once`);
});

test("a job past its share is held and told (its run's heartbeat is not), the board and others answered at once", async () => {
  const heavy = await h.start({ agent: 'moss' }),
    light = await h.start({ agent: 'wren' });
  const room = (job: { token: string }) => h.send('/api/agent/room', { authorization: `Bearer ${job.token}` });
  const timed = async <T>(ask: () => Promise<T>) => {
    const start = Date.now(),
      answer = await ask();
    return { ms: Date.now() - start, answer };
  };
  assert.equal((await room(heavy)).headers['x-hq-rein'], undefined, 'a job within its share is told nothing');
  await room(light);

  // Its share, with two jobs asking: half of HQ between them, a quarter of each minute. Past it by 0.4 s, it waits
  // that long at its share before its next request goes in.
  reins.spend(heavy.id, 60_000 / 4 + 400);
  const held = timed(() => room(heavy));
  const [board, other] = await Promise.all([timed(() => h.board('/api/me')), timed(() => room(light))]);
  assert.ok(board.ms < 500 && other.ms < 500, `the board waited ${board.ms} ms, the other job ${other.ms} ms`);
  assert.equal(other.answer.headers['x-hq-rein'], undefined);
  const { ms, answer } = await held;
  assert.equal(answer.status, 200);
  assert.ok(ms >= 1_000, `the heavy job's request went in after ${ms} ms`);
  assert.match(String(answer.headers['x-hq-rein']), /^HQ held this call [\d.]+ s\. Job #\d+ has taken/);

  // Its run's heartbeat goes in at once and keeps its lease, and the beat's window check waits for one within its share
  reins.spend(heavy.id, 400);
  h.db.prepare('update jobs set heartbeat = 0 where id = ?').run(heavy.id);
  const beat = await timed(() => h.heartbeat(heavy));
  assert.equal(beat.answer.status, 200);
  assert.ok(beat.ms < 500, `its run's heartbeat was answered after ${beat.ms} ms`);
  assert.deepEqual(beat.answer.body, { ok: true, reined: true });
  assert.ok(
    (h.db.prepare('select heartbeat from jobs where id = ?').get(heavy.id) as { heartbeat: number }).heartbeat > 0,
  );
  assert.equal((await h.heartbeat(light)).body.reined, undefined, "a job within its share's beat does all its work");
});

test("a job past its share still hears its beat's pause and room yields", async () => {
  // (no route pauses the company: pause.test.ts)
  const paused = (on: boolean) =>
    on
      ? h.db
          .prepare("insert or replace into settings (key, value) values ('company.paused', ?)")
          .run(JSON.stringify({ since: 'now', allow: [] }))
      : h.db.prepare("delete from settings where key = 'company.paused'").run();
  // A seat ready for the work that waits, so it waits for the room the heavy job's slot holds (downtime.test.ts)
  assert.equal(
    (await h.worker('seat', { seat: 'ready-claude', engine: 'claude', state: 'ready', util: 0 })).status,
    200,
  );
  const heavy = await h.start(
    { agent: 'moss', engine: 'claude', title: 'Refactoring pass', downtime: true },
    { util: 0.2 },
  );
  reins.spend(heavy.id, 10 * 60_000);
  assert.deepEqual((await h.heartbeat(heavy, { util: 0.3 })).body, { ok: true, reined: true });
  paused(true);
  assert.deepEqual((await h.heartbeat(heavy, { util: 0.3 })).body, { ok: true, yield: 'paused' });
  paused(false);
  const waiter = h.queue({ agent: 'wren', engine: 'claude', title: 'Sprint work' });
  assert.deepEqual((await h.heartbeat(heavy, { util: 0.3, short: true })).body, { ok: true, yield: 'waiting' });
  assert.ok((await import('./ledger.ts')).cancelJob(waiter, 'by wren: not needed'));
  assert.ok(reins.heldFor(heavy.id) > 0, 'still past its share');
});

test("a job far past its share hears HQ before its caller gives up: a blocked report's 5 s, an hq call's 30 s", async () => {
  const job = await h.start({ agent: 'mies' });
  reins.spend(job.id, 10 * 60_000);
  const timed = async <T>(ask: () => Promise<T>) => {
    const start = Date.now(),
      answer = await ask();
    return { ms: Date.now() - start, answer };
  };
  // Both at once: the report doesn't wait behind the call held longer in the job's line
  const [report, call] = await Promise.all([
    timed(() =>
      hqReports(h.base, WORKER_TOKEN).blocked({
        job: job.id,
        event: randomUUID(),
        measure: 'memory',
        used: 3100,
        share: 2560,
        command: 'node render.mjs',
      }),
    ),
    timed(() => h.hq(job, 'status', 'rendering')),
  ]);
  assert.match(String(report.answer.text), /^HQ's worker stopped this command/);
  assert.ok(report.ms >= 2_000 && report.ms < 5_000, `the blocked report was answered after ${report.ms} ms`);
  assert.equal(call.answer.code, 0, call.answer.out);
  assert.match(call.answer.out, /^hq: HQ held this call 1\d\.\d s\. Job #\d+ has taken/);
  assert.ok(call.ms < 30_000, `the hq call was answered after ${call.ms} ms`);
});

test("a job's request is spent its work after each await, not its waits, nor work outside it", async () => {
  const job = 3_000_001;
  const busy = (ms: number) => {
    for (const end = performance.now() + ms; performance.now() < end;);
  };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // A search's way: it awaits its model and vectors first, and only then ranks
  const search = async () => {
    await sleep(300);
    busy(200);
    await Promise.resolve().then(() => busy(200));
    await sleep(300);
    return 'ranked';
  };
  // Past its share, so its answer tells what it has taken
  reins.spend(job, 10 * 60_000);
  const taken = () => Number(/has taken ([\d.]+) s/.exec(reins.words(job, 0)!)![1]) * 1000;
  const before = taken(),
    start = performance.now();
  const [answer] = await Promise.all([reins.charged(job, search), (async () => (await sleep(100), busy(300)))()]);
  const drained = (performance.now() - start) * 0.5;
  assert.equal(answer, 'ranked');
  const spent = taken() - before;
  assert.ok(spent >= 400 - drained - 100, `the job was spent ${spent} ms for 400 ms of work after its awaits`);
  assert.ok(spent <= 400 + 100, `the job was spent ${spent} ms: its 600 ms of waits or the other's 300 ms with it`);
});
