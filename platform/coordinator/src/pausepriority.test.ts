// node --test src/pausepriority.test.ts (throwaway DATA_DIR): pause release chains and open reviews cross seat pacing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('pausepriority', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'projects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: The shop, owner: moss }\n',
    ),
});
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const pauses = await import('./pauses.ts');
const forecast = await import('./forecast.ts');
const wakes = await import('./wakes.ts');
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
async function paced(engine = 'codex') {
  await h.capacity({ codex: 1, claude: 1 });
  const reset = Date.now() + 5 * 24 * HOUR;
  assert.equal(
    (
      await h.worker('seat', {
        seat: `capacity-${engine}`,
        engine,
        state: 'ready',
        util: 0.1,
        week: 0.8,
        weekResets: reset,
      })
    ).status,
    200,
  );
  assert.equal((await h.board('/api/seats/pacing', { on: true })).status, 200);
  return { seat: `capacity-${engine}`, pacedUntil: reset };
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

for (const live of [true, false])
  test(`a PR's findings ${live ? 'carrying a live board item bypass its paced sort' : 'whose board item was dropped keep the ordinary sort'}`, async t => {
    const org = `${h.repo}/company/org.yaml`,
      before = readFileSync(org, 'utf8');
    writeFileSync(org, before + '\nreview:\n  drawWindowedChanges: true\n');
    t.after(() => writeFileSync(org, before));
    const proposals = await import('./proposals.ts');
    const inbox = await import('./reviewinbox.ts');
    const planning = await import('./planning.ts');
    const ledger = await import('./ledger.ts');
    const build = thread();
    const item = h.openItem('moss');
    const author = await h.start({ agent: 'moss', thread: build, item });
    ledger.handedOut(item, author.id, null);
    const branch = `job/${author.id}`;
    const pr = live ? 906 : 907;
    pendingPrs.push(pr);
    h.storedPr(pr, author.id, 'open', ['game.ts'], { round: 1, sha: 'a'.repeat(40), since: author.id });
    await h.finish(author);
    assert.equal(ledger.item(item)!.status, 'ready');
    if (!live) assert.equal(typeof ledger.drop(item, 'The board withdrew it', 0), 'object');
    const sort = planning.planningJob('moss', 'shop');
    const engine = h.jobs.findAgent('moss')!.engine;
    const seat = await paced(engine);
    assert.equal(await h.claim(engine, seat), null, 'the ordinary owner sort is paced');
    const ruling = h.ended({ agent: 'quill', kind: 'consolidate', branch, pr, round: 1 }, 'done', 'changes');
    proposals.deliverFindings({
      ruling,
      pr,
      round: 1,
      branch,
      agent: 'quill',
      decision: 'changes',
      summary: 'The level cannot finish',
      findings: [
        {
          id: 12545,
          domain: 'engine',
          files: ['game.ts'],
          issue: 'The level cannot finish',
          task: 'Let the level finish',
        },
      ],
    });
    const fixes = inbox.tasks(pr, 1);
    if (!live) {
      assert.equal(fixes.length, 0);
      assert.equal(await h.claim(engine, seat), null);
      return;
    }
    assert.equal(fixes.length, 1, 'the author gets a fix without an owner sort');
    assert.equal(h.job(sort).status, 'queued');
    const now = Date.now();
    const pacedPlay = forecast.play(now);
    assert.equal((await h.board('/api/seats/pacing', { on: false })).status, 200);
    const unpacedPlay = forecast.play(now);
    assert.equal((await h.board('/api/seats/pacing', { on: true })).status, 200);
    for (const pace of ['usual', 'slow'] as const) {
      assert.notEqual(pacedPlay[pace].get(fixes[0].id)!.start, null);
      assert.equal(pacedPlay[pace].get(fixes[0].id)!.start, unpacedPlay[pace].get(fixes[0].id)!.start);
      assert.notEqual(pacedPlay[pace].get(author.id)!.merged, null);
      assert.equal(
        pacedPlay[pace].get(author.id)!.merged,
        unpacedPlay[pace].get(author.id)!.merged,
        'pacing adds no wait to the remaining review stages',
      );
    }
    const claimed = await h.claim(engine, seat);
    assert.equal(claimed?.id, fixes[0].id);
    await h.finish(claimed!);
  });

for (const started of [false, true])
  for (const later of [false, true])
    test(`item work joining ${started ? 'a started' : 'an unstarted'} thread keeps ${later ? 'a later ordinary task' : 'its own task'} review unpaced`, async () => {
      h.cancelQueued();
      assert.equal((await h.board('/api/seats/pacing', { on: false })).status, 200);
      const build = thread();
      const first = h.queue({ agent: 'moss', engine: 'codex', thread: build });
      const item = h.openItem('moss');
      const carrier = h.queue({ agent: 'moss', engine: 'codex', thread: build, item });
      const owner = later ? h.queue({ agent: 'moss', engine: 'codex', thread: build }) : carrier;
      if (started) {
        await h.capacity({ codex: 1, claude: 1 });
        const claimed = await h.claim('codex', { seat: 'capacity-codex' });
        assert.equal(claimed?.id, first);
        await h.finish(claimed!, { branch: `job/${first}`, sha: 'a'.repeat(40) });
      }
      assert.equal(h.job(carrier).branch, null, 'the queued carrier has not acquired the thread branch');
      await paced('claude');
      assert.equal(
        (await h.worker('seat', { seat: 'capacity-codex', engine: 'codex', state: 'ready', util: 0, week: 0 })).status,
        200,
      );
      const now = Date.now();
      const { snapshot: queue, sizes } = forecast.play(now);
      const snapshot = { ...queue, jobs: queue.jobs.filter(row => row.thread === build) };
      const { play } = await import('./eta.ts');
      for (const pace of ['usual', 'slow'] as const) {
        const pacedPlay = play(snapshot, sizes[pace], { pace });
        const unpacedPlay = play({ ...snapshot, pacing: false }, sizes[pace], { pace });
        const expected = unpacedPlay.get(owner)!;
        assert.notEqual(expected.merged, null);
        assert.ok(expected.merged! > expected.done!, 'the task has projected review stages');
        assert.equal(pacedPlay.get(owner)!.merged, expected.merged, 'projected stages add no pacing wait');
      }
    });
