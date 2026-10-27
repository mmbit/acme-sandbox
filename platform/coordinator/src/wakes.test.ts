// node --test src/wakes.test.ts   (hq job --when: work that starts on a deploy, a merge going live or a time instead of a
// job polling for it, and hq stop; the real hq)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { harness, type Running } from './harness.ts';
import type { WakeRow } from './wakes.ts';

const h = await harness('wakes');
const { db } = h;
const wakes = await import('./wakes.ts');

const dir = mkdtempSync(`${tmpdir()}/wakes-files-`);
const running = async (agent: string) => ({ ...(await h.start({ agent })), dir: mkdtempSync(`${dir}/job-`) });
const brief = () => {
  const f = `${dir}/${Math.random().toString(36).slice(2)}.md`;
  writeFileSync(f, 'Read the numbers.');
  return f;
};
const queue = async (job: Running, ...args: string[]) => {
  const r = await h.hq(job, 'job', ...args, brief(), '--new');
  return { ...r, id: Number(/Queued job #(\d+)/.exec(r.out)?.[1]) };
};
// The server's record of a deploy, as infra/deploys.py writes it; each one finishes after everything before it
const DEPLOYS = `${h.dataDir}/deploys`;
mkdirSync(DEPLOYS);
let deploys = 0;
async function deploy(
  o: { sha?: string; ok?: boolean; recreated?: string[]; reloaded?: string[]; fetched?: string } = {},
) {
  await sleep(5);
  const finished = new Date().toISOString(),
    sha = o.sha ?? `${++deploys}`.padStart(7, 'a');
  writeFileSync(
    `${DEPLOYS}/${finished.replace(/[-:.]/g, '')}-${sha}.json`,
    JSON.stringify({
      sha,
      fetched: o.fetched ?? finished,
      finished,
      ok: o.ok ?? true,
      recreated: o.recreated ?? [],
      reloaded: o.reloaded ?? [],
      services: ['caddy', 'coordinator', 'worker'],
    }),
  );
  await sleep(5);
}
// Whether a queued job would start now, after the check every claim makes (at a later time: no route moves the clock)
const ready = (id: number, now = Date.now()) => {
  wakes.check(now);
  return !!h.job(id)?.ready;
};
// The job starts on the next free seat, and reads why in its note (what the worker builds its prompt from)
const starts = async (id: number) => {
  const job = await h.claim(h.job(id).engine);
  assert.equal(job?.id, id);
  await h.finish(job!);
  return job!.note as string;
};
// When the threads' waiting split (threadwaits.ts) dates a job's wake: the end of the deploy its start named, by sha
const datesDeploy = (id: number, sha: string) => {
  const w = db.prepare('select job, kind, arg, since from wakes where job = ?').get(id) as WakeRow;
  const { finished } = db.prepare('select finished from deploys where sha = ?').get(sha) as { finished: string };
  assert.equal(wakes.metAt(w), Date.parse(finished), `metAt dates the deploy that met #${id}'s ${w.kind} wake`);
};

test('--when deploy:2 holds the job until two deploys begun since have finished (a failed one not counted), then it starts and reads what happened', async () => {
  const bolt = await running('bolt');
  const asked = await queue(bolt, '--when', 'deploy:2', 'lark', 'Read the deploys');
  assert.equal(asked.code, 0, asked.out);
  assert.match(asked.out, /deploy:2/);
  const id = asked.id;
  await deploy({ fetched: new Date(Date.now() - 60e3).toISOString() });
  assert.equal(ready(id), false, 'a deploy that fetched main before the job was queued is not one of the next');
  assert.match(
    (await h.hq(bolt, 'jobs', 'lark')).out,
    new RegExp(`#${id} (?:[A-Z]{2,3}-)?[A-Z]{2,8} lark, queued after 2 deploys \\(0 so far\\)`),
  );
  await deploy();
  await deploy({ ok: false });
  assert.equal(ready(id), false, 'one deploy, and one that failed');
  assert.match((await h.hq(bolt, 'jobs', 'lark')).out, /after 2 deploys \(1 so far\)/);
  await deploy({ sha: 'bbbbbbbbb1', recreated: ['coordinator', 'worker'] });
  assert.equal(ready(id), true);
  assert.match(
    await starts(id),
    /starts now: 2 deploys since it was queued, the last: deploy bbbbbbbbb .*\(recreated: coordinator, worker\)/,
  );
  datesDeploy(id, 'bbbbbbbbb1');
  assert.deepEqual(readdirSync(DEPLOYS), [], "each record's file goes once HQ has taken it in");
  await h.finish(bolt);
});

test('--when recreated:<service> waits for a deploy that recreates that container; a reload or another container is not it', async () => {
  const bolt = await running('bolt');
  const { id } = await queue(bolt, '--when', 'recreated:worker', 'bolt', 'After a worker recreate');
  await deploy({ recreated: ['coordinator'], reloaded: ['worker'] });
  assert.equal(ready(id), false);
  await deploy({ sha: 'ccccccc', recreated: ['caddy', 'worker'] });
  assert.equal(ready(id), true);
  assert.match(await starts(id), /a deploy recreated worker: deploy ccccccc/);
  datesDeploy(id, 'ccccccc');
  const typo = await queue(bolt, '--when', 'recreated:workr', 'bolt', 'Typo');
  assert.notEqual(typo.code, 0);
  assert.match(typo.out, /no workr container \(caddy, coordinator, worker\)/);
  await h.finish(bolt);
});

test('--when a time: it starts once the time has come; times past, nonsense and too many deploys are refused', async () => {
  const bolt = await running('bolt');
  const { id } = await queue(bolt, '--when', '2h', 'bolt', 'Later today');
  assert.equal(ready(id), false);
  assert.equal(ready(id, Date.now() + 3600e3), false);
  assert.equal(ready(id, Date.now() + 2.1 * 3600e3), true);
  assert.match(await starts(id), /the time came/);
  for (const when of ['tomorrow', '2020-01-01T00:00Z', 'deploy:0', 'deploy:99', 'recreated:'])
    assert.notEqual((await queue(bolt, '--when', when, 'bolt', 'Never')).code, 0, when);
  assert.notEqual((await h.hq(bolt, 'job', 'bolt', 'x', brief(), '--when')).code, 0, '--when without an event');
  await h.finish(bolt);
});

test('--when deployed:<job> or deployed:pr:<n> waits for that work to merge and a deploy that fetched it; work that never merges lets it start', async () => {
  const bolt = await running('bolt'),
    lark = await running('lark');
  const work = await h.start({ agent: 'lark', title: 'The fix' });
  await h.finish(work, { branch: `job/${work.id}` });
  // the review's record of its pull request (review.test.ts covers how it gets there): opened, later merged
  db.prepare("insert into prs (number, branch, author, status) values (501, ?, 'lark', 'open')").run(`job/${work.id}`);
  const { id } = await queue(bolt, '--when', `deployed:${work.id}`, 'bolt', 'Read it live');
  assert.match(
    (await h.hq(bolt, 'jobs', 'bolt')).out,
    new RegExp(`#${id} (?:[A-Z]{2,3}-)?[A-Z]{2,8} bolt, queued once #${work.id}'s work is merged and deployed`),
  );
  await deploy();
  assert.equal(ready(id), false, 'its pull request is still in review');
  const merged = new Date().toISOString();
  db.prepare("update prs set status = 'merged', merged_at = ? where number = 501").run(merged);
  await deploy({ fetched: new Date(Date.parse(merged) - 60e3).toISOString() });
  assert.equal(ready(id), false, 'a deploy that fetched main before the merge');
  await deploy({ sha: 'ddddddd' });
  assert.equal(ready(id), true);
  assert.match(
    await starts(id),
    new RegExp(`#${work.id}'s work \\(pull request #501, merged .*\\) is deployed: deploy ddddddd`),
  );
  datesDeploy(id, 'ddddddd');
  const byPr = await queue(bolt, '--when', 'deployed:pr:501', 'bolt', 'Already live');
  assert.equal(ready(byPr.id), true, 'merged and deployed before it was queued');
  await starts(byPr.id);

  const { id: dropped } = await queue(lark, 'lark', 'Dropped');
  const never = await queue(bolt, '--when', `deployed:${dropped}`, 'bolt', 'Never live');
  assert.equal(ready(never.id), false);
  assert.equal((await h.hq(lark, 'cancel', String(dropped))).code, 0);
  assert.equal(ready(never.id), true);
  assert.match(
    await starts(never.id),
    new RegExp(`#${dropped}'s work will never deploy: #${dropped} ended \\(cancelled\\) without a pull request`),
  );
  assert.notEqual((await queue(bolt, '--when', 'deployed:pr:9999', 'bolt', 'x')).code, 0, 'no such pull request');
  await h.finish(bolt);
  await h.finish(lark);
});

test('a deployment wake starts with the reason when its source ends stopped without a PR', async () => {
  const source = await running('lark'),
    owner = await running('bolt');
  const waiting = await queue(owner, '--when', `deployed:${source.id}`, 'bolt', 'Read it live');
  assert.equal(waiting.code, 0, waiting.out);
  assert.equal(ready(waiting.id), false);
  assert.equal((await h.hq(source, 'stop', String(source.id), 'The trial needs judgment')).code, 0);
  await h.finish(source, { status: 'stopped' });
  assert.equal(ready(waiting.id), true);
  assert.match(await starts(waiting.id), /ended \(stopped\) without a pull request/);
  await h.finish(owner);
});

test('two --when: it waits for both', async () => {
  const bolt = await running('bolt');
  const { id } = await queue(bolt, '--when', 'deploy', '--when', '1h', 'bolt', 'Both');
  await deploy();
  assert.equal(ready(id), false);
  assert.match(
    (await h.hq(bolt, 'jobs', 'bolt')).out,
    new RegExp(`#${id} (?:[A-Z]{2,3}-)?[A-Z]{2,8} bolt, queued at \\d{4}-.* UTC: Both`),
  );
  assert.equal(ready(id, Date.now() + 3700e3), true);
  assert.match(await starts(id), /a deploy since it was queued.*; the time came/);
  await h.finish(bolt);
});

test('hq stop: its own agent or the CEO ends a running job, which hears it with its heartbeat; a paused one as it starts again', async () => {
  const lark = await running('lark'),
    wren = await running('wren'),
    juno = await running('juno');
  const beat = async (j: Running) => (await h.heartbeat(j)).body;
  assert.deepEqual(await beat(lark), { ok: true });

  const other = await h.hq(wren, 'stop', String(lark.id), 'not mine');
  assert.notEqual(other.code, 0, "another agent's job");
  assert.notEqual((await h.hq(lark, 'stop', String(lark.id))).code, 0, 'no why');

  const own = await h.hq(lark, 'stop', String(lark.id), 'the reading is handed over (hq job --when)');
  assert.equal(own.code, 0, own.out);
  assert.deepEqual(await beat(lark), { ok: true, stop: 'lark: the reading is handed over (hq job --when)' });
  assert.equal((await h.finish(lark, { status: 'stopped', result: 'Stopped by lark' })).status, 200);

  assert.equal((await h.hq(juno, 'stop', String(wren.id), 'polling for a day')).code, 0, 'the CEO');
  assert.equal((await beat(wren)).stop, 'juno: polling for a day');
  // paused (a usage limit) before it heard: the stop comes with its next claim
  await h.finish(wren, { status: 'limited', session: 'sess-1', resetAt: 0 });
  const again = await h.claim(h.job(wren.id).engine);
  assert.equal(again?.id, wren.id);
  assert.equal(again?.stopping, 'juno: polling for a day');
  await h.finish(again!, { status: 'stopped' });
  assert.equal(h.job(wren.id).status, 'stopped');
  const paused = await h.start({ agent: 'juno', title: 'Paused' });
  await h.finish(paused, { status: 'limited', session: 'sess-2', resetAt: Date.now() + 3600e3 });
  assert.match(
    (await h.hq(juno, 'stop', String(paused.id), 'not needed')).out,
    new RegExp(`#${paused.id} is paused: it stops as it starts again`),
  );

  const never = h.queue({ agent: 'juno', title: 'Never ran', after: 999999 });
  assert.match(
    (await h.hq(juno, 'stop', String(never), 'x')).out,
    new RegExp(`#${never} never ran: cancel it instead`),
  );
  assert.notEqual((await h.hq(juno, 'stop', String(lark.id), 'again')).code, 0, 'a job that has ended');
  const review = h.queue({ agent: 'juno', title: 'Review', kind: 'review', after: 999999 });
  assert.notEqual((await h.hq(juno, 'stop', String(review), 'x')).code, 0, "the coordinator's own review, not work");
  await h.finish(juno);
});
