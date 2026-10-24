// node --test src/reviewplan.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness, until } from './harness.ts';
import { play } from './eta.ts';
import { resetReviewInbox, completeTriage, leftoverJobs } from './reviewfixture.ts';

const h = await harness('reviewplan');
const { snapshot } = await import('./backlog.ts');
const jobs = await import('./jobs.ts');
const MINUTE = 60_000;

function forecast(pr: number, extra: number[] = []) {
  const input = snapshot(Date.now());
  input.jobs = input.jobs.filter(row => row.pr === pr || row.review?.pr === pr || extra.includes(row.id));
  const sizes = new Map(input.jobs.map(row => [row.id, { agent_ms: MINUTE }]));
  return { input, sizes, seen: play(input, sizes) };
}

test('work before its first push budgets triage and a ruling before releasing dependents', async () => {
  await h.capacity({ claude: 1, codex: 1 });
  const clear = leftoverJobs(h.db);
  const author = h.queue({ agent: 'bolt', engine: 'claude' });
  const after = h.queue({ agent: 'kit', engine: 'codex', after: author });
  const { input, seen } = forecast(0, [author, after]);
  assert.equal(seen.get(author)!.merged, input.now + 31 * MINUTE);
  assert.equal(seen.get(after)!.start, seen.get(author)!.merged);
  clear();
  const finished = h.ended({ agent: 'bolt', engine: 'claude' });
  h.storedPr(990, finished, 'open', [], { round: 1 });
  h.queue({ agent: 'quill', engine: 'claude', kind: 'consolidate', pr: 990, round: 1, stage: 'ruling' });
  const ruled = forecast(990);
  assert.equal(ruled.seen.get(finished)!.merged, ruled.input.now + MINUTE);
  clear();
});

test('unopened work uses triage round history instead of an old fixed panel', async () => {
  await h.capacity({ claude: 1, codex: 1 });
  const clear = leftoverJobs(h.db);
  for (const [pr, reviewClass, round] of [
    [995, 'one', 5],
    [996, 'triage', 1],
  ] as const) {
    const past = h.ended({ agent: 'bolt' });
    h.storedPr(pr, past, 'merged', [], { round, reviewClass });
  }
  const author = h.queue({ agent: 'bolt', engine: 'claude' });
  const after = h.queue({ agent: 'kit', engine: 'codex', after: author });
  const { input, seen } = forecast(0, [author, after]);
  assert.equal(seen.get(after)!.start, input.now + 31 * MINUTE);
  h.clearReviewHistory();
  clear();
});

test('recorded reviewers occupy the panel capacity once before its ruling', async () => {
  await h.capacity({ claude: 1, codex: 1 });
  const clear = leftoverJobs(h.db);
  for (const [pr, file, agents, minutes] of [
    [991, 'products/demo/play.js', ['rook'], 16],
    [992, 'infra/test.yaml', ['rook', 'tally', 'nib', 'flint'], 17],
  ] as const) {
    const author = await h.start({ agent: 'bolt', branch: `job/${pr}`, queuedBy: 'juno' });
    await h.finish(author, { status: 'done', pr, branch: `job/${pr}`, files: [file], sha: 'a'.repeat(40) });
    const pending = forecast(pr);
    assert.equal(pending.seen.get(author.id)!.merged, pending.input.now + 16 * MINUTE);
    await completeTriage(h, pr, [...agents]);
    const { input, seen } = forecast(pr);
    assert.equal(seen.get(author.id)!.merged, input.now + minutes * MINUTE);
    if (pr === 992) {
      input.slots.claude = input.slots.codex = 2;
      input.seatRuns!.claude = input.seatRuns!.codex = 2;
      assert.equal(play(input, forecast(pr).sizes).get(author.id)!.merged, input.now + 16 * MINUTE);
    }
    clear();
  }
});

