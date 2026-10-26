// node --test src/regroup.test.ts   (hq thread move and hq job move; throwaway DATA_DIR and REPO_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { harness, until } from './harness.ts';

const h = await harness('regroup', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      `businesses:
  - { id: play, name: Play }
projects:
  - { id: game, name: The game, owner: wren, business: play }
  - { id: shop, name: The shop, owner: moss }
  - { id: tools, name: The tools, owner: wren }
`,
    ),
});
const { db } = h;
const projects = await import('./projects.ts');
const pauses = await import('./pauses.ts');
const regroup = await import('./regroup.ts');
const plan = await import('./plan.ts');
const forecast = await import('./forecast.ts');
const messages = await import('./messages.ts');
const predictionlog = await import('./predictionlog.ts');

const reset = () =>
  db.exec(`delete from jobs; delete from prs; delete from threads; delete from thread_aliases; delete from pauses;
    delete from prediction_log; delete from thread_needs; delete from messages; delete from wakes`);
const started = (slug: string, project = 'game') => {
  const t = projects.createThread({ project, name: `Thread ${slug}`, goal: 'It works', slug });
  assert.equal(typeof t, 'object', typeof t === 'string' ? t : '');
  return (t as { id: string }).id;
};
const threadOf = (id: number) => h.job(id).thread as string | null;
const engineOf = (id: number) =>
  (db.prepare('select engine from jobs where id = ?').get(id) as { engine: string }).engine;
const moveThread = async (agent: string, id: string, project: string) =>
  h.agent('threads/move', (await h.start({ agent })).token, { id, project });
const moveJob = async (agent: string, id: number, thread: string) =>
  h.agent('jobs/move', (await h.start({ agent })).token, { id, thread });

test('a moved thread takes its jobs and pause along, and its old id keeps finding it', async () => {
  reset();
  const levels = started('levels');
  const held = h.queue({ agent: 'kit', thread: levels });
  assert.equal(
    typeof pauses.pause({ thread: levels, why: 'Not before the map is in', byHand: true }, 'wren'),
    'object',
  );
  forecast.refresh();
  // (the rows the plays kept, written first)
  const logged = () => (
    predictionlog.write(),
    db.prepare('select distinct thread from prediction_log where thread is not null').all()
  );
  assert.deepEqual(
    logged().map(r => r.thread),
    [levels],
  );

  assert.equal((await moveThread('kit', levels, 'shop')).status, 400, "not kit's thread");
  assert.equal((await moveThread('juno', levels, 'game')).status, 400, 'already in it');
  assert.equal((await moveThread('juno', levels, 'nowhere')).status, 400);
  const moved = await moveThread('bolt', levels, 'shop');
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  // (a thread's owner is its project's: moss's now)
  assert.deepEqual([moved.body.id, moved.body.project, projects.ownerOf(moved.body)], ['shop/levels', 'shop', 'moss']);
  assert.equal(threadOf(held), 'shop/levels');
  assert.deepEqual(
    logged().map(r => r.thread),
    ['shop/levels'],
  );

  assert.equal(await h.claim(engineOf(held)), null, 'still paused');
  assert.deepEqual(h.job(held).wakes, ['paused with shop/levels']);
  assert.equal(projects.findThread(levels)?.id, 'shop/levels');
  // (moss's: a thread takes tasks from its project's owner)
  const lead = await h.start({ agent: 'moss' });
  const handed = await h.agent('job', lead.token, { agent: 'moss', title: 'Next', prompt: 'Do it.', thread: levels });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(threadOf(handed.body.id), 'shop/levels', 'a brief naming the old id lands on the moved thread');
  assert.equal((projects.getThread(levels) as { id: string }).id, 'shop/levels');
  assert.equal(typeof projects.createThread({ project: 'game', name: 'Levels', goal: 'x', slug: 'levels' }), 'string');

  // and back: both old ids find it where it is
  assert.match(
    String(regroup.moveThread('shop/levels', 'game', 'wren')),
    /only moss, the CEO/,
    "shop's threads are moss's",
  );
  assert.equal(typeof regroup.moveThread('shop/levels', 'game', 'moss'), 'object');
  assert.equal(projects.findThread('shop/levels')?.id, levels);
  assert.equal(projects.findThread(levels)?.project, 'game');
  assert.equal(threadOf(held), levels);
  const sound = started('sound');
  const otherSound = started('sound', 'shop');
  assert.equal(typeof regroup.moveThread(sound, 'shop', 'juno'), 'string');
  assert.equal(projects.findThread(sound)?.id, sound);
  assert.equal(typeof regroup.moveThread(sound, 'tools', 'juno'), 'object');
  assert.equal(typeof regroup.moveThread(otherSound, 'game', 'juno'), 'string');
  assert.equal(projects.findThread(sound)?.id, 'tools/sound');
  assert.equal(projects.findThread(otherSound)?.id, otherSound);
});

