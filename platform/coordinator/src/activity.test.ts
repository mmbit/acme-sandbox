// node --test src/activity.test.ts   (hq activity: a job's or an agent's recent activity, as HQ's card shows it)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('activity');
const read = async (token: string, query: string) => await h.call(`/api/agent/activity?${query}`, token, undefined);
const texts = (r: { body: any }) => (r.body.lines as { text: string }[]).map(l => l.text);

test("a running job's activity: its statuses, steps and messages, in order, never the board's words", async () => {
  const lark = await h.start({ agent: 'lark' }),
    other = await h.start({ agent: 'moss' }),
    juno = await h.start({ agent: 'juno' });
  await h.agent('event', lark.token, { type: 'status', state: 'working', text: 'Measuring the book check' });
  await h.agent('event', lark.token, { type: 'log', text: 'Running node book-check.mjs', board: 'Run the book check' });
  await h.agent('event', lark.token, { type: 'log', text: '', board: 'The check is slow on a full machine.' });
  await h.agent('event', lark.token, { type: 'log', text: 'Reading check.mjs' });
  await h.agent('event', other.token, { type: 'log', text: 'Editing a.css' });
  await h.agent('message', lark.token, { to: 'bolt', text: 'The worker is full' });
  const r = await read(juno.token, `job=${lark.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.job.agent, 'lark');
  const lines = texts(r);
  assert.ok(lines.includes('Running node book-check.mjs'));
  assert.ok(lines.includes('Reading check.mjs'));
  assert.ok(lines.includes('To bolt: The worker is full'));
  assert.ok(lines.includes('Working: Measuring the book check'));
  assert.ok(!lines.some(l => /Editing a\.css|Run the book check|full machine/.test(l)), lines.join('\n'));
  assert.ok(lines.indexOf('Running node book-check.mjs') < lines.indexOf('To bolt: The worker is full'));
  // since: only what came after
  const later = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(texts(await read(juno.token, `job=${lark.id}&since=${later}`)), []);
  assert.equal((await read(juno.token, 'job=999999')).status, 404);
  assert.equal((await read(juno.token, 'since=yesterday&job=1')).status, 400);
});

test("an agent's activity reads as its card: its jobs' lines and the messages sent to it, the newest 30", async () => {
  const nib = await h.start({ agent: 'nib' }),
    bolt = await h.start({ agent: 'bolt' });
  for (let i = 0; i < 35; i++) await h.agent('event', nib.token, { type: 'log', text: `Reading f${i}.ts` });
  await h.agent('message', bolt.token, { to: 'nib', text: 'Look at the worker' });
  const r = await read(bolt.token, 'agent=nib');
  const lines = texts(r);
  assert.equal(lines.length, 30);
  assert.equal(lines.at(-1), 'From bolt: Look at the worker');
  assert.ok(!lines.includes('Reading f0.ts') && lines.includes('Reading f34.ts'));
  assert.equal(r.body.lines[0].job, nib.id);
});

test('a call reads it too, as its activity tool does', async () => {
  const pip = await h.start({ agent: 'pylon' });
  await h.agent('event', pip.token, { type: 'log', text: 'Running npm run gates' });
  const { token } = await h.liveCall('juno');
  assert.deepEqual(texts(await read(token, `job=${pip.id}`)).at(-1), 'Running npm run gates');
});

test("events from before they carried their job stay the board's", async () => {
  const kit = await h.start({ agent: 'kit' }),
    bolt = await h.start({ agent: 'bolt' });
  // (a chat row from before the job column: no job to check against a customer mark)
  const old = Number(
    h.db
      .prepare(`insert into events (ts, type, agent, "to", text) values (?, 'chat', 'juno', 'kit', 'Ada paid by card')`)
      .run(new Date().toISOString()).lastInsertRowid,
  );
  h.db.prepare("insert or replace into settings (key, value) values ('events_job_from', ?)").run(String(old + 1));
  await h.agent('event', kit.token, { type: 'log', text: 'Reading a.ts' });
  await h.agent('message', bolt.token, { to: 'kit', text: 'Look at the worker' });
  const lines = texts(await read(bolt.token, 'agent=kit'));
  assert.ok(lines.includes('Reading a.ts') && lines.includes('From bolt: Look at the worker'), lines.join('\n'));
  assert.ok(!lines.some(l => /Ada/.test(l)), lines.join('\n'));
  h.db.prepare("delete from settings where key = 'events_job_from'").run();
});

test("a job's read has the messages it sent, an agent's also those sent to it; an unknown agent is refused", async () => {
  const sender = await h.start({ agent: 'tansy' }),
    getter = await h.start({ agent: 'penny' });
  await h.agent('message', sender.token, { to: 'penny', text: 'The proof is in' });
  assert.ok(!texts(await read(getter.token, `job=${getter.id}`)).some(l => /proof/.test(l)));
  assert.ok(texts(await read(getter.token, 'agent=penny')).includes('From tansy: The proof is in'));
  assert.ok(texts(await read(getter.token, `job=${sender.id}`)).includes('To penny: The proof is in'));
  const unknown = await read(getter.token, 'agent=lrak');
  assert.equal(unknown.status, 404);
});