test('board-held and stuck PRs hold forecasts and live claims until resolution', async () => {
  for (const [pr, state, files] of [
    [993, 'board', ['products/demo/play.js']],
    [994, 'stuck', ['products/demo/play.js']],
  ] as const) {
    const author = h.ended({ agent: 'bolt', engine: 'claude' });
    h.storedPr(pr, author, state, [...files], { sha: 'b'.repeat(40), round: 1, since: author });
    h.ended(
      {
        agent: 'quill',
        kind: 'consolidate',
        pr,
        branch: `job/${author}`,
        sha: 'b'.repeat(40),
        round: 1,
        stage: 'ruling',
      },
      'done',
      'merge',
    );
    const engine = `dependent-${pr}`;
    const after = h.queue({ agent: 'bolt', engine, after: author });
    const waits = h.queue({ agent: 'bolt', engine, queuedBy: 'bolt' });
    assert.deepEqual(jobs.addWait(waits, author, 'bolt'), { ok: true });
    const { seen } = forecast(pr, [after, waits]);
    assert.equal(seen.get(author)!.merged, null);
    assert.equal(seen.get(after)!.start, null);
    assert.equal(seen.get(waits)!.start, null);
    assert.equal(await h.claim(engine), null);
    h.mergedPr(pr);
    const released = await h.claim(engine);
    assert.equal(released!.id, after);
    await h.finish(released!);
    const further = await h.claim(engine);
    assert.equal(further!.id, waits);
    await h.finish(further!);
  }
});

test('re-land dependents wait for the remaining PR rounds and its actual resolution', async () => {
  await h.capacity({ claude: 1, codex: 1, 're-land': 1, 're-land-dependent': 1 });
  const reLand = h.queue({
    agent: 'bolt',
    title: 'Bring the branch up to date',
    engine: 're-land',
    kind: 'work',
    pr: 991,
    branch: 'job/991',
    stage: 'fix',
  });
  const following = h.queue({ agent: 'bolt', engine: 're-land-dependent', after: reLand });
  const { input, sizes } = forecast(991, [following]);
  const played = play(input, sizes);
  assert.ok(played.get(reLand)!.merged! > played.get(reLand)!.done!);
  assert.equal(played.get(following)!.start, played.get(reLand)!.merged);
  assert.equal(await h.claim('re-land-dependent'), null);
  const running = await h.claim('re-land');
  assert.equal(running!.id, reLand);
  await h.finish(running!);
  assert.equal(await h.claim('re-land-dependent'), null);
  h.mergedPr(991);
  assert.equal((await h.claim('re-land-dependent'))!.id, following);
});

test('finished reviews, checks and fixes keep a forecast merge edge and a factual claim gate', async () => {
  for (const [offset, kind, status] of [
    [0, 'review', 'done'],
    [1, 'consolidate', 'done'],
    [2, 'work', 'failed'],
    [3, 'work', 'done'],
    [4, 'work', 'cancelled'],
  ] as const) {
    const pr = 1100 + offset,
      engine = `after-${pr}`;
    await h.capacity({ claude: 1, codex: 1, [engine]: 1 });
    const author = h.ended({ agent: 'bolt', engine: 'claude' });
    const branch = `job/${author}`;
    h.storedPr(pr, author, 'open', ['products/demo/play.js'], { round: kind === 'consolidate' ? 2 : 1 });
    const prior = h.ended(
      { agent: 'bolt', kind, branch, pr, round: 1, stage: kind === 'work' ? 'fix' : 'final' },
      status,
    );
    const after = h.queue({ agent: 'bolt', engine, after: prior });
    const { input, seen } = forecast(pr, [after]);
    const merged = seen.get(author)!.merged;
    assert.ok(merged !== null && merged > input.now, `PR #${pr}`);
    assert.equal(seen.get(after)!.start, merged);
    assert.equal(await h.claim(engine), null);
    h.mergedPr(pr);
    const started = await h.claim(engine);
    assert.equal(started!.id, after);
    await h.finish(started!);
  }
});