test("a thread is its project's owner's to move: a new owner takes over every thread in it", async () => {
  reset();
  const levels = started('levels');
  const [work, mine] = [h.queue({ agent: 'bolt', thread: levels }), started('mine', 'tools')];
  const owner = (to: string) => plan.setOwner('game', to, { agent: 'juno', job: 0 }, () => true);
  assert.deepEqual(owner('kit'), { ok: true });
  try {
    assert.match(String(regroup.moveThread(levels, 'tools', 'wren')), /only kit, the CEO or the process team/);
    assert.match(String(regroup.moveJob(work, mine, 'wren')), /only bolt, kit, the CEO or the process team/);
    assert.equal(typeof regroup.moveThread(levels, 'tools', 'kit'), 'object');
  } finally {
    owner('wren');
  }
});

test("a moved job takes its pull request's reviews and fix rounds along, and later rounds follow it", async () => {
  reset();
  const [levels, till] = [started('levels'), started('till', 'shop')];
  const work = await h.start({ agent: 'wren', thread: levels });
  const lead = work.id;
  assert.equal((await h.finish(work, { status: 'done', pr: 61, branch: `job/${lead}` })).status, 200);
  const review = h.queue({ agent: 'bolt', kind: 'review', pr: 61, branch: `job/${lead}` });
  const fix = h.queue({ agent: 'wren', stage: 'fix', pr: 61, branch: `job/${lead}` });
  const other = h.queue({ agent: 'kit', thread: levels });

  assert.equal((await moveJob('kit', review, till)).status, 400, "not kit's work");
  assert.equal((await moveJob('wren', review, 'shop/nowhere')).status, 400);
  const moved = await moveJob('wren', review, till);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body, { thread: till, jobs: [lead, review, fix] });
  assert.deepEqual([lead, review, fix, other].map(threadOf), [till, till, till, levels]);
  const next = h.queue({ agent: 'wren', stage: 'fix', pr: 61, branch: `job/${lead}` });
  assert.equal(threadOf(next), till, 'the next fix round follows its job');
  assert.equal(typeof regroup.moveJob(lead, till, 'juno'), 'string');
  assert.deepEqual([lead, review, fix, next].map(threadOf), [till, till, till, till]);

  h.mergedPr(61);
  assert.equal(typeof regroup.moveJob(lead, levels, 'juno'), 'string');
  assert.deepEqual([lead, review, fix, next].map(threadOf), [till, till, till, till]);
});

test('a job in no open thread moves onto one', () => {
  reset();
  const levels = started('levels');
  const loose = h.queue({ agent: 'wren' });
  assert.deepEqual(regroup.moveJob(loose, levels, 'bolt'), { thread: levels, jobs: [loose] });
});

