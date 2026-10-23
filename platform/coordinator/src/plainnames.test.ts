// node --test src/plainnames.test.ts   (uses a throwaway DATA_DIR): the names the board reads, put plainly by the small
// model through the worker's routes (the model stubbed), open or done, the agent's words kept for the agents, never
// shown in their place, and nothing waiting on it.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { resetReviewInbox } from './reviewfixture.ts';

const h = await harness('plainnames', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      'planning: threads\nprojects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: Shop v2, owner: wren }\n',
    ),
});
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const proposals = await import('./proposals.ts');
const inbox = await import('./reviewinbox.ts');
const projectdone = await import('./projectdone.ts');

const MIN = 60_000;
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T12:00:00Z') });
test.after(() => mock.timers.reset());

// The worker's turn: the next names due, and the model's answer for them (its words for each ref, or a failed call)
type Claimed = { names: { kind: string; id: string; words: string }[]; prompt: string; schema: string };
const claim = async () => (await h.worker('names/claim')).body as Partial<Claimed>;
const answer = (claimed: Partial<Claimed>, said: Record<string, string> | null) =>
  h.worker('names/answer', {
    names: claimed.names,
    ...(said
      ? {
          result: {
            type: 'result',
            is_error: false,
            structured_output: { names: Object.entries(said).map(([ref, plain]) => ({ ref, plain })) },
          },
        }
      : { error: 'exit 1: overloaded' }),
  });
const refs = (claimed: Partial<Claimed>) => (claimed.names ?? []).map(n => `${n.kind}:${n.id}`).sort();
// Whatever is due now, named as its words with "(plain)" after them, so a test starts from a clean slate: the refs it
// named
async function nameAll() {
  const named: string[] = [];
  for (let c = await claim(); c.names; c = await claim()) {
    named.push(...refs(c));
    await answer(c, Object.fromEntries(c.names.map(n => [`${n.kind}:${n.id}`, `${n.words} (plain)`])));
  }
  return named;
}
const boardJob = async (id: number) => (await h.board(`/api/jobs/find?id=${id}`)).body.job;
const titleOf = (id: number) =>
  (h.db.prepare('select title from jobs where id = ?').get(id) as { title: string }).title;