test('office records and completed merge rulings resolve on the sweep without a seat, while claims wait for the merge', async () => {
  const review = await import('./review.ts');
  for (const [pr, office, followup] of [
    [1200, true, false],
    [1201, false, false],
    [1202, true, true],
  ] as const) {
    const engine = `automatic-${pr}`,
      sha = 'c'.repeat(40);
    await h.capacity({ claude: 1, codex: 1, [engine]: 1 });
    const author = h.ended({ agent: 'bolt', engine: 'claude' });
    h.storedPr(pr, author, 'open', [office ? 'knowledge/notes/example.md' : 'products/demo/play.js'], {
      sha,
      round: office ? 0 : 1,
      since: author,
    });
    if (!office)
      h.ended(
        { agent: 'quill', kind: 'consolidate', pr, branch: `job/${author}`, sha, round: 1, stage: 'ruling' },
        'done',
        'merge',
      );
    const after = h.queue({ agent: 'bolt', engine, after: author });
    const { input, sizes, seen } = forecast(pr, [after]);
    assert.equal(seen.get(author)!.merged, input.now + 5 * MINUTE, `PR #${pr}`);
    assert.equal(seen.get(after)!.start, seen.get(author)!.merged);
    assert.equal(play({ ...input, slots: {}, seats: [] }, sizes).get(author)!.merged, seen.get(author)!.merged);
    assert.equal(await h.claim(engine), null);
    h.github.pr(pr).head = sha;
    if (followup) {
      const fixEngine = `${engine}-fix`,
        branch = `job/${author}`;
      await h.capacity({ claude: 1, codex: 1, [engine]: 1, [fixEngine]: 1 });
      const fix = h.queue({ agent: 'bolt', title: 'Bringing up to date', engine: fixEngine, branch, pr, stage: 'fix' });
      const queued = forecast(pr, [after]).seen;
      assert.equal(queued.get(author)!.merged, queued.get(fix)!.done);
      assert.equal(queued.get(after)!.start, queued.get(fix)!.done);
      assert.ok(queued.get(fix)!.done !== null);
      const working = await h.claim(fixEngine);
      assert.equal(working!.id, fix);
      const running = forecast(pr, [after]).seen;
      assert.equal(running.get(author)!.merged, running.get(fix)!.done);
      assert.equal(running.get(after)!.start, running.get(fix)!.done);
      assert.equal(await h.claim(engine), null);
      await review.actOnRulings();
      assert.equal(h.github.pr(pr).merged, false);
      await h.finish(working!);
      const noPush = forecast(pr, [after]).seen;
      assert.equal(noPush.get(author)!.merged, null);
      assert.equal(noPush.get(after)!.start, null);
      await review.actOnRulings();
      assert.equal(h.github.pr(pr).merged, false);
      assert.equal(await h.claim(engine), null);
      const retry = await h.start({ agent: 'bolt', engine: fixEngine, branch, pr, stage: 'fix' });
      await h.finish(retry, { pr, branch, sha, files: ['knowledge/notes/example.md'] });
      await until(() => h.github.pr(pr).merged, 'the pushed office follow-up to merge');
    } else await review.actOnRulings();
    assert.equal(h.github.pr(pr).merged, true);
    const started = await h.claim(engine);
    assert.equal(started!.id, after);
    await h.finish(started!);
  }
});

