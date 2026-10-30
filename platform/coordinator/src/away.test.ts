// node --test src/away.test.ts   (the test company): the CEO's alarm when a lent machine stops asking for work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('away', {
  before: repo =>
    appendFileSync(`${repo}/company/org.yaml`, '\nruns:\n  kinds:\n    tests: {}\n    voice: {}\n    other: {}\n'),
});
const { awayCheck } = await import('./away.ts'); // (what the server runs each minute: here with a time of the test's)
const machines = await import('./machines.ts');

test('one alarm for the CEO once a lent machine that took work is away half an hour, with its kinds and the runs that went without it, shown in hq summary until it asks again', async () => {
  const M = 60_000;
  const lend = async (name: string) => {
    const added = await h.board('/api/machines/add', { name });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    return { id: added.body.id as number, key: /'(helper_[\w-]{43})\\n'/.exec(added.body.keyCommand)![1] };
  };
  const desktop = await lend('The office desktop');
  const alarms = () =>
    (h.jobs.listJobs() as any[]).filter(j => j.agent === 'juno' && /office desktop stopped asking/.test(j.title));
  const ends = () =>
    (h.jobs.listJobs() as any[]).filter(j => j.agent === 'juno' && /office desktop asks for work again/.test(j.title));
  // A helper's ask for work of its kind, as the lent machine's helpers ask, and a run as hq sends it
  const ask = (key: string, kind: string) => h.send('/api/helper/take', { authorization: `Bearer ${key}` }, { kind });
  const job = await h.start({ agent: 'bolt' });
  const send = async (kind: string) => {
    const spec = Buffer.from(JSON.stringify({ command: 'true', kind, cwd: '', bring: [], minutes: 10 }));
    const bundle = execFileSync('tar', ['-czf', '-', '-T', '/dev/null']);
    const sent = await h.send(
      '/api/agent/runs',
      { authorization: `Bearer ${job.token}`, 'x-run': spec.toString('base64url') },
      bundle,
    );
    assert.equal(sent.status, 200, sent.text);
    return sent.json.id as number;
  };
  const seen = () => machines.findMachine(desktop.id)!.seen!;

  awayCheck();
  assert.equal(alarms().length, 0, 'a machine never heard from took no work: no alarm');
  await send('tests');
  assert.ok((await ask(desktop.key, 'tests')).json.id, 'it takes a run');
  assert.equal((await ask(desktop.key, 'voice')).status, 204);
  const since = seen();
  awayCheck(Date.parse(since) + 15 * M);
  assert.equal(alarms().length, 0, 'away a quarter of an hour, as a reboot is: no alarm');
  const withdrawn = await send('tests');
  assert.equal((await h.agent(`runs/${withdrawn}/withdraw`, job.token, {})).status, 200);
  await send('voice');
  await send('other');
  awayCheck(Date.parse(since) + 30 * M);
  const [alarm] = alarms();
  assert.ok(alarm, 'half an hour away: an alarm');
  const brief = (await h.claim('claude'))!;
  assert.equal(brief.id, alarm.id);
  const line = `The office desktop hasn't asked for work since ${since.slice(0, 16).replace('T', ' ')} UTC \\(its tests, voice\\)`;
  assert.match(brief.prompt, new RegExp(`${line}: 2 runs went without it`));
  assert.match(brief.prompt, /Docker/);
  assert.match(brief.prompt, /is your call/);
  const reader = await h.start({ agent: 'juno', title: 'The morning round' });
  const summary = async () => (await h.agent('summary', reader.token)).body.text as string;
  await send('voice');
  const attic = await lend('The attic laptop');
  await send('tests');
  assert.ok((await ask(attic.key, 'tests')).json.id, "another lent machine's run");
  assert.equal((await h.board('/api/machines/remove', { machine: attic.id })).status, 200);
  awayCheck(Date.parse(since) + 45 * M);
  assert.equal(alarms().length, 1, 'still away: the same alarm');
  assert.match(await summary(), new RegExp(`^- ${line}: 3 runs went without it \\(your job #${alarm.id}\\)$`, 'm'));
  assert.ok((await ask(desktop.key, 'voice')).json.id, 'it asks again, and takes a waiting run');
  awayCheck();
  assert.doesNotMatch(await summary(), /hasn't asked for work/, 'it asks again: over');
  assert.equal(ends().length, 1, 'and the CEO hears it is back');
  const back = Date.parse(seen());
  awayCheck(back + M / 2);
  assert.equal(ends().length, 1, 'once');
  await h.finish(brief);
  awayCheck(back + 30 * M);
  assert.equal(alarms().length, 2, 'away half an hour again: a new alarm');
  assert.equal((await h.board('/api/machines/pause', { machine: desktop.id, paused: true })).status, 200);
  awayCheck(back + 40 * M);
  assert.doesNotMatch(await summary(), /hasn't asked for work/, 'the board paused it: over, and no second word of it');
  assert.equal(ends().length, 1);
  assert.deepEqual(
    ((await h.board('/api/requests')).body as any[]).filter(c => /desktop/.test(c.title)),
    [],
    'and the board gets no card',
  );
  await h.finish(reader);
  await h.finish(job);
});
