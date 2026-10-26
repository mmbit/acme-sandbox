// node --test src/noseat.test.ts   (work for an agent no seat runs, the test company's Poppy on `engine: api`, is refused
// where it's made, in words the caller acts on)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const h = await harness('noseat');
const { db, jobs, voice } = h;
const poppys = () => (db.prepare("select count(*) n from jobs where agent = 'poppy'").get() as { n: number }).n;
const brief = `${mkdtempSync(`${tmpdir()}/noseat-`)}/brief`;
writeFileSync(brief, 'Test every support path before the launch.');
const SAYS =
  /no job runs as poppy: Poppy runs on api, which no seat runs, so it would never start\. Give the work to a colleague who takes jobs/;

test('hq job for an agent no seat runs queues nothing and says why', async () => {
  const juno = await h.start({ agent: 'juno' });
  const r = await h.hq(juno, 'job', 'poppy', 'Test every support path', brief);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`No job was queued: ${SAYS.source}`));
  assert.equal(poppys(), 0);
  // the same words wherever a job is made, and none for work that names its engine or isn't work
  assert.throws(() => jobs.createJob({ agent: 'poppy', title: 'x', prompt: 'x' }), SAYS);
  assert.ok(jobs.createJob({ agent: 'poppy', title: 'x', prompt: 'x', engine: 'claude' }).id);
  assert.ok(jobs.createJob({ agent: 'poppy', title: 'x', prompt: 'x', kind: 'review' }).id);
  assert.ok(jobs.createJob({ agent: 'kit', title: 'x', prompt: 'x' }).id, 'an agent a seat runs');
  db.prepare("delete from jobs where agent = 'poppy'").run();
  await h.finish(juno);
});

test("a call agent's job tool hears the refusal while the board is on the line", async () => {
  const opened = await voice('call-context', { agent: 'juno', lang: 'en' });
  assert.equal(opened.status, 200);
  const ctx = opened.body as { token: string };
  // the real hq as the voice line runs it for the job tool (hq_tools.py job): on a call, the brief on stdin
  const hq = new URL('../../worker/bin/hq', import.meta.url).pathname;
  const r = await new Promise<{ code: number; err: string }>(resolve => {
    const child = execFile(
      'bash',
      [
        hq,
        'job',
        'poppy',
        'Test every support path',
        '-',
        '--code',
        'SUPPORT',
        '--size',
        '30m',
        '--why',
        'Check all support paths',
      ],
      { env: { PATH: process.env.PATH, HQ_URL: h.base, HQ_TOKEN: ctx.token, HQ_AGENT: 'juno', HQ_CALL: '1' } },
      (e, _out, err) => resolve({ code: e ? Number(e.code) : 0, err }),
    );
    child.stdin!.end('Test every support path before the launch.');
  });
  assert.equal(r.code, 1); // (hq_tools.py hands an exit 1 "No job was queued" to the agent as it is)
  assert.match(r.err, new RegExp(`^No job was queued: ${SAYS.source}`));
  assert.equal(poppys(), 0);
  await voice('call-end', { agent: 'juno', lines: [], token: ctx.token });
});

test('hq say that would become a job for one sends nothing', async () => {
  const juno = await h.start({ agent: 'juno' });
  const r = await h.hq(juno, 'say', 'poppy', 'Can you test the support paths?');
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`hq say: ${SAYS.source}.*Nothing was sent\\.`));
  assert.equal((db.prepare("select count(*) n from messages where recipient = 'poppy'").get() as { n: number }).n, 0);
  assert.equal(poppys(), 0);
  await h.finish(juno);
});

test("a call with one isn't followed up: the board hears so at once", async () => {
  const opened = await voice('call-context', { agent: 'poppy', lang: 'en' });
  assert.equal(opened.status, 200);
  const ctx = opened.body as { call: number; token: string };
  const ended = await voice('call-end', {
    agent: 'poppy',
    lines: ['Board: Check the refunds page.'],
    token: ctx.token,
  });
  assert.equal(ended.status, 200);
  assert.equal(
    (db.prepare('select status from calls where id = ?').get(ctx.call) as { status: string }).status,
    'failed',
  );
  assert.equal(poppys(), 0);
  const told = db
    .prepare("select text from events where type = 'log' and text like 'Call with Poppy%' order by id desc")
    .get() as { text: string };
  assert.match(told.text, /Poppy doesn't take jobs, so nobody follows it up/);
});
