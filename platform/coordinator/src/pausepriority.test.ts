// node --test src/pausepriority.test.ts (throwaway DATA_DIR): pause release chains and open reviews cross seat pacing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('pausepriority', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'planning: threads\nprojects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: The shop, owner: moss }\n',
    ),
});
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const pauses = await import('./pauses.ts');
const forecast = await import('./forecast.ts');
const wakes = await import('./wakes.ts');
(await import('./threadends.ts')).watch();
const HOUR = 3_600_000;
let count = 0;
const pendingPrs: number[] = [];
test.afterEach(() => {
  for (const pause of pauses.open())
    pauses.resume(pause.kind === 'thread' ? { thread: pause.target } : { project: pause.target }, 'juno');
  for (const pr of pendingPrs.splice(0)) h.mergedPr(pr);
  h.cancelQueued();
});
function thread(project = 'shop') {
  const opened = projects.createThread({ project, name: `Work ${++count}`, goal: 'It works' });
  assert.equal(typeof opened, 'object');
  return (opened as { id: string }).id;
}
async function review(pr: number, kind: 'review' | 'work' = 'review') {
  pendingPrs.push(pr);
  const build = thread();
  const author = await h.start({ agent: 'moss', thread: build });
  await h.finish(author);
  h.storedPr(pr, author.id, 'open', [], { sha: 'a'.repeat(40), round: 1, since: author.id });
  const round = h.queue({
    agent: kind === 'work' ? 'moss' : 'quill',
    engine: 'codex',
    kind,
    ...(kind === 'work' ? { stage: 'fix' } : {}),
    pr,
    round: 1,
    branch: `job/${author.id}`,
  });
  return { build, author, round };
}
async function paced() {
  await h.capacity({ codex: 1, claude: 1 });
  const reset = Date.now() + 5 * 24 * HOUR;
  assert.equal(
    (
      await h.worker('seat', {
        seat: 'capacity-codex',
        engine: 'codex',
        state: 'ready',
        util: 0.1,
        week: 0.8,
        weekResets: reset,
      })
    ).status,
    200,
  );
  assert.equal((await h.board('/api/seats/pacing', { on: true })).status, 200);
  return { seat: 'capacity-codex', pacedUntil: reset };
}

for (const scope of ['thread', 'project'] as const) {
  test(`a ${scope} pause gives its release chain priority through needs, after, deployment and PR rounds`, async () => {
    h.cancelQueued();
    const { author, round } = await review(scope === 'thread' ? 901 : 902);
    const acceptance = thread(),
      comparison = thread(),
      release = thread(),
      held = thread('game');
    const accept = h.queue({ agent: 'moss', thread: acceptance });
    wakes.hold(accept, [{ kind: 'deployed', arg: String(author.id) }]);
    const compared = h.queue({ agent: 'moss', thread: comparison });
    assert.deepEqual(plan.need(comparison, acceptance, 'moss'), { ok: true });
    const until = h.queue({ agent: 'moss', thread: release, after: compared });
    const waiting = h.queue({ agent: 'kit', thread: held });
    const seat = await paced();
    assert.equal(await h.claim('codex', seat), null, 'the undated review is initially paced');
    const target = scope === 'thread' ? { thread: held } : { project: 'game' };
    const ask = { ...target, why: 'Wait for the comparison', until: [until] };
    assert.equal(typeof pauses.pause(ask, 'juno'), 'object');
    const now = Date.now();
    const urgent = forecast.play(now).usual.get(author.id)!.merged!;
    assert.equal(h.job(waiting).ready, 0, 'the pause still holds its work');
    assert.equal(typeof pauses.resume(target, 'juno'), 'object');
    assert.ok(
      forecast.play(now).usual.get(author.id)!.merged! > urgent,
      'the play advances the review only while the pause holds',
    );
    assert.equal(typeof pauses.pause(ask, 'juno'), 'object');
    const claimed = await h.claim('codex', seat);
    assert.equal(claimed?.id, round, 'the paced seat claims the review that releases the pause');
    await h.finish(claimed!);
    pauses.resume(target, 'juno');
  });
}

test('a pause tied to work already in review gives that PR its priority at the merge endpoint', async () => {
  h.cancelQueued();
  const { author, round } = await review(904);
  const held = thread('game');
  const seat = await paced();
  assert.equal(await h.claim('codex', seat), null);
  assert.equal(typeof pauses.pause({ thread: held, why: 'Wait for the build', until: [author.id] }, 'juno'), 'object');
  const claimed = await h.claim('codex', seat);
  assert.equal(claimed?.id, round);
  await h.finish(claimed!);
  pauses.resume({ thread: held }, 'juno');
});

for (const kind of ['review', 'work'] as const) {
  test(`a done thread with an open PR takes a window by thread, job or PR and its ${kind === 'work' ? 'fix' : 'review'} crosses pacing`, async () => {
    h.cancelQueued();
    const { build, author, round } = await review(kind === 'review' ? 903 : 905, kind);
    assert.deepEqual(plan.done(build, 'moss'), { ok: true });
    const seat = await paced();
    assert.equal(await h.claim('codex', seat), null);
    const giver = await h.start({ agent: 'juno', kind: 'chat' });
    const pacedMerge = forecast.play().usual.get(author.id)!.merged!;
    for (const target of [{ thread: build }, { job: author.id }, { pr: kind === 'review' ? 903 : 905 }]) {
      const changed = await h.agent('window', giver.token, { ...target, deadline: '1m' });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.ok(
        changed.body.misses.some((miss: { thread: string }) => miss.thread === build),
        'an impossible window still reports its missed deadline while the PR is open',
      );
      const now = Date.now();
      assert.ok(forecast.play(now).usual.get(author.id)!.merged! < pacedMerge, 'the saved window advances the review');
    }
    const claimed = await h.claim('codex', seat);
    assert.equal(claimed?.id, round);
    await h.finish(claimed!);
  });
}