test('work moves out from under no open pause: a pause holds it until it lifts', async () => {
  reset();
  const [levels, sound, till] = [started('levels'), started('sound'), started('till', 'shop')];
  const queued = h.queue({ agent: 'wren', thread: levels });
  assert.equal(
    typeof pauses.pause({ thread: levels, why: 'The board decides the map first', byHand: true }, 'juno'),
    'object',
  );
  assert.equal(typeof regroup.moveJob(queued, sound, 'wren'), 'string', "its thread's pause stays on it");
  assert.equal(threadOf(queued), levels);
  assert.equal(typeof regroup.moveThread(levels, 'shop', 'juno'), 'object', 'a thread takes its own pause along');
  assert.deepEqual(h.job(queued).wakes, ['paused with shop/levels']);

  assert.equal(typeof pauses.pause({ project: 'game', why: 'No game work tonight', byHand: true }, 'juno'), 'object');
  const onSound = h.queue({ agent: 'wren', thread: sound });
  assert.equal(typeof regroup.moveThread(sound, 'tools', 'juno'), 'string', "never its project's pause");
  assert.equal(typeof regroup.moveJob(onSound, till, 'juno'), 'string');
  assert.deepEqual([projects.findThread(sound)?.project, threadOf(onSound)], ['game', sound]);
  const boss = started('boss');
  assert.deepEqual(regroup.moveJob(onSound, boss, 'wren'), { thread: boss, jobs: [onSound] }, 'within the project');
  assert.deepEqual(h.job(onSound).wakes, ['paused with game']);

  assert.equal(typeof pauses.resume({ project: 'game' }, 'juno'), 'object');
  assert.equal(typeof regroup.moveThread(boss, 'tools', 'juno'), 'object', 'once it lifts, it moves');
});

test('a task move names open needing threads and tells their owners how to keep or re-point each need', async () => {
  reset();
  const [old, next, seller, own, closed] = [
    started('mail'),
    started('live-mail'),
    started('seller', 'shop'),
    started('mine'),
    started('closed', 'shop'),
  ];
  for (const needing of [seller, own, closed]) assert.deepEqual(plan.need(needing, old, 'juno'), { ok: true });
  assert.deepEqual(plan.done(closed, 'moss'), { ok: true });
  const owner = await h.start({ agent: 'moss', engine: 'claude' });
  const mover = await h.start({ agent: 'wren' });
  const work = h.queue({ agent: 'kit', thread: old });
  const moved = await h.hq(mover, 'job', 'move', String(work), next);
  assert.equal(moved.code, 0, moved.out);
  for (const [needing, owner] of [
    [seller, 'moss'],
    [own, 'wren'],
  ]) {
    assert.ok(moved.out.includes(`${needing} (${owner})`), moved.out);
    for (const command of [`hq plan need ${needing} ${next}`, `hq plan unneed ${needing} ${old}`])
      assert.ok(moved.out.includes(command), moved.out);
  }
  assert.ok(moved.out.includes('keep the need'), moved.out);
  assert.ok(!moved.out.includes(closed), moved.out);
  const sent = await h.agent('sent', mover.token);
  assert.equal(sent.body.length, 1);
  assert.equal(sent.body[0].to, 'moss');
  const inbox = await h.agent('inbox', owner.token, {});
  assert.equal(inbox.body.length, 1);
  assert.ok(inbox.body[0].text.includes(`hq plan unneed ${seller} ${old}`));
  assert.ok(inbox.body[0].text.includes(`hq plan need ${seller} ${next}`));
  assert.deepEqual(projects.needsOf(seller), [old], 'the owner decides, needs stay put');
  assert.equal(threadOf(work), next);
});

for (const relation of ['destination', 'ancestor', 'existing'] as const) {
  test(`a needing thread with a ${relation} relation to the destination can keep or remove its old need`, async () => {
    reset();
    const [old, next] = [started('old'), started('next', 'shop')];
    const needing = relation === 'destination' ? next : started('needing', 'shop');
    assert.deepEqual(plan.need(needing, old, 'juno'), { ok: true });
    if (relation === 'ancestor') assert.deepEqual(plan.need(next, needing, 'juno'), { ok: true });
    if (relation === 'existing') assert.deepEqual(plan.need(needing, next, 'juno'), { ok: true });
    const before = projects.needsOf(needing);
    const owner = await h.start({ agent: 'moss', engine: 'claude' });
    const mover = await h.start({ agent: 'wren' });
    const work = h.queue({ agent: 'kit', thread: old });
    const moved = await h.hq(mover, 'job', 'move', String(work), next);
    assert.equal(moved.code, 0, moved.out);
    const remove = `hq plan unneed ${needing} ${old}`;
    const invalid = `hq plan need ${needing} ${next}`;
    assert.ok(moved.out.includes(remove), moved.out);
    assert.ok(!moved.out.includes(invalid), moved.out);
    const inbox = await h.agent('inbox', owner.token, {});
    assert.equal(inbox.body.length, 1);
    assert.ok(inbox.body[0].text.includes(remove));
    assert.ok(!inbox.body[0].text.includes(invalid));
    assert.deepEqual(projects.needsOf(needing), before, 'the move leaves the decision to the owner');
    assert.equal(threadOf(work), next);
    const removed = await h.hq(owner, 'plan', 'unneed', needing, old);
    assert.equal(removed.code, 0, removed.out);
    assert.deepEqual(projects.needsOf(needing), relation === 'existing' ? [next] : []);
  });
}

