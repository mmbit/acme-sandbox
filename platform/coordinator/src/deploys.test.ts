// node --test src/deploys.test.ts   (the real coordinator and the worker's handback.ts)
// A deploy recreates the coordinator and the worker together, so a stopping worker's own report can't arrive.
// The next worker hands its runs back instead, and they resume in their sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness, WORKER_TOKEN } from './harness.ts';
import { commitFile } from './fixture.ts';
import { handBack, noteHandBacks } from '../../worker/src/handback.ts';
import { ResponseError } from '../../worker/src/reports.ts';

const h = await harness('deploys');

// The worker's api(): a coordinator that isn't up yet (still being recreated) is a fetch that throws a TypeError, and
// one that answers with an error status throws it.
let up = true;
const down = createServer().listen(0);
const nowhere = `http://localhost:${(down.address() as AddressInfo).port}`;
down.close();
const finish = async (body: unknown) => {
  const res = await fetch(`${up ? h.base : nowhere}/api/worker/finish`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${WORKER_TOKEN}`, 'content-type': 'application/json' },
  });
  if (!res.ok) throw new ResponseError('finish', res.status);
  return res.json();
};
const file = `${h.dataDir}/handback.json`,
  lines: string[] = [];
const log = (...a: unknown[]) => lines.push(a.join(' '));
const comesUp = async () => {
  up = true;
}; // handBack's wait between tries: the coordinator is up by the next one
const handBackAll = () => handBack(file, finish, log, comesUp);
const claim = async (engine: string) => (await h.claim(engine, { seat: 'claude-1' }))!;
// A deploy: the worker is stopped (SIGTERM) while the coordinator is being recreated, and comes back after a while.
const deploy = (job: number, session: string, more = {}) => {
  noteHandBacks(file, [{ job, seat: 'claude-1', session, ...more }]);
  up = false;
};

test('five deploys in a row cut a job off, and it resumes in its session every time', async () => {
  const id = h.queue({ agent: 'kit', engine: 'gift', title: 'Gift-season ad card' });
  for (let i = 1; i <= 5; i++) {
    const j = await claim('gift');
    if (i > 1) assert.equal(j.session, 's-1', `run ${i} resumes in the session`);
    deploy(id, 's-1');
    await handBackAll();
    assert.deepEqual([h.job(id).status, h.job(id).attempts], ['queued', 0], `deploy ${i}: handed back`);
    assert.ok(!existsSync(file), 'nothing left to hand back');
  }
});

test('a run cancelled while the worker was away is let go, and the others still go back', async () => {
  const a = h.queue({ agent: 'kit', engine: 'a', title: 'Cancelled meanwhile' });
  const b = h.queue({ agent: 'kit', engine: 'b', title: 'Still wanted' });
  await claim('a');
  await claim('b');
  deploy(a, 's-a');
  deploy(b, 's-b'); // a second stop adds to what the first left
  // (no route cancels a running job: the coordinator's own drops do, review.ts's)
  h.db.prepare("update jobs set status = 'cancelled' where id = ?").run(a);
  await handBackAll();
  assert.equal(h.job(a).status, 'cancelled');
  assert.deepEqual([h.job(b).status, h.job(b).attempts], ['queued', 0]);
  assert.equal((await claim('b')).session, 's-b');
  assert.ok(lines.some(l => l.startsWith(`job #${a}: not handed back`)));
  assert.ok(!existsSync(file));
});

test("a stop that cut a job's own processes tells its next run which, once; a cut without any says nothing", async () => {
  const id = h.queue({ agent: 'kit', engine: 'render', title: 'Rendering the trailer' });
  await claim('render');
  const render = 'ffmpeg -i frames/%04d.png -c:v libx264 trailer.mp4 (running 12 min)';
  deploy(id, 's-r', { lost: [render], lostAt: '2026-10-12T13:45:12.000Z' });
  await handBackAll();
  const next = await claim('render');
  assert.equal(next.session, 's-r');
  assert.match(next.cut ?? '', /running at 12 Oct, 15:45 and were stopped when the worker's container was restarted/);
  assert.ok(next.cut?.includes(`\n- ${render}\n`), 'the process, word for word');
  // cut again with nothing of its own running (or a list it can't read): no note, and the last one isn't told twice
  for (const lost of [undefined, 'not a list']) {
    deploy(id, 's-r', { lost });
    await handBackAll();
    assert.equal((await claim('render')).cut, null);
  }
});

test('a handed-back run ends at its cut, not when its report arrives', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = h.queue({ agent: 'kit', engine: 'cut', title: 'A cut run' });
  await claim('cut');
  t.mock.timers.tick(30_000);
  const lostAt = new Date().toISOString();
  deploy(id, 's-cut', { lostAt });
  t.mock.timers.tick(60_000); // the restart's downtime
  await handBackAll();
  const run = h.db.prepare('select ended from runs where job = ?').get(id) as { ended: string };
  assert.equal(run.ended, lostAt);
});

// ---- after a deploy, an open HQ hears what changed in its files (main.js checkHealth: the renovated toast)
test("an open HQ hears what changed in HQ's files since the checkout it loaded from, newest first, and nothing else", async () => {
  commitFile('company/notes.md', 'x', 'The test company starts');
  const { head } = await (await fetch(`${h.base}/health`)).json();
  assert.match(head, /^[0-9a-f]{40}$/);
  commitFile('theme/hq/logo.svg', '<svg/>', 'HQ: the new logo');
  commitFile('company/notes.md', 'y', 'A note, not HQ');
  commitFile('kits/desk/hq/app.js', '1', 'The desk phone: a notice card');
  assert.deepEqual((await h.board(`/api/hq/changes?since=${head}`)).body.changes, [
    'The desk phone: a notice card',
    'HQ: the new logo',
  ]);
  assert.deepEqual((await h.board('/api/hq/changes?since=main')).body.changes, [], 'only a commit');
});
