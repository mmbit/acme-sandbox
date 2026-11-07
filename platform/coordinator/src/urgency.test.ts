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

test("the whole milestone is urgency's plain form, and each answer says what the choice leaves out", async () => {
  const ceo = await h.start({ agent: 'juno' });
  const made = await h.hq(ceo, 'project', 'new', 'shelf', 'The shelf', '--code', 'SHF', '--owner', 'juno');
  assert.equal(made.code, 0, made.out);
  const draw = (slug: string, name: string) => {
    assert.notEqual(typeof projects.createThread({ project: 'shelf', slug, name, goal: 'It ships' }), 'string');
    return `shelf/${slug}`;
  };
  const [books, tips] = [draw('books', 'Books'), draw('tips', 'Tips')];
  const paused = await h.hq(ceo, 'deliverable', 'pause', tips, 'Held for the board', '--by-hand');
  assert.match(
    paused.out,
    /1 other open deliverable of shelf, and any filed there later, go on: hq project pause shelf/,
  );
  const piece = await h.hq(ceo, 'urgent', 'job', books);
  assert.equal(piece.code, 0, piece.out);
  assert.match(piece.out, /Still on pacing: The shelf's 1 other open deliverable, work filed under The shelf later/);
  assert.match(piece.out, /hq urgent shelf marks the whole milestone/);
  const whole = await h.hq(ceo, 'urgent', 'shelf');
  assert.equal(whole.code, 0, whole.out);
  assert.match(whole.out, /It covers its 2 open deliverables and all work filed under The shelf later/);
  assert.match(whole.out, /Kept out by their own pause, which holds urgent work: Tips/);
  const later = h.queue({ agent: 'bolt', thread: draw('fitted', 'Fitted') });
  assert.equal(urgency.taskUrgent(later), true, 'work filed after the mark inherits it');
});

test('task urgency carries into its reviews and fixes and clears without changing sibling tasks', async () => {
  const ceo = await h.start({ agent: 'juno' });
  const thread = opened('reviews');
  const source = h.queue({ agent: 'bolt', thread });
  const sibling = h.queue({ agent: 'kit', thread });
  const branch = `job/${source}`;
  assert.equal(urgency.urgentBranches([branch]).has(branch), false);
  const review = h.queue({ agent: 'wren', kind: 'review', branch, pr: 912 });
  const fix = h.queue({ agent: 'bolt', kind: 'work', stage: 'fix', branch, pr: 912 });
  assert.equal((await h.agent('urgent', ceo.token, { level: 'task', id: String(source), urgent: true })).status, 200);
  for (const id of [source, review, fix]) assert.equal(urgency.taskUrgent(id), true);
  assert.equal(urgency.urgentBranches([branch]).has(branch), true);
  assert.equal(urgency.taskUrgent(sibling), false);
  assert.equal((await h.agent('urgent', ceo.token, { level: 'task', id: String(source), urgent: false })).status, 200);
  for (const id of [source, review, fix]) assert.equal(urgency.taskUrgent(id), false);
  assert.equal(urgency.urgentBranches([branch]).has(branch), false);
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

test("one job's urgency is read through its own thread and project, never a view built of every thread", async () => {
  const { db } = await import('./db.ts');
  for (const view of ['urgent_tasks', 'urgent_work']) {
    const plan = (
      db.prepare(`explain query plan select urgent from ${view} where id = ?`).all(1) as { detail: string }[]
    )
      .map(step => step.detail)
      .join('\n');
    assert.doesNotMatch(plan, /MATERIALIZE|SCAN|AUTOMATIC/, `${view}:\n${plan}`);
  }
});

test("a job's checks go first while its work is urgent or has a window, its own or its line's, as its heartbeat says", async () => {
  const { db } = await import('./db.ts');
  const ceo = await h.start({ agent: 'juno' });
  const plain = await h.start({ agent: 'bolt', thread: opened('plain') });
  const urgent = await h.start({ agent: 'kit', thread: opened('first') });
  const due = h.dueThread({ deadline: Date.now() + 3_600_000 });
  const windowed = await h.start({ agent: 'wren', thread: due });
  db.prepare(
    `insert into threads (id, project, name, goal, created, deadline_from) values ('due/after', 'due', 'After', 'It ships', ?, ?)`,
  ).run(new Date().toISOString(), due);
  const following = await h.start({ agent: 'moss', thread: 'due/after' });
  const undated = await h.start({ agent: 'chime', thread: h.dueThread() });
  const first = async (job: { id: number; seat: string; token: string; agent: string }) =>
    (await h.heartbeat(job)).body.first === true;
  assert.equal(await first(urgent), false);
  assert.equal((await h.hq(ceo, 'urgent', 'task', String(urgent.id))).code, 0);
  assert.deepEqual(await Promise.all([plain, urgent, windowed, following, undated].map(first)), [
    false,
    true,
    true,
    true,
    false,
  ]);
  assert.equal((await h.hq(ceo, 'urgent', 'task', String(urgent.id), 'off')).code, 0);
  assert.equal(await first(urgent), false);
  for (const job of [plain, urgent, windowed, following, undated, ceo]) await h.finish(job);
});

test("a job's checks' turn reads its own thread's line, never every thread's window", async () => {
  const { db } = await import('./db.ts');
  const plan = (db.prepare(`explain query plan select ${urgency.checksFirstSql('?1')}`).all(1) as { detail: string }[])
    .map(step => step.detail)
    .join('\n');
  assert.doesNotMatch(plan, /SCAN (t|w|fj|threads|jobs)\b|AUTOMATIC/, plan);
});