test('a move with no needing thread adds no notice or owner message', async () => {
  reset();
  const [old, next] = [started('old'), started('next')];
  const mover = await h.start({ agent: 'wren' });
  const work = h.queue({ agent: 'kit', thread: old });
  const moved = await h.hq(mover, 'job', 'move', String(work), next);
  assert.equal(moved.code, 0, moved.out);
  assert.equal(moved.out.trim(), `#${work} on ${next} now.`);
  assert.deepEqual((await h.agent('sent', mover.token)).body, []);
});

test('several tasks moved in one review group send one line per needing thread', async () => {
  reset();
  const [old, next, first, second] = [
    started('old'),
    started('next'),
    started('first', 'shop'),
    started('second', 'shop'),
  ];
  for (const needing of [first, second]) assert.deepEqual(plan.need(needing, old, 'juno'), { ok: true });
  const lead = await h.start({ agent: 'wren', thread: old });
  await h.finish(lead, { status: 'done', pr: 62, branch: `job/${lead.id}` });
  const review = h.queue({ agent: 'bolt', kind: 'review', pr: 62, branch: `job/${lead.id}` });
  const fix = h.queue({ agent: 'wren', stage: 'fix', pr: 62, branch: `job/${lead.id}` });
  const mover = await h.start({ agent: 'juno' });
  const moved = await h.hq(mover, 'job', 'move', String(fix), next);
  assert.equal(moved.code, 0, moved.out);
  assert.deepEqual([lead.id, review, fix].map(threadOf), [next, next, next]);
  const sent = (await h.agent('sent', mover.token)).body;
  assert.equal(sent.length, 2);
  for (const needing of [first, second]) {
    assert.equal(sent.filter((m: { first: string }) => m.first.includes(`${needing} (moss)`)).length, 1);
  }
});

for (const choice of ['keep both', 're-point A', 're-point B', 're-point both', 'addition refused']) {
  test(`a review group spanning two source threads supports an independent choice: ${choice}`, async () => {
    reset();
    const [a, b, next, needing] = [started('a'), started('b'), started('next'), started('needing', 'shop')];
    for (const old of [a, b]) assert.deepEqual(plan.need(needing, old, 'moss'), { ok: true });
    const lead = await h.start({ agent: 'wren', thread: a });
    assert.equal((await h.finish(lead, { status: 'done', pr: 63, branch: `job/${lead.id}` })).status, 200);
    const review = h.queue({ agent: 'bolt', kind: 'review', pr: 63, branch: `job/${lead.id}`, thread: b });
    const mover = await h.start({ agent: 'juno' });
    const moved = regroup.moveJob(review, next, mover.agent, mover.id);
    assert.equal(typeof moved, 'object', JSON.stringify(moved));
    if (typeof moved === 'string') return;
    assert.deepEqual([lead.id, review].map(threadOf), [next, next]);
    assert.deepEqual(projects.needsOf(needing), [a, b], 'notices leave stored needs unchanged');
    assert.equal(moved.notices?.length, 1);
    const notice = moved.notices![0];
    const sent = (await h.agent('sent', mover.token)).body;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].first, notice);
    const commands = [...notice.matchAll(/hq plan (need|unneed) ([\w/-]+) ([\w/-]+)/g)];
    const removals = choice === 're-point A' ? [a] : choice === 're-point B' ? [b] : [a, b];
    if (choice === 'addition refused') assert.deepEqual(plan.need(next, needing, 'wren'), { ok: true });
    let refused = false;
    if (choice !== 'keep both') {
      for (const [, action, thread, target] of commands) {
        if (action === 'unneed' && !removals.includes(target)) continue;
        if (action === 'unneed') assert.ok(projects.needsOf(thread).includes(next), 'add before removing an old need');
        const changed = action === 'need' ? plan.need(thread, target, 'moss') : plan.unneed(thread, target, 'moss');
        if (typeof changed === 'string') {
          assert.equal(choice, 'addition refused', changed);
          refused = true;
          break;
        }
        assert.deepEqual(changed, { ok: true });
      }
    }
    assert.equal(refused, choice === 'addition refused');
    const kept = choice === 'keep both' || refused ? [a, b] : [a, b].filter(old => !removals.includes(old));
    const expected = choice === 'keep both' || refused ? kept : [...kept, next];
    assert.deepEqual(projects.needsOf(needing).sort(), expected.sort());
  });
}