test("a new task's board title comes from the model's route, its brief read, and the agent's words stay on it", async () => {
  await nameAll();
  const thread = projects.createThread({
    project: 'game',
    name: 'Claim-plan cost',
    goal: 'The retained cohort is read at its boundary',
    slug: 'claims',
  }) as { id: string };
  const words = 'Read the retained claim-plan cohort at its boundary';
  const customer = h.queue({
    agent: 'kit',
    title: 'Help customer Sample Person',
    thread: thread.id,
    prompt: 'Customer-only details',
    customers: true,
  });
  const job = h.queue({
    agent: 'kit',
    title: words,
    thread: thread.id,
    prompt: 'Measure how long HQ took to pick the next task for each free seat, over the retained cohort.',
  });
  const claimed = await claim();
  assert.ok(!refs(claimed).includes(`task:${customer}`));
  assert.doesNotMatch(claimed.prompt!, /Sample Person|Customer-only details/);
  assert.deepEqual(refs(claimed), [`goal:${thread.id}`, `task:${job}`, `thread:${thread.id}`], "the thread's together");
  assert.match(claimed.prompt!, /The agents' words: Read the retained claim-plan cohort at its boundary/);
  assert.match(claimed.prompt!, /Measure how long HQ took to pick the next task for each free seat/, 'its brief');
  assert.match(claimed.prompt!, /Every name the board reads .* is plain human speech/, "the guide's plain-words rule");
  assert.match(claimed.prompt!, /"Claim-plan cost" → "A free seat picks its next task fast"/, 'its examples');
  assert.match(claimed.prompt!, /"Payments, settled" → "Pick the shop's payment provider"/);
  assert.match(claimed.prompt!, /- claim plan: HQ's plan of which queued task each free seat takes next/, 'its terms');
  const plain = "Measure how long HQ took to pick each free seat's next task";
  const r = await answer(claimed, {
    [`task:${job}`]: plain,
    [`thread:${thread.id}`]: 'A free seat picks its next task fast',
    [`goal:${thread.id}`]: 'We know how long a free seat waits for its next task',
  });
  assert.deepEqual(r.body, { named: 3 });
  assert.equal((await boardJob(job)).title, plain, 'the board reads the plain title');
  const shown = (await h.board(`/api/projects/thread?id=${thread.id}`)).body;
  assert.deepEqual(
    [shown.name, shown.goal, shown.jobs[0].title],
    ['A free seat picks its next task fast', 'We know how long a free seat waits for its next task', plain],
  );
  const board = (await h.board('/api/projects')).body;
  const listed = board.projects
    .find((p: { id: string }) => p.id === 'game')
    .threads.find((t: { id: string }) => t.id === thread.id);
  assert.deepEqual([listed.name, listed.jobs[0].title], ['A free seat picks its next task fast', plain]);
  assert.equal(titleOf(job), words, "the agents' words stay on the task");
  assert.equal(projects.findThread(thread.id)!.name, 'Claim-plan cost');
  assert.deepEqual(await claim(), {}, 'nothing more is due');

  // A retitle is due again, and the board's view says it's being named until it is, never the agent's new words
  assert.deepEqual(plan.title(job, 'Read the cohort again', 'wren'), { ok: true });
  const retitled = await boardJob(job);
  assert.deepEqual([retitled.title, retitled.naming], [null, { title: null }]);
  const again = await claim();
  assert.deepEqual(refs(again), [`task:${job}`]);
  await answer(again, { [`task:${job}`]: 'Measure the wait for a free seat again' });
  assert.equal((await boardJob(job)).title, 'Measure the wait for a free seat again');
});

test("the model being down blocks nothing: the board's view says the name is being made, then why it failed, and it's asked until it's named", async () => {
  await nameAll();
  const queued = await h.agent('job', (await h.start({ agent: 'wren', title: 'Plan', thread: 'game/claims' })).token, {
    agent: 'kit',
    title: 'Profile the CPQ seat path',
    prompt: 'Time each step a free seat takes to its next task.',
    code: 'SEATPATH',
  });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const job = queued.body.id as number;
  const claimed = await claim();
  assert.ok(refs(claimed).includes(`task:${job}`));
  const asked = await boardJob(job);
  assert.deepEqual([asked.title, asked.naming, asked.status], [null, { title: null }, 'queued'], 'queued, being named');
  await answer(claimed, null);
  const down = await boardJob(job);
  assert.deepEqual([down.title, down.naming], [null, { title: "the naming model didn't answer" }], 'the error shows');
  assert.deepEqual(await claim(), {}, 'not asked again at once');
  // (an answer that names nothing, or too long a name, is an error too, and it's asked again however often it comes)
  for (let tries = 0; tries < 4; tries++) {
    mock.timers.tick(10 * MIN);
    const c = await claim();
    assert.ok(refs(c).includes(`task:${job}`), 'asked again later');
    await answer(c, { [`task:${job}`]: tries % 2 ? '' : 'x'.repeat(101) });
    assert.deepEqual((await boardJob(job)).naming, {
      title: tries % 2 ? 'the naming model gave no name for it' : "the naming model's name was over 100 characters",
    });
  }
  mock.timers.tick(10 * MIN);
  await answer(await claim(), { [`task:${job}`]: 'Time how a free seat gets its next task' });
  const named = await boardJob(job);
  assert.deepEqual([named.title, named.naming], ['Time how a free seat gets its next task', undefined]);
  assert.equal(titleOf(job), 'Profile the CPQ seat path');
});

test('work finished before it was named, done threads and done projects get plain names too, never customer work', async () => {
  await nameAll();
  const ship = projects.createThread({ project: 'game', name: 'Ship it', goal: 'The build is out', slug: 'ship' }) as {
    id: string;
  };
  const run = await h.start({ agent: 'ivy', title: 'Cut the RC build', thread: ship.id });
  await h.finish(run);
  const customer = await h.start({ agent: 'ivy', title: 'Answer Sample Person', thread: ship.id, customers: true });
  await h.finish(customer);
  const ended = projects.createThread({ project: 'game', name: 'Old idea', goal: 'Tried', slug: 'old' }) as {
    id: string;
  };
  assert.deepEqual(plan.done(ended.id, 'wren'), { ok: true });
  // (a project renamed by the CEO, juno, and ended before its new name was put plainly)
  assert.equal((plan.renameProject('shop', 'Shop, the second', 'juno') as { name: string }).name, 'Shop, the second');
  assert.deepEqual(projectdone.projectDone('shop', 'wren'), { ok: true });
  assert.equal((await boardJob(run.id)).title, null, 'done, being named');
  const named = await nameAll();
  for (const ref of [`task:${run.id}`, `thread:${ended.id}`, `goal:${ended.id}`, 'project:shop'])
    assert.ok(named.includes(ref), ref);
  assert.ok(!named.includes(`task:${customer.id}`), 'never customer work');
  assert.equal((await boardJob(run.id)).title, 'Cut the RC build (plain)');
  assert.equal((await boardJob(customer.id)).title, 'Answer Sample Person', 'its own title stands');
  assert.equal((await h.board(`/api/projects/thread?id=${ended.id}`)).body.name, 'Old idea (plain)');
  const board = (await h.board('/api/projects')).body;
  assert.equal(board.completed.find((p: { id: string }) => p.id === 'shop').name, 'Shop, the second (plain)');
  const game = board.projects.find((p: { id: string }) => p.id === 'game');
  assert.equal(game.done.find((t: { id: string }) => t.id === ended.id).goal, 'Tried (plain)');
});

test("Wire's last-work line reads the finished task's plain title", async () => {
  await nameAll();
  await h.finish(await h.start({ agent: 'tess', title: 'Wire the CPQ cohort sweep', thread: 'game/claims' }));
  const before = (await h.board('/api/work')).body.agents.tess.last;
  assert.deepEqual([before.title, before.naming], [null, { title: null }]);
  await nameAll();
  assert.equal((await h.board('/api/work')).body.agents.tess.last.title, 'Wire the CPQ cohort sweep (plain)');
});

test("a fix round's board title is written from its findings' text", async () => {
  await nameAll();
  resetReviewInbox(h.db);
  projects.createThread({
    project: 'game',
    name: 'The shop takes orders',
    goal: 'An order can be paid',
    slug: 'orders',
  });
  const author = await h.start({ agent: 'bolt', title: 'Build the order path', thread: 'game/orders' });
  h.storedPr(71, author.id, 'open', ['shop.ts'], { round: 1 });
  proposals.deliverFindings({
    pr: 71,
    round: 1,
    branch: `job/${author.id}`,
    agent: 'bolt',
    decision: 'changes',
    summary: 'The order path needs fixes',
    findings: [
      { id: 614, domain: 'shop', files: ['shop.ts'], issue: 'Paying for an order never records it as paid' },
      { id: 615, domain: 'shop', files: ['shop.ts'], issue: 'The order total skips the shipping cost' },
    ],
  });
  // (the accepter's title where HQ takes one, else its own for the findings: the agents' words either way)
  const accepted = inbox.accept('findings:71', 'wren', {
    for: 'kit',
    findings: '614,615',
    title: 'Fix 614 and 615',
  }) as { job: number };
  assert.equal(typeof accepted.job, 'number', JSON.stringify(accepted));
  // (its owner's own title for it, which what the round fixes then names: the board's version of it, none until made)
  assert.deepEqual(plan.title(accepted.job, 'Fix 614 and 615', 'wren'), { ok: true });
  const words = titleOf(accepted.job);
  const fixes = async () =>
    (await h.board('/api/projects/thread?id=game/orders')).body.jobs.find((j: { id: number }) => j.id === accepted.job)
      .fixes;
  assert.deepEqual(await fixes(), { round: 1, findings: [] }, "never the agents' words");
  let claimed = await claim();
  while (claimed.names && !refs(claimed).includes(`task:${accepted.job}`)) {
    await answer(claimed, Object.fromEntries(claimed.names.map(n => [`${n.kind}:${n.id}`, n.words])));
    claimed = await claim();
  }
  assert.ok(claimed.prompt!.includes(`The agents' words: ${words}`));
  assert.match(claimed.prompt!, /Paying for an order never records it as paid/, "the findings' text");
  assert.match(claimed.prompt!, /The order total skips the shipping cost/);
  await answer(claimed, { [`task:${accepted.job}`]: 'Fix a broken order path' });
  assert.equal((await boardJob(accepted.job)).title, 'Fix a broken order path');
  assert.equal((await fixes()).title, 'Fix a broken order path');
  assert.equal(titleOf(accepted.job), words);
});
