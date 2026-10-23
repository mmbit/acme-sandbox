// node --test src/triage.test.ts   (the test company's Hello made live; the test writes the scanner's snapshot. daily() is
// what the server runs every few minutes, here at a time of the test's)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

// Hello is live and takes orders: the board approved its launch. Lark owns it. Bolt is the process role.
const HELLO = 'name: Hello\nstatus: live\nowner: lark\npartner_env: live\nneeds:\n  secrets: [stripe]\n';
const h = await harness('triage', {
  env: { PUBLIC_HOST: 'hq.example.test' },
  before: repo => writeFileSync(`${repo}/products/hello/product.yaml`, HELLO),
});
const { daily } = await import('./watch.ts');
const lark = await h.start({ agent: 'lark' });
const launch = await h.ask(lark, { kind: 'approval', approves: 'live:hello' });
assert.equal((await h.answer(launch, '', { approve: true })).status, 200);

// The test company's clock is Amsterdam's, on summer time in October until the 25th
const at = (day: string, time = '07:30') => Date.parse(`${day}T${time}:00+02:00`);
const jobsFor = (agent: string) =>
  (h.jobs.listJobs() as any[]).filter(j => j.agent === agent && j.id !== lark.id).sort((a, b) => a.id - b.id);
// a job's brief, as its run gets it (the worker claims the queue's jobs until it's this one's turn)
const runs = new Map<number, Running>();
const run = async (id: number) => {
  while (!runs.has(id)) {
    const j = await h.claim('claude');
    assert.ok(j, `job #${id} is claimed`);
    runs.set(j.id, j);
  }
  return runs.get(id)!;
};
const brief = async (id: number) => (await run(id)).prompt as string;
type Kinds = Record<string, { first: string; last: string; n: number }>;
const snapshot = (when: string, apps: Record<string, Kinds>) =>
  writeFileSync(`${h.dataDir}/app-errors.json`, JSON.stringify({ at: when, apps }));

test('the error scan: a missing snapshot is a job and a retry, a late one still counts, a kind in triage waits, and one still there after its triage is back', async () => {
  const triage = () => jobsFor('lark'),
    behind = () => jobsFor('bolt');
  const typeError = (first: string, last: string) => ({ 'TypeError in src/server.ts (handle)': { first, last, n: 4 } });

  daily(at('2026-10-06'));
  daily(at('2026-10-06', '08:00'));
  assert.equal(behind().length, 1, 'once a day');
  assert.match(behind()[0].title, /app-errors\.json is missing/);
  snapshot('2026-10-06T06:00:00+00:00', { hello: typeError('2026-10-06T06:00:00+00:00', '2026-10-06T06:00:00+00:00') });
  daily(at('2026-10-06', '08:30'));
  assert.equal(triage().length, 1, 'the scan went again once the snapshot came');
  assert.match(triage()[0].title, /Hello\b.*\b1 kind/);
  assert.match(await brief(triage()[0].id), /TypeError in src\/server\.ts \(handle\), 4 times/);

  // The 7th's scan reads the 05:00 snapshot. The scanner's next run took from 05:29 to past the scan to write its own.
  snapshot('2026-10-07T05:00:00+00:00', { hello: typeError('2026-10-06T06:00:00+00:00', '2026-10-07T05:00:00+00:00') });
  daily(at('2026-10-07'));
  snapshot('2026-10-07T05:29:00+00:00', {
    hello: {
      ...typeError('2026-10-06T06:00:00+00:00', '2026-10-07T05:29:00+00:00'),
      'RangeError in src/mix.ts (blend)': {
        first: '2026-10-07T05:29:00+00:00',
        last: '2026-10-07T05:29:00+00:00',
        n: 1,
      },
    },
  });
  daily(at('2026-10-08'));
  assert.equal(triage().length, 2);
  const second = await brief(triage()[1].id);
  assert.match(second, /RangeError in src\/mix\.ts \(blend\)/);
  assert.doesNotMatch(second, /TypeError/, 'a kind still in triage waits for it');
  assert.equal(behind().length, 2, 'the 8th: a snapshot 26 hours old is behind too');

  await h.finish(await run(triage()[0].id), { result: 'Fixed the handler.' }); // (back now: the scan's days run before it)
  snapshot('2026-10-10T05:00:00+00:00', { hello: typeError('2026-10-06T06:00:00+00:00', '2026-10-10T05:00:00+00:00') });
  daily(at('2026-10-10'));
  assert.equal(triage().length, 2, 'days after its triage, the fix may not be deployed yet');
  snapshot('2026-11-17T06:00:00+00:00', { hello: typeError('2026-11-17T06:00:00+00:00', '2026-11-17T06:00:00+00:00') });
  daily(at('2026-11-17', '09:00')); // winter time: 08:00 on the company's clock
  assert.equal(triage().length, 3);
  assert.match(await brief(triage()[2].id), /TypeError in src\/server\.ts \(handle\)/);
});

test("the support chat's server errors are the process role's to triage", async () => {
  const [lark, bolt] = [jobsFor('lark').length, jobsFor('bolt').length];
  const kind = { first: '2026-11-18T06:00:00+00:00', last: '2026-11-18T06:00:00+00:00', n: 2 };
  snapshot('2026-11-18T06:00:00+00:00', { care: { 'TypeError in platform/care/src/chat.ts (reply)': kind } });
  daily(at('2026-11-18', '08:30'));
  assert.equal(jobsFor('lark').length, lark);
  assert.equal(jobsFor('bolt').length, bolt + 1);
  assert.match(await brief(jobsFor('bolt').at(-1).id), /TypeError in platform\/care\/src\/chat\.ts \(reply\), 2 times/);
});

test("org.yaml's roles.triage takes every app's server errors and Care's", async () => {
  const org = `${h.repo}/company/org.yaml`,
    chart = readFileSync(org, 'utf8');
  writeFileSync(org, chart.replace(/^roles:\n/m, 'roles:\n  triage: dex\n'));
  const [lark, bolt, dex] = [jobsFor('lark').length, jobsFor('bolt').length, jobsFor('dex').length];
  const kind = { first: '2026-11-19T06:00:00+00:00', last: '2026-11-19T06:00:00+00:00', n: 1 };
  snapshot('2026-11-19T06:00:00+00:00', {
    hello: { 'SyntaxError in src/parse.ts (read)': kind },
    care: { 'RangeError in platform/care/src/chat.ts (trim)': kind },
  });
  daily(at('2026-11-19', '08:30'));
  writeFileSync(org, chart);
  assert.deepEqual([jobsFor('lark').length, jobsFor('bolt').length], [lark, bolt]);
  const triageJobs = jobsFor('dex').slice(dex);
  assert.equal(triageJobs.length, 2);
  const briefs: string[] = [];
  for (const job of triageJobs) briefs.push(await brief(job.id));
  assert.ok(briefs.some(text => text.includes('SyntaxError in src/parse.ts (read)')));
  assert.ok(briefs.some(text => text.includes('RangeError in platform/care/src/chat.ts (trim)')));
});