test('a refused owner message leaves the work in its old thread', async () => {
  reset();
  const [old, next, needing] = [started('old'), started('next'), started('needing', 'shop')];
  assert.deepEqual(plan.need(needing, old, 'juno'), { ok: true });
  const owner = await h.start({ agent: 'moss', engine: 'claude' });
  const mover = await h.start({ agent: 'wren' });
  const work = h.queue({ agent: 'kit', thread: old });
  for (let i = 0; i < messages.PER_HOUR; i++) {
    const sent = await h.agent('message', mover.token, { to: 'moss', text: `Existing instruction ${i}` });
    assert.equal(sent.status, 200);
  }
  const moved = await h.hq(mover, 'job', 'move', String(work), next);
  assert.notEqual(moved.code, 0);
  assert.equal(threadOf(work), old);
  assert.deepEqual(projects.needsOf(needing), [old]);
  assert.equal((await h.agent('inbox', owner.token, {})).body.length, messages.PER_HOUR);
});

test("the CEO's expedite, from a call too, takes a thread's task that never started out of its thread, and the thread's next task stops waiting for it", async () => {
  reset();
  const levels = started('levels');
  const fix = h.queue({ agent: 'kit', thread: levels, title: 'Fix the claim', prompt: 'The whole brief' });
  const next = h.queue({ agent: 'kit', thread: levels });
  assert.equal(h.job(next).ready, 0, 'it waits for the task before it');
  const callOf = async (agent: string) => (await h.voice(`call-context?agent=${agent}`)).body.token as string;
  const [ceo, wren] = [await callOf('juno'), await callOf('wren')];
  const refused = await h.agent('expedite', wren, { id: fix });
  assert.deepEqual([refused.status, refused.body.error], [403, 'only the CEO expedites a job: ask juno']);
  const r = await h.agent('expedite', ceo, { id: fix });
  assert.deepEqual([r.status, r.body], [200, { ok: true, id: fix, starts: 'next', from: levels }]);
  const row = () => db.prepare('select agent, title, prompt, thread, expedite from jobs where id = ?').get(fix);
  assert.deepEqual(
    { ...row() },
    { agent: 'kit', title: 'Fix the claim', prompt: 'The whole brief', thread: null, expedite: 1 },
  );
  assert.equal(h.job(next).ready, 1, 'the next task waits for it no longer');
  for (const token of [ceo, wren])
    await h.voice('call-end', { agent: token === ceo ? 'juno' : 'wren', lines: [], request: 0, token });
});

test("a thread's task that ran stays in its thread, and expedite's refusal says what to do instead", async () => {
  reset();
  const levels = started('levels');
  const running = await h.start({ agent: 'kit', thread: levels });
  const ceo = (await h.start({ agent: 'juno' })).token;
  const fix =
    'to put the fix first, queue it as its own job with hq job --expedite (on a call: the job tool with expedite)';
  const expedite = async (id: number) => (await h.agent('expedite', ceo, { id })).body.error;
  assert.equal(
    await expedite(running.id),
    `job #${running.id} is running now on the branch it shares with the rest of ${levels}, so it can't leave that thread: ${fix}`,
  );
  await h.finish(running, { status: 'done', branch: `job/${running.id}`, sha: 'abc' });
  assert.equal(
    await expedite(running.id),
    `job #${running.id} has already run on the branch it shares with the rest of ${levels}, so it merges with that thread: ${fix}`,
  );
  assert.equal(threadOf(running.id), levels);
  assert.equal(await expedite(999_999), "there's no job #999999: check the number");
});

