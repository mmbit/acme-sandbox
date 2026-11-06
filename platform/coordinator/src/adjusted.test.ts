// node --test src/adjusted.test.ts   (uses a throwaway DATA_DIR): a past job's adjusted time beside its measured one,
// written by hq estimate adjust, counted by the picks and shown by hq estimate.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('adjusted');
const predictions = await import('./predictions.ts');
const { pastJobs } = await import('./matching.ts');
const MIN = 60_000,
  HOUR = 60 * MIN,
  T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());
test.afterEach(() => h.cancelQueued());

// kit holds the estimates role here; juno is the CEO
const org = `${h.repo}/company/org.yaml`;
writeFileSync(org, readFileSync(org, 'utf8').replace(/^roles:\n/m, 'roles:\n  estimates: kit\n'));

// Three of kit's harbour jobs, an hour each, a day ago
const harbour = [1, 2, 3].map(n =>
  h.pastJob({ title: `Paint the harbour, part ${n}`, run: { started: T0 - 25 * HOUR, ended: T0 - 24 * HOUR } }),
);
const sized = () => predictions.predict({ title: 'Paint the harbour', origin: 'work', agent: 'kit' }).size.agent_ms;
const run = async (agent: string, stdin: string | undefined, ...args: string[]) =>
  h.hq({ ...(await h.start({ agent, title: 'Weekly estimate check' })), stdin }, 'estimate', ...args);

test('only the estimates role and the CEO adjust a past job, a done one, with a reason', async () => {
  const other = await run('bolt', undefined, 'adjust', String(harbour[0]), '30m', 'the book check is gone');
  assert.notEqual(other.code, 0);
  assert.match(other.out, /estimates role .* or the CEO/);
  const queued = h.queue({ agent: 'kit', title: 'Paint the harbour again' });
  assert.match((await run('kit', undefined, 'adjust', String(queued), '30m', 'x')).out, /only a done job/);
  assert.match((await run('kit', undefined, 'adjust', String(harbour[0]), '30m', ' ')).out, /give job #\d+'s reason/);
  assert.equal(sized(), HOUR, 'nothing adjusted');
});

test('an adjusted job counts at its adjusted time in the picks, and keeps its measurement', async () => {
  const why = 'the half-hour book check is no gate since 4 Nov';
  const done = await run('kit', undefined, 'adjust', `#${harbour[0]}`, '30m', why);
  assert.equal(done.code, 0, done.out);
  assert.equal(sized(), 50 * MIN, 'the mean of 30, 60 and 60 minutes');
  const job = pastJobs().find(j => j.id === harbour[0])!;
  assert.deepEqual(
    [Math.round(job.agent_ms), job.adjusted?.agent_ms, job.adjusted?.why, job.adjusted?.by],
    [HOUR, 30 * MIN, why, 'kit'],
  );
  // hq estimate shows both, and its JSON gives both
  const shown = await run('bolt', undefined, 'Paint the harbour');
  assert.match(shown.out, new RegExp(`Measured 1 h(our)?, now about 30 min: ${why} \\(kit, `));
  const asked = await h.agent('estimate?q=Paint%20the%20harbour', (await h.start({ agent: 'bolt' })).token);
  const listed = (asked.body as any).jobs.find((j: any) => j.id === harbour[0]);
  assert.deepEqual([listed.agent_minutes, listed.adjusted.agent_minutes, listed.adjusted.by], [60, 30, 'kit']);
});

test('the CEO adjusts several at once, each with its own reason; a later one counts, and none withdraws it', async () => {
  const list = JSON.stringify([
    { job: harbour[1], time: '45m', why: 'its review round ran the old gate' },
    { job: harbour[2], time: '40m', why: 'the tests now run on the lent machine' },
  ]);
  const done = await run('juno', list, 'adjust', '-');
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /Adjusted 2 past jobs/);
  assert.equal(sized(), ((30 + 45 + 40) / 3) * MIN);
  assert.equal((await run('kit', undefined, 'adjust', String(harbour[0]), 'none', 'measured again')).code, 0);
  assert.equal(sized(), ((60 + 45 + 40) / 3) * MIN);
  const rows = h.db.prepare('select agent_ms from adjusted_times where job = ? order by id').all(harbour[0]);
  assert.deepEqual(
    rows.map(r => r.agent_ms),
    [30 * MIN, null],
    'the history stays',
  );
  assert.equal(pastJobs().find(j => j.id === harbour[0])!.adjusted, null);
});