test('owner-assigned discipline fixes stay in task order before review and retain their PR measurements', async () => {
  const file = `${h.repo}/company/projects.yaml`,
    previous = readFileSync(file, 'utf8');
  writeFileSync(file, 'planning: threads\nprojects:\n  - { id: game, name: The game, owner: wren }\n');
  const projects = await import('./projects.ts'),
    plan = await import('./plan.ts'),
    order = await import('./threadorder.ts'),
    proposals = await import('./proposals.ts'),
    inbox = await import('./reviewinbox.ts'),
    { remember } = await import('./db.ts');
  try {
    resetReviewInbox(h.db);
    remember(order.MODE, 'threads');
    plan.setOwner('game', 'wren', { agent: 'juno', job: 0 }, agent => !!jobs.findAgent(agent));
    projects.createThread({
      project: 'game',
      name: 'The world plays',
      goal: 'The world finishes',
      slug: 'world',
    });
    const author = h.ended({ agent: 'bolt', engine: 'claude', thread: 'game/world' }),
      branch = `job/${author}`,
      pr = 1300;
    h.storedPr(pr, author, 'open', ['game.ts'], { round: 1 });
    h.ended({ agent: 'quill', kind: 'consolidate', pr, branch, round: 1, stage: 'ruling' }, 'done', 'changes');
    proposals.deliverFindings({
      pr,
      branch,
      round: 1,
      agent: 'bolt',
      decision: 'changes',
      summary: 'Repair the world',
      findings: [
        { id: 12, domain: 'engine', files: ['game.ts'], issue: 'The world cannot finish' },
        { id: 13, domain: 'art', files: ['world.svg'], issue: 'The ship is invisible' },
      ],
    });
    h.cancelQueued();
    const owner = await h.start({ agent: 'wren', title: 'Assign review fixes' });
    const engine = await h.agent('proposals/accept', owner.token, {
      id: `findings:${pr}`,
      for: 'kit',
      findings: '12',
      title: 'Let the world finish',
    });
    assert.equal(engine.status, 200, JSON.stringify(engine.body));
    const art = await h.agent('job', owner.token, {
      agent: 'moss',
      title: 'Make the ship visible',
      prompt: 'Repair the ship',
      thread: 'game/world',
      findings: '13',
    });
    assert.equal(art.status, 200, JSON.stringify(art.body));
    const moved = await h.agent('plan/move', owner.token, { id: art.body.id, place: 1 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const continuation = await h.agent('job', owner.token, {
      agent: 'bolt',
      title: 'Continue the world',
      prompt: 'Build the next move',
      thread: 'game/world',
    });
    assert.equal(continuation.status, 200, JSON.stringify(continuation.body));
    const fixes = inbox.tasks(pr, 1);
    assert.equal(fixes[0].agent, 'moss');
    assert.deepEqual(
      fixes.map(fix => jobs.findJob(fix.id)!.pr),
      [null, null],
    );
    const { reviewPlans } = await import('./reviewplan.ts');
    const reviewOf = () => reviewPlans(Date.now())({ ...jobs.findJob(author)!, engine: 'claude', origin: 'work' });
    const review = reviewOf()!;
    assert.equal(review.count, 2);
    assert.deepEqual(
      review.stages.filter(stage => stage.kind === 'work').map(stage => [stage.job, stage.agent]),
      fixes.map(fix => [fix.id, fix.agent]),
    );
    assert.deepEqual(
      review.stages.slice(0, 2).map(stage => stage.job),
      fixes.map(fix => fix.id),
    );
    await h.capacity({ claude: 2, codex: 1 });
    const { seen } = forecast(pr, [...fixes.map(fix => fix.id), continuation.body.id]);
    assert.ok(seen.get(fixes[0].id)!.done !== null);
    assert.equal(seen.get(fixes[1].id)!.start, seen.get(fixes[0].id)!.done);
    assert.ok(seen.get(author)!.merged! > seen.get(fixes[1].id)!.done!);
    assert.equal(seen.get(continuation.body.id)!.start, seen.get(fixes[1].id)!.done);
    assert.ok(seen.get(continuation.body.id)!.merged! > seen.get(continuation.body.id)!.done!);
    const first = await h.claim('claude');
    assert.equal(first!.id, fixes[0].id);
    await h.finish(first!);
    assert.equal((await h.claim('claude'))!.id, fixes[1].id);
  } finally {
    writeFileSync(file, previous);
  }
});
