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

test("a long report's turn that holds the thread half a second is named by its part; a wait it ends in is not counted", async () => {
  const turn = latency.turns('a report');
  const busy = (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until);
  };
  busy(520);
  assert.equal(await turn('the slow part', new Promise<number>(r => setTimeout(() => r(7), 600))), 7);
  busy(50);
  await turn('the quick part');
  latency.flush();
  const named = h.db.prepare("select name from slow_holds where name like 'a report:%'").all() as { name: string }[];
  assert.deepEqual(
    named.map(r => r.name),
    ['a report: the slow part'],
  );
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

test('stalls make one queued job, of any cause, on spare room; a started job holds its causes until its work is out', async () => {
  const { stalled } = await import('./stalljobs.ts');
  const jobs = () =>
    h.db
      .prepare(
        "select id, title, prompt, downtime from jobs where prompt like 'HQ''s coordinator stood still%' order by id",
      )
      .all() as {
      id: number;
      title: string;
      prompt: string;
      downtime: number;
    }[];
  const now = Date.now();
  stalled({ name: 'GET /api/work', ms: 2_300 }, 2_300, now);
  stalled({ name: 'GET /api/agent/search', ms: 2_600 }, 2_500, now + 60_000);
  stalled({ name: "the play's parts: played 634 ms (205 jobs)", ms: 2_300 }, 2_300, now + 60_000);
  stalled({ name: "the play's parts: played 612 ms (203 jobs)", ms: 2_400 }, 2_400, now + 120_000);
  const [requests] = jobs();
  assert.deepEqual(
    jobs().map(j => [j.title, j.downtime]),
    [['HQ stood still 2.3 s behind GET /api/work: make it quick', 1]],
    'every cause goes in the one queued job, which waits for spare room',
  );
  assert.match(
    requests.prompt,
    /2\.3 s behind GET \/api\/work\.\n- At .*: 2\.5 s behind GET \/api\/agent\/search\.\n- At .*: 2\.3 s behind the play's parts: played 634 ms \(205 jobs\)\.\n- At .*: 2\.4 s behind the play's parts: played 612 ms \(203 jobs\)\.$/,
  );

  // it waits for its sort into the project it's for, as HQ's other template work: the CEO names it, and it may start.
  assert.notEqual((await h.claim(h.job(requests.id).engine))?.id, requests.id, 'unsorted, it waits');
  const proposals = await import('./proposals.ts'),
    { ceo } = await import('./company.ts');
  const { proposal } = h.db.prepare('select proposal from sorts where job = ?').get(requests.id) as {
    proposal: number;
  };
  const accepted = proposals.accept(proposal, ceo(), {
    size: '30m',
    why: 'Test scope judgment without a comparable completed job',
    title: 'Make HQ quick',
    code: 'HQFAST',
  }) as { job: number };
  assert.equal(accepted.job, requests.id);
  const running = await h.claim(h.job(requests.id).engine, { util: 0.1 });
  assert.equal(running?.id, requests.id, 'sorted, it is claimed on a seat with spare room');
  stalled({ name: 'POST /api/agent/window', ms: 3_300 }, 3_300, now + 180_000);
  stalled({ name: "the play's parts: played 640 ms (206 jobs)", ms: 2_500 }, 2_500, now + 180_000);
  assert.equal(jobs().length, 1, "a started job holds its causes' alarm");
  assert.doesNotMatch(jobs()[0].prompt, /window|640/, 'and its brief, read already, stays as it was');

  assert.equal((await h.finish(running!)).status, 200);
  stalled({ name: "the play's parts: played 650 ms (206 jobs)", ms: 3_100 }, 3_100, now + 240_000);
  stalled({ name: 'tick', ms: 2_200 }, 2_200, now + 240_000);
  assert.deepEqual(
    jobs()
      .slice(1)
      .map(j => j.title),
    ["HQ stood still 3.1 s behind the play's parts: played 650 ms (206 jobs): make it quick"],
    'ended with nothing to deploy, the next stall is a job again, and the next cause joins it',
  );
  assert.match(jobs()[1].prompt, /2\.2 s behind tick\.$/);
});
