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
// (why a task's latest naming failed: on its row, for the agents)
const errorOf = (id: number) =>
  (h.db.prepare("select error from board_names where kind = 'task' and id = ?").get(String(id)) as { error: string })
    .error;

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

  // A retitle is due again, and the board reads the agent's new words until it's named
  assert.deepEqual(plan.title(job, 'Read the cohort again', 'wren'), { ok: true });
  const retitled = await boardJob(job);
  assert.deepEqual([retitled.title, retitled.naming], ['Read the cohort again', undefined]);
  const again = await claim();
  assert.deepEqual(refs(again), [`task:${job}`]);
  await answer(again, { [`task:${job}`]: 'Measure the wait for a free seat again' });
  assert.equal((await boardJob(job)).title, 'Measure the wait for a free seat again');
});

test("the model being down blocks nothing: the board reads the agent's words, why it failed stays on its row, and it's asked until it's named", async () => {
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
  assert.deepEqual(
    [asked.title, asked.naming, asked.status],
    ['Profile the CPQ seat path', undefined, 'queued'],
    'queued, in its words',
  );
  await answer(claimed, null);
  const down = await boardJob(job);
  assert.deepEqual([down.title, down.naming], ['Profile the CPQ seat path', undefined], 'still its words');
  assert.equal(errorOf(job), "the naming model didn't answer", 'the error stays on its row');
  assert.deepEqual(await claim(), {}, 'not asked again at once');
  // (an answer that names nothing, or too long a name, is an error too, and it's asked again however often it comes)
  for (let tries = 0; tries < 4; tries++) {
    mock.timers.tick(10 * MIN);
    const c = await claim();
    assert.ok(refs(c).includes(`task:${job}`), 'asked again later');
    await answer(c, { [`task:${job}`]: tries % 2 ? '' : 'x'.repeat(101) });
    assert.equal(
      errorOf(job),
      tries % 2 ? 'the naming model gave no name for it' : "the naming model's name was over 100 characters",
    );
    assert.equal((await boardJob(job)).title, 'Profile the CPQ seat path');
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
  assert.equal((await boardJob(run.id)).title, 'Cut the RC build', 'done, in its words until named');
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
  assert.deepEqual([before.title, before.naming], ['Wire the CPQ cohort sweep', undefined]);
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
  // (its owner's own title for it, which what the round fixes then names: the board's version of it, its words until made)
  assert.deepEqual(plan.title(accepted.job, 'Fix 614 and 615', 'wren'), { ok: true });
  const words = titleOf(accepted.job);
  const fixes = async () =>
    (await h.board('/api/projects/thread?id=game/orders')).body.jobs.find((j: { id: number }) => j.id === accepted.job)
      .fixes;
  assert.deepEqual(
    await fixes(),
    { round: 1, findings: [], title: 'Fix 614 and 615' },
    "the agents' words until named",
  );
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

test("a meeting's topic gets a plain name, and its seats are the board's Meetings group, out of the unsorted work", async () => {
  await nameAll();
  const meetings = await import('./meetings.ts');
  const topic = 'Kit seams, settled: read company/briefs/1-meeting.md first';
  const set = meetings.create({
    topic,
    agents: ['ivy', 'wren'],
    at: Date.now() + 60 * MIN,
    calledBy: 'juno',
    code: undefined,
  });
  assert.equal(typeof set, 'object', String(set));
  const { id, seats } = set as { id: number; seats: { job: number }[] };
  type Seat = { id: number; kind: string; meeting: { id: number; topic: string } };
  const seatsOf = async () => {
    const board = (await h.board('/api/projects')).body as { meetings: Seat[]; unsorted: Seat[] };
    assert.ok(!board.unsorted.some(j => j.kind === 'meeting'), 'no seat in the unsorted work');
    return board.meetings.sort((a, b) => a.id - b.id);
  };
  const before = await seatsOf();
  assert.deepEqual(
    before.map(j => j.id),
    seats.map(s => s.job).sort((a, b) => a - b),
  );
  assert.ok(
    before.every(j => j.meeting.id === id && j.meeting.topic === topic),
    "the agents' words while it's named",
  );
  const c = await claim();
  assert.deepEqual(refs(c), [`meeting:${id}`]);
  assert.match(c.prompt ?? '', /What it is: a meeting's topic/);
  await answer(c, { [`meeting:${id}`]: 'How the line-art kit fits together' });
  assert.ok((await seatsOf()).every(j => j.meeting.topic === 'How the line-art kit fits together'));
});

test('a meeting topic with deeply nested delimiters can be claimed without escaping its prompt fences', async () => {
  await nameAll();
  const meetings = await import('./meetings.ts');
  const topic = '<na'.repeat(12_000) + '<name>' + 'me>'.repeat(12_000);
  const set = meetings.create({
    topic,
    agents: ['ivy', 'wren'],
    at: Date.now() + 60 * MIN,
    calledBy: 'juno',
    code: undefined,
  });
  assert.equal(typeof set, 'object', String(set));
  const { id } = set as { id: number };
  const claimed = await h.worker('names/claim');
  assert.equal(claimed.status, 200);
  const c = claimed.body as Claimed;
  assert.deepEqual(refs(c), [`meeting:${id}`]);
  assert.equal(c.names[0].words, topic);
  assert.match(c.prompt, /The agents' words: &lt;na&lt;na/);
  assert.doesNotMatch(c.prompt, /<na<na/);
  assert.match(c.prompt.slice(0, c.prompt.indexOf('\n<work>\n')), /"<" the agents wrote reads "&lt;": write it as "<"/);
});

test("a '<' in the agents' words reaches the model encoded, and the '<' in its answer is what the board reads", async () => {
  await nameAll();
  const thread = projects.createThread({
    project: 'game',
    name: 'Order checks',
    goal: 'Orders add up',
    slug: 'less-than',
  }) as {
    id: string;
  };
  await nameAll();
  const words = 'Check total < limit before <work> closes';
  const job = h.queue({
    agent: 'kit',
    title: words,
    thread: thread.id,
    prompt: 'Refuse an order when total < limit fails.',
  });
  const c = await claim();
  assert.deepEqual(refs(c), [`task:${job}`]);
  assert.match(c.prompt!, /The agents' words: Check total &lt; limit before &lt;work> closes/);
  assert.match(c.prompt!, /Refuse an order when total &lt; limit fails/, 'its brief');
  const plain = 'Refuse an order whose total < its limit fails';
  await answer(c, { [`task:${job}`]: plain });
  assert.equal((await boardJob(job)).title, plain, 'the board reads "<", not "&lt;"');
  const shown = (await h.board(`/api/projects/thread?id=${thread.id}`)).body;
  assert.equal(shown.jobs[0].title, plain);
  assert.equal(titleOf(job), words, "the agents' words stay on the task");
});