test('a task expedite took out of its thread merges ahead of its review only on a push its gates and tests passed, never on its third failing one', async () => {
  reset();
  const levels = started('levels');
  const ceo = (await h.start({ agent: 'juno' })).token;
  const failing = h.queue({ agent: 'kit', thread: levels }),
    passing = h.queue({ agent: 'kit', thread: levels });
  for (const id of [failing, passing]) assert.equal((await h.agent('expedite', ceo, { id })).body.starts, 'next');
  const push = async (job: number, branch: number, pr: number, gates: { passed: boolean; report: string }) => {
    const r = await h.finish(await h.claimJob(job), {
      pr,
      branch: `job/${branch}`,
      files: ['platform/coordinator/src/review.ts'],
      sha: randomBytes(20).toString('hex'),
      gates,
      tests: { passed: true, report: 'Tests passed' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const fixRound = () =>
    (
      db
        .prepare("select id from jobs where kind = 'work' and branch = ? and status = 'queued'")
        .get(`job/${failing}`) as {
        id: number;
      }
    ).id;
  const expedited = (pr: number) =>
    (db.prepare('select expedited from prs where number = ?').get(pr) as { expedited: number }).expedited;
  const red = { passed: false, report: 'lib/a.ts:9: x is never used' };
  await push(failing, failing, 7101, red);
  await push(fixRound(), failing, 7101, red);
  await push(fixRound(), failing, 7101, red);
  assert.equal(expedited(7101), 0, 'the third failing push goes on to its review, not merged ahead of it');
  assert.equal(
    (await h.agent('expedite', ceo, { id: failing })).body.error,
    "PR #7101's last push didn't pass its gates and tests, so it isn't merged ahead of its review: a later push that passes them merges",
  );
  assert.equal(expedited(7101), 0);
  await push(passing, passing, 7102, { passed: true, report: 'Gates passed' });
  assert.equal(expedited(7102), 1, 'a push both passed merges expedited');
  await until(() => h.github.pr(7102).merged === true, 'the expedited merge');
});

test('expedite says what the work still needs first, as the queue holds it, and that it starts next only once nothing does', async () => {
  reset();
  const levels = started('levels');
  const ceo = (await h.start({ agent: 'juno' })).token;
  const road = h.queue({ agent: 'moss', title: 'Lay the road' });
  const task = h.queue({ agent: 'kit', thread: levels, after: road });
  const plain = h.queue({ agent: 'kit' });
  h.jobs.holdForMerge(plain, road, 'juno');
  const expedite = async (id: number) => (await h.agent('expedite', ceo, { id })).body;
  const unmerged = new RegExp(`^until #${road}\\b[^(]*\\(moss: Lay the road\\) is done and merged$`);
  const left = await expedite(task);
  assert.equal(left.starts, undefined, "it doesn't start next");
  assert.match(left.waits, unmerged);
  assert.equal(left.from, levels);
  assert.match((await expedite(plain)).waits, unmerged);
  assert.equal(await h.claim(engineOf(task)), null, 'expedite keeps its after');
  assert.equal(await h.claim(engineOf(plain)), null, 'expedite keeps its further wait');
  // ended with nothing to merge: its after is met, a further wait never is
  await h.finish(await h.claimJob(road), { status: 'done' });
  assert.deepEqual(await expedite(task), { ok: true, id: task, starts: 'next' });
  assert.match((await expedite(plain)).waits, unmerged);
  assert.equal(await h.claim(engineOf(plain)), null, 'a further wait still needs a merge');
  assert.equal((await h.claim(engineOf(task)))?.id, task, 'the met after releases expedited work');
});
