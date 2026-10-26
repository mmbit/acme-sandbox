// node --test src/latency.test.ts: each /api request's time is kept, a minute at a time, for infra/report.sh's section on
// HQ's speed (which reads route_times itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { harness } from './harness.ts';

const h = await harness('latency');
const latency = await import('./latency.ts');

test("each /api request's time is in route_times for the report, by its route, the live feed and HQ's pages left out", async () => {
  await h.board('/api/me');
  await h.board('/api/jobs/log?id=12');
  await h.board('/api/review/notes?slug=front');
  await h.board('/');
  const feed = new AbortController();
  await fetch(`${h.base}/api/events`, { headers: { cookie: h.boardCookie }, signal: feed.signal });
  feed.abort();
  latency.flush();
  const kept = h.db.prepare('select route, ms from route_times order by rowid').all() as {
    route: string;
    ms: number;
  }[];
  assert.deepEqual(
    kept.map(r => r.route),
    ['GET /api/me', 'GET /api/jobs/log', 'GET /api/review/notes'],
  );
  assert.ok(kept.every(r => r.ms >= 0));
});

test("a hold never waits for an outside reader of hq.db and survives a failed minute's write", () => {
  const reader = new DatabaseSync(`${h.dataDir}/hq.db`, { readOnly: true });
  reader.exec('begin');
  reader.prepare('select count(*) from jobs').get(); // (its read lock, kept until the commit)
  const t = performance.now();
  latency.held('a slow step', 600);
  const ms = performance.now() - t;
  assert.ok(ms < 200, `held() took ${Math.round(ms)} ms`);
  try {
    assert.throws(() => latency.flush(), /database is locked/);
  } finally {
    reader.exec('commit');
    reader.close();
  }
  const holds = () =>
    (h.db.prepare("select ms from slow_holds where name = 'a slow step'").all() as { ms: number }[]).map(r => r.ms);
  assert.deepEqual(holds(), []);
  latency.flush();
  assert.deepEqual(holds(), [600]);
  latency.flush();
  assert.deepEqual(holds(), [600], 'the recovered hold is written once');
});

test('a request target the URL parser rejects is answered with a 500 and HQ stays up; a path nobody signed in for is not kept', async () => {
  const raw = (target: string) =>
    new Promise<string>(resolve => {
      const socket = connect(Number(new URL(h.base).port), '127.0.0.1', () =>
        socket.write(`GET ${target} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`),
      );
      let answer = '';
      socket.on('data', chunk => (answer += chunk)).on('close', () => resolve(answer));
    });
  assert.match(await raw('//'), /^HTTP\/1\.1 500/);
  await fetch(`${h.base}/api/synthetic/unknown-path-text`);
  await h.board('/api/me');
  latency.flush();
  const routes = (h.db.prepare('select route from route_times').all() as { route: string }[]).map(r => r.route);
  assert.ok(!routes.some(r => r.includes('synthetic')));
  assert.ok(routes.includes('GET /api/me'));
});

test('a maximum keeps its first observation and resets with the minute', async t => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  latency.start();
  // Let the real runtime sensor start before blocking the loop and observing its delay.
  await pause();
  await pause();
  const stallUntil = performance.now() + 300;
  while (performance.now() < stallUntil);
  await pause();
  t.mock.timers.tick(50);
  const firstObserved = Date.now();
  // No event loop turn occurs between these observations, so the sensor's maximum cannot change.
  t.mock.timers.tick(500);
  latency.flush();
  const minute = h.db.prepare('select max, worst_at from loop_delays order by at desc limit 1').get() as {
    max: number;
    worst_at: number;
  };
  assert.ok(minute.max >= 250);
  assert.equal(minute.worst_at, firstObserved);
  await pause();
  await pause();
  t.mock.timers.tick(50);
  latency.flush();
  const next = h.db.prepare('select max, worst_at from loop_delays order by at desc limit 1').get() as typeof minute;
  assert.equal(next.worst_at, Date.now(), 'the next minute starts with a fresh maximum');
});

test('a stall names the hold that explains it: not a long poll that only waited, nothing when no hold does', () => {
  const step = { name: 'POST /api/agent/jobs', ms: 31_000 },
    poll = { name: 'GET /api/helper/runs', ms: 60_000 };
  assert.deepEqual(latency.stalledBy(30_900, [poll, step]), step);
  assert.equal(latency.stalledBy(1_500, [step]), undefined, 'under STALL_MS is no stall');
  assert.equal(latency.stalledBy(5_000, [{ name: 'GET /api/me', ms: 40 }]), undefined, 'the machine was short of CPU');
});

test('a stall is one job per cause: every request one cause, a step without its numbers another; a started job holds the alarm until its work is out', async () => {
  const { stalled } = await import('./stalljobs.ts');
  const jobs = () =>
    h.db.prepare("select id, title, prompt from jobs where title like 'HQ stood still%' order by id").all() as {
      id: number;
      title: string;
      prompt: string;
    }[];
  const now = Date.now();
  stalled({ name: 'GET /api/work', ms: 2_300 }, 2_300, now);
  stalled({ name: 'GET /api/agent/search', ms: 2_600 }, 2_500, now + 60_000);
  stalled({ name: "the play's parts: played 634 ms (205 jobs)", ms: 2_300 }, 2_300, now + 60_000);
  stalled({ name: "the play's parts: played 612 ms (203 jobs)", ms: 2_400 }, 2_400, now + 120_000);
  const [requests, play] = jobs();
  assert.deepEqual(
    jobs().map(j => j.title),
    [
      'HQ stood still 2.3 s behind GET /api/work: make it quick',
      "HQ stood still 2.3 s behind the play's parts: played 634 ms (205 jobs): make it quick",
    ],
  );
  assert.match(requests.prompt, /2\.3 s behind GET \/api\/work\.\n- At .*: 2\.5 s behind GET \/api\/agent\/search\.$/);
  assert.match(play.prompt, /played 612 ms \(203 jobs\)\.$/);

  const running = await h.claim(h.job(requests.id).engine);
  assert.equal(running?.id, requests.id, 'the first cause is claimed first');
  stalled({ name: 'POST /api/agent/window', ms: 3_300 }, 3_300, now + 180_000);
  assert.equal(jobs().length, 2, 'a started job holds the alarm');
  assert.doesNotMatch(jobs()[0].prompt, /window/, 'and its brief, read already, stays as it was');

  assert.equal((await h.finish(running!)).status, 200);
  stalled({ name: 'GET /api/projects', ms: 3_100 }, 3_100, now + 240_000);
  assert.equal(
    jobs().at(-1)!.title,
    'HQ stood still 3.1 s behind GET /api/projects: make it quick',
    'ended with nothing to deploy, the next stall is a job again',
  );
});
