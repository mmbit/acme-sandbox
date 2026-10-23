// node --test src/log.test.ts   (a job's own log, as its agent writes it and HQ shows it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('log');
const step = (job: { token: string }, text: string) => h.agent('step', job.token, { text });
const log = async (job: { id: number }) =>
  ((await h.board(`/api/jobs/log?id=${job.id}`)).body as any[]).map(l => l.text);

test("a job's log: its lines in order, redacted, the newest 400 kept, other jobs' apart, old lines gone", async () => {
  const [bolt, moss, nib] = [
    await h.start({ agent: 'bolt' }),
    await h.start({ agent: 'moss' }),
    await h.start({ agent: 'nib' }),
  ];
  await step(bolt, '$ npm test');
  await step(bolt, '$ curl -H "Authorization: Bearer abcdefghijklmnop" x');
  await step(moss, 'Edit a.css');
  await step(bolt, '   ');
  assert.deepEqual(await log(bolt), ['$ npm test', '$ curl -H "Authorization: [redacted]" x']);
  for (let i = 0; i < 410; i++) await step(nib, `step ${i}`);
  const kept = await log(nib);
  assert.deepEqual([kept.length, kept[0]], [400, 'step 10']);
  // a week on (no route moves the clock): moss's lines are old, and the next line written sweeps them
  h.db.prepare('update job_log set ts = ? where job = ?').run('2020-01-01T00:00:00Z', moss.id);
  await step(bolt, 'Write b.md');
  assert.deepEqual(await log(moss), []);
});

test("a job holding a customer's details: the board's HQ gets each step itself, what agents can read only its kind", async () => {
  const juno = await h.start({ agent: 'juno' });
  await step(juno, 'Running a command');
  await h.agent('step', juno.token, { text: 'Running a command', board: '$ hq parcel 12 --card cat:grey' });
  await h.agent('step', juno.token, { text: '', board: 'The order went again, with its card.' });
  await h.agent('event', juno.token, { type: 'log', text: 'Running a command', board: 'Place the order again' });
  await h.agent('event', juno.token, { type: 'chat', to: 'bolt', text: 'Hi', board: 'not a log line' });
  // the board's own view: the job's log and HQ's feed
  assert.deepEqual(await log(juno), [
    'Running a command',
    '$ hq parcel 12 --card cat:grey',
    'The order went again, with its card.',
  ]);
  const feed = (await h.feed()).filter(e => e.agent === 'juno').map(e => e.text);
  assert.deepEqual(feed.slice(-2), ['Place the order again', 'Hi']);
  // what's stored for everything else (the reports read these tables)
  const kept = (sql: string) => (h.db.prepare(sql).all(juno.agent) as { text: string }[]).map(r => r.text);
  assert.deepEqual(kept('select text from job_log where agent = ? order by id'), [
    'Running a command',
    'Running a command',
    '',
  ]);
  assert.deepEqual(kept("select text from events where agent = ? and type in ('log', 'chat') order by id").slice(-2), [
    'Running a command',
    'Hi',
  ]);
});

test("a job handed a customer's details mid-run: its unguarded lines go to the board alone, and the answer says it's marked", async () => {
  const kit = await h.start({ agent: 'kit' });
  const before = await h.agent('step', kit.token, { text: '$ hq mail 7' });
  assert.equal(before.body.customers, false);
  h.db.prepare('update jobs set customers = 1 where id = ?').run(kit.id); // (as readMailAs marks it)
  // lines the worker sent before it heard: a step, a log line, words between steps
  const after = await h.agent('step', kit.token, { text: '$ grep -i "Jane Doe" mail.txt' });
  assert.equal(after.body.customers, true);
  const said = await h.agent('event', kit.token, { type: 'log', text: 'Jane Doe at 12 Elm Street wants a refund.' });
  assert.equal(said.body.customers, true);
  // and from then on, guarded as a job holding them sends its lines
  await h.agent('step', kit.token, { text: 'Running a command', board: '$ cat refund.md', guarded: true });
  // the board's own view keeps every line
  assert.deepEqual(await log(kit), ['$ hq mail 7', '$ grep -i "Jane Doe" mail.txt', '$ cat refund.md']);
  const feed = (await h.feed()).filter(e => e.agent === 'kit').map(e => e.text);
  assert.deepEqual(feed.slice(-1), ['Jane Doe at 12 Elm Street wants a refund.']);
  // what agents' reports read: nothing of what was on its way, the kind of each guarded step
  const kept = (sql: string) => (h.db.prepare(sql).all(kit.agent) as { text: string }[]).map(r => r.text);
  assert.deepEqual(kept('select text from job_log where agent = ? order by id'), [
    '$ hq mail 7',
    '',
    'Running a command',
  ]);
  assert.deepEqual(kept("select text from events where agent = ? and type = 'log' order by id").slice(-1), ['']);
});

test('HQ opens a job by its number past the latest finished that Jobs lists, with its log, and none for a job not there', async () => {
  const old = await h.start({ agent: 'moss' });
  await step(old, 'Write a.md');
  await h.finish(old);
  // (41 more finished since: Jobs lists the latest 40)
  for (let i = 0; i < 41; i++)
    h.db.prepare("update jobs set status = 'done' where id = ?").run(h.queue({ agent: 'nib' }));
  assert.equal(h.job(old.id), undefined);
  const one = async (id: unknown) => (await h.board(`/api/jobs/find?id=${id}`)).body.job;
  assert.deepEqual([(await one(old.id)).agent, (await one(old.id)).status], ['moss', 'done']);
  assert.deepEqual(await log(old), ['Write a.md']);
  assert.deepEqual([await one(99999), await one('x')], [null, null]);
});
