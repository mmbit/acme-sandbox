// node --test src/urgency.test.ts   (throwaway DATA_DIR and the test company).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('urgency');
const projects = await import('./projects.ts');
const urgency = await import('./urgency.ts');

function opened(slug: string) {
  const thread = projects.createThread({ project: 'office', slug, name: `Work ${slug}`, goal: 'The repair is live' });
  assert.notEqual(typeof thread, 'string');
  return `office/${slug}`;
}

test('the CEO marks and clears each work level in one command, while inherited urgency stays visible', async () => {
  const ceo = await h.start({ agent: 'juno' });
  const thread = opened('urgent');
  const task = h.queue({ agent: 'bolt', thread });
  assert.equal(urgency.taskUrgent(task), false);
  const marked = await h.hq(ceo, 'urgent', 'milestone', 'office');
  assert.equal(marked.code, 0, marked.out);
  assert.equal(urgency.taskUrgent(task), true);
  assert.equal(projects.findThread(thread)?.urgent, 1);
  assert.equal((await h.hq(ceo, 'urgent', 'task', String(task), 'off')).code, 0);
  assert.equal(urgency.taskUrgent(task), true);
  assert.equal((await h.hq(ceo, 'urgent', 'milestone', 'office', 'off')).code, 0);
  assert.equal(urgency.taskUrgent(task), false);
  assert.equal((await h.hq(ceo, 'urgent', 'job', thread)).code, 0);
  assert.equal(urgency.taskUrgent(task), true);
  assert.equal((await h.hq(ceo, 'urgent', 'job', thread, 'off')).code, 0);
  assert.equal(urgency.taskUrgent(task), false);
  assert.equal((await h.hq(ceo, 'urgent', 'task', String(task))).code, 0);
  assert.equal(urgency.taskUrgent(task), true);
  assert.equal((await h.hq(ceo, 'urgent', 'task', String(task), 'off')).code, 0);
  assert.equal(urgency.taskUrgent(task), false);
  assert.equal(urgency.taskUrgent(-99), false);
});

test('task urgency carries into its reviews and fixes and clears without changing sibling tasks', async () => {
  const ceo = await h.start({ agent: 'juno' });
  const thread = opened('reviews');
  const source = h.queue({ agent: 'bolt', thread });
  const sibling = h.queue({ agent: 'kit', thread });
  const branch = `job/${source}`;
  assert.equal(urgency.branchUrgent(branch), false);
  const review = h.queue({ agent: 'wren', kind: 'review', branch, pr: 912 });
  const fix = h.queue({ agent: 'bolt', kind: 'work', stage: 'fix', branch, pr: 912 });
  assert.equal((await h.agent('urgent', ceo.token, { level: 'task', id: String(source), urgent: true })).status, 200);
  for (const id of [source, review, fix]) assert.equal(urgency.taskUrgent(id), true);
  assert.equal(urgency.branchUrgent(branch), true);
  assert.equal(urgency.taskUrgent(sibling), false);
  assert.equal((await h.agent('urgent', ceo.token, { level: 'task', id: String(source), urgent: false })).status, 200);
  for (const id of [source, review, fix]) assert.equal(urgency.taskUrgent(id), false);
  assert.equal(urgency.branchUrgent(branch), false);
});

test("the play carries an urgent task's urgency into the reviews of the tasks after it on its branch", async () => {
  const backlog = await import('./backlog.ts');
  const ceo = await h.start({ agent: 'juno' });
  const thread = opened('ahead');
  const [first, middle, last] = ['bolt', 'kit', 'wren'].map(agent => h.queue({ agent, thread }));
  const marked = await h.hq(ceo, 'urgent', 'task', String(middle));
  assert.equal(marked.code, 0, marked.out);
  const played = new Map(backlog.orderingSnapshot(Date.now()).jobs.map(job => [job.id, job]));
  assert.deepEqual(
    [first, middle, last].map(id => [played.get(id)!.urgent, played.get(id)!.reviewUrgent]),
    [
      [false, false],
      [true, true],
      [false, true],
    ],
  );
});

test('clearing an expedited task says it stays urgent because it is expedited', async () => {
  const ceo = await h.start({ agent: 'juno' });
  const task = h.queue({ agent: 'bolt', thread: opened('expedited') });
  assert.equal((await h.agent('expedite', ceo.token, { id: task })).status, 200);
  const cleared = await h.hq(ceo, 'urgent', 'task', String(task), 'off');
  assert.match(cleared.out, /still urgent: it is expedited/);
});

test('off a call only the CEO records urgency, and invalid input leaves work unchanged', async () => {
  const colleague = await h.start({ agent: 'moss' });
  const ceo = await h.start({ agent: 'juno' });
  assert.equal(
    (await h.agent('urgent', colleague.token, { level: 'milestone', id: 'office', urgent: true })).status,
    400,
  );
  for (const body of [
    { level: 'unknown', id: 'office', urgent: true },
    { level: 'milestone', id: 'office', urgent: 'on' },
    { level: 'milestone', id: 'missing', urgent: true },
  ])
    assert.equal((await h.agent('urgent', ceo.token, body)).status, 400);
  assert.equal(urgency.projectUrgent('office'), false);
});
