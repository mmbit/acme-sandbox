// node --test src/askwindow.test.ts   (throwaway DATA_DIR and the test company)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const PROJECTS = 'projects:\n  - { id: shop, name: The shop, owner: moss }\n';
const h = await harness('askwindow', { before: repo => writeFileSync(`${repo}/company/projects.yaml`, PROJECTS) });
const { db } = h;
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const ordering = await import('./ordering.ts');
const backlog = await import('./backlog.ts');
const planner = await import('./planner.ts');
const forecast = await import('./forecast.ts');
const threats = await import('./threats.ts');

const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
const thread = (id: string) =>
  db.prepare('select deadline, aim, deadline_by from threads where id = ?').get(id) as {
    deadline: number | null;
    aim: number | null;
    deadline_by: string | null;
  };
let threads = 0;
const opened = () => {
  const t = projects.createThread({ project: 'shop', name: `Shop work ${++threads}`, goal: 'It sells' });
  if (typeof t === 'string') throw new Error(t);
  return t.id;
};
// The CEO's intercom, as the worker starts its turn: its token (the same turn for every test: it's still running).
let chat: string | undefined;
async function intercom() {
  if (chat) return chat;
  assert.equal(
    (await h.board('/api/chat', { text: 'The names need a fallback before my 15:00 meeting.' })).status,
    200,
  );
  const turn = db.prepare("select id from jobs where kind = 'chat' order by id desc limit 1").get() as { id: number };
  return (chat = (await h.claimJob(turn.id)).token);
}
const liveCall = async (agent: string) => (await h.liveCall(agent)).token;
// The CEO's messages from this test on.
let since = 0;
const toCeo = () =>
  db.prepare("select text from messages where recipient = 'juno' and id > ? order by id").all(since) as {
    text: string;
  }[];
const items = () => (db.prepare('select count(*) n from call_items').get() as { n: number }).n;

beforeEach(() => {
  h.cancelQueued();
  since = (db.prepare('select coalesce(max(id), 0) id from messages').get() as { id: number }).id;
});

test("the CEO's asks join their deliverable without a task deadline, including when its deadline is unset", async () => {
  const token = await intercom();
  const ask = (more: Record<string, unknown>) =>
    h.agent('job', token, { agent: 'kit', title: 'The names fall back', prompt: 'x', ...more });

  const untimed = opened();
  const filed = await ask({ thread: untimed });
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.equal(filed.body.askedCeo ?? filed.body.untimed, undefined);
  assert.equal(thread(untimed).deadline, null);

  const unfiled = await ask({});
  assert.equal(unfiled.status, 409, 'unfiled board asks keep their existing flags');
  assert.equal((await ask({ by: 'none' })).status, 200);

  const before = Date.now();
  const timed = await ask({ thread: untimed, by: '2h' });
  assert.equal(timed.status, 200, JSON.stringify(timed.body));
  const window = thread(untimed);
  assert.ok(window.deadline! >= before + 2 * HOUR && window.deadline! <= Date.now() + 2 * HOUR, 'two hours on');
  assert.deepEqual([window.aim, window.deadline_by], [window.deadline, 'juno']);
  assert.equal(timed.body.deadline, new Date(window.deadline!).toISOString());

  // a deliverable's window, named with --by
  const meeting = h.dueThread({ deadline: Date.now() + 3 * HOUR });
  const named = opened();
  assert.equal((await ask({ thread: named, by: meeting })).status, 200);
  assert.equal(thread(named).deadline, thread(meeting).deadline);

  const none = opened();
  assert.equal((await ask({ thread: none, by: 'none' })).status, 200);
  assert.equal(thread(none).deadline, null);
  assert.equal((await ask({ thread: none, by: 'soon' })).status, 400);
  assert.equal((await ask({ thread: none, by: opened() })).status, 400, 'a deliverable without a window gives none');

  // --by never loosens a window its thread has
  const tight = h.dueThread({ deadline: Date.now() + HOUR });
  assert.equal((await ask({ thread: tight, by: '3h' })).status, 200);
  assert.ok(thread(tight).deadline! < Date.now() + HOUR, 'its own, earlier window stays');
  assert.deepEqual(toCeo(), [], 'filed asks need no task-level question');
});

test("call tasks use their deliverable's deadline and an unset deadline never asks the CEO task by task", async () => {
  const plain = opened();
  // (moss's call, the shop's owner: anyone else's follow-up adds no task to a shop thread)
  const call = await liveCall('moss');
  const queued = await h.agent('job', call, { agent: 'bolt', title: 'The phone logs', prompt: 'x', thread: plain });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(queued.body.untimed ?? queued.body.askedCeo, undefined);
  const loose = await h.agent('job', call, { agent: 'bolt', title: 'The phone bill', prompt: 'x' });
  assert.equal(loose.status, 200, JSON.stringify(loose.body));
  assert.match(loose.body.untimed, /in no deliverable.*\(\d+\), with the open deliverable it serves/);

  // a promise with its time, handed out: its thread's window, and nobody asked
  const promise = await h.agent('item', call, {
    kind: 'promise',
    goal: 'The board wants it on time.',
    owner: 'bolt',
    what: 'The logs',
    deadline: '2h',
  });
  const handed = await h.agent('job', call, {
    agent: 'bolt',
    title: 'The logs read',
    prompt: 'x',
    item: promise.body.id,
    thread: opened(),
  });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.ok(handed.body.deadline);
  assert.equal(handed.body.untimed, undefined);

  // A follow-up files an untimed item under the same deliverable.
  assert.equal(
    (await h.voice('call-end', { agent: 'moss', lines: ['Board: read the logs.'], request: 0, token: call })).status,
    200,
  );
  const followUp = (
    db.prepare("select job from calls where agent = 'moss' order by id desc limit 1").get() as { job: number }
  ).job;
  const run = await h.claimJob(followUp);
  const task = await h.agent('item', run.token, {
    kind: 'task',
    goal: 'The board wants it on time.',
    owner: 'bolt',
    what: 'Read the logs',
    quote: 'Board: read the logs.',
  });
  assert.equal(task.status, 200, JSON.stringify(task.body));
  const out = await h.agent('job', run.token, {
    agent: 'bolt',
    title: 'Logs',
    prompt: 'x',
    item: task.body.id,
    thread: plain,
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.askedCeo ?? out.body.untimed, undefined);
  assert.deepEqual(toCeo(), []);

  // an agent's own work isn't an ask
  const handOn = await h.agent('job', run.token, {
    agent: 'bolt',
    title: 'Its follow-on',
    prompt: 'x',
    thread: plain,
  });
  assert.equal(handOn.status, 200, JSON.stringify(handOn.body));
  assert.equal(handOn.body.untimed ?? handOn.body.askedCeo, undefined);
  assert.equal(toCeo().length, 0);
});

test("a promise on a live call about its owner's work under way is linked to it, and its thread takes the time at once", async () => {
  const fallback = opened();
  const work = await h.start({ agent: 'wren', title: 'The names fall back', thread: fallback });
  const call = await liveCall('juno');
  const promise = await h.agent('item', call, {
    kind: 'promise',
    goal: 'The board wants it on time.',
    owner: 'wren',
    what: 'The fallback is live',
    deadline: '40m',
    job: work.id,
  });
  assert.equal(promise.status, 200, JSON.stringify(promise.body));
  const item = db.prepare('select due, job from call_items where id = ?').get(promise.body.id) as {
    due: number;
    job: number;
  };
  assert.equal(item.job, work.id, 'handled when that work ends done');
  assert.deepEqual([promise.body.job, promise.body.thread], [work.id, fallback]);
  assert.deepEqual(Object.values(thread(fallback)), [item.due, item.due, 'juno'], 'while the call is still on');

  // a job the call queued in no thread goes on the thread the promise names
  const queued = await h.agent('job', call, { agent: 'wren', title: 'The names list', prompt: 'x' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const list = opened();
  const named = await h.agent('item', call, {
    kind: 'promise',
    goal: 'The board wants it on time.',
    owner: 'wren',
    what: 'The list is in',
    deadline: '2h',
    job: queued.body.id,
    thread: list,
  });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(h.jobs.threadOf(queued.body.id), list);
  assert.equal(thread(list).deadline, new Date(named.body.deadline).getTime());

  // refused before anything is recorded: a misheard number (someone else's job), a time missing, work in no thread
  // without one, a thread for work the call didn't queue, and a job that carries another item (its link)
  const bolts = await h.start({ agent: 'bolt', title: 'The phone logs', thread: opened() });
  const loose = await h.start({ agent: 'wren', title: 'Loose', thread: null });
  const first = await h.agent('item', call, {
    kind: 'promise',
    goal: 'The board wants it on time.',
    owner: 'wren',
    what: 'The names',
  });
  const carrying = await h.agent('job', call, {
    agent: 'wren',
    title: 'The names',
    prompt: 'x',
    item: first.body.id,
    thread: opened(),
  });
  assert.equal(carrying.status, 200, JSON.stringify(carrying.body));
  for (const [body, status, error] of [
    [{ deadline: '40m', job: bolts.id }, 409, /is bolt's \(The phone logs\), not wren's: check the number/],
    [{ job: work.id }, 400, /goes with --deadline/],
    [{ deadline: '40m', job: loose.id }, 409, /in no deliverable: note the promise without it/],
    [{ deadline: '40m', job: loose.id, thread: opened() }, 409, /wasn't queued on this call/],
    [{ deadline: '40m', job: carrying.body.id }, 409, /carries item #\d+ already/],
  ] as const) {
    const before = items();
    const refused = await h.agent('item', call, {
      kind: 'promise',
      goal: 'The board wants it on time.',
      owner: 'wren',
      what: 'x',
      ...body,
    });
    assert.equal(refused.status, status, JSON.stringify(refused.body));
    assert.match(refused.body.error, error);
    assert.equal(items(), before, 'nothing recorded');
  }
});

test('work a timed thread with no task yet needs takes its window: the claim gives it a latest start', async () => {
  const token = await intercom();
  const meeting = h.dueThread({ deadline: Date.now() + 3 * HOUR }),
    serving = opened();
  assert.deepEqual(plan.need(meeting, serving, 'juno'), { ok: true });
  const served = await h.agent('job', token, { agent: 'kit', title: 'The room set up', prompt: 'x', thread: serving });
  assert.equal(served.status, 200, JSON.stringify(served.body));
  assert.equal(served.body.serves.thread, meeting);
  assert.equal(thread(serving).deadline, null, 'the claim orders it by the deliverable it serves: nothing is copied');
  const latest = ordering.current().timings.get(served.body.id)?.latestStart;
  assert.ok(latest != null && latest < thread(meeting).deadline!, 'its latest start comes before the meeting');
});

test('follow-ups inherit one changing deliverable deadline through the plan and pacing', async () => {
  const deliverable = opened();
  const owner = await h.start({ agent: 'moss', title: 'Make the shop', thread: deliverable });
  const queued = await h.agent('job', owner.token, { agent: 'kit', title: 'Draw the sign', prompt: 'x' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(h.jobs.threadOf(queued.body.id), deliverable);
  const ids = [owner.id, queued.body.id];
  const missing = threats
    .lines(forecast.refresh())
    .filter(line => line.includes(deliverable) && line.includes('no deadline set'));
  assert.equal(missing.length, 1, 'the gap shows once for the deliverable');
  for (const duration of ['2h', '3h']) {
    assert.equal((await h.agent('window', owner.token, { thread: deliverable, deadline: duration })).status, 200);
    const due = thread(deliverable).deadline;
    const snapshot = backlog.orderingSnapshot(Date.now());
    for (const id of ids) assert.equal(snapshot.jobs.find(j => j.id === id)?.due, due);
    const timing = ordering.current().timings.get(queued.body.id)!;
    assert.ok(timing.latestStart != null && timing.latestStart < due!);
    assert.equal(planner.pacedTakes(timing, due!), true, 'the inherited deadline passes pacing');
    assert.equal(
      threats.lines(forecast.refresh()).some(line => line.includes(deliverable) && line.includes('no deadline set')),
      false,
    );
  }
  const later = await h.agent('job', owner.token, { agent: 'kit', title: 'Hang the sign', prompt: 'x' });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(later.body.deadline, new Date(thread(deliverable).deadline!).toISOString());
});

test("the board's release follow-up inherits its deliverable's deadline and aim on its own thread", async () => {
  const token = await intercom();
  const deliverable = opened();
  const owner = await h.start({ agent: 'moss', title: 'Make the shop', thread: deliverable });
  const deadline = Date.now() + 3 * HOUR;
  const aim = deadline - HOUR;
  const windows = await import('./windows.ts');
  windows.set(projects.findThread(deliverable)!, { deadline, aim }, 'juno');
  const follow = await h.agent('job', token, {
    agent: 'kit',
    title: 'Check the live shop',
    prompt: 'Read the released work',
    thread: deliverable,
    when: [`deployed:${owner.id}`],
  });
  assert.equal(follow.status, 200, JSON.stringify(follow.body));
  const own = h.jobs.threadOf(follow.body.id)!;
  assert.notEqual(own, deliverable, 'release work has its own thread');
  assert.equal(follow.body.followOn, deliverable);
  assert.equal(follow.body.deadline, new Date(deadline).toISOString());
  const followWindow = projects.findThread(own)!;
  assert.deepEqual([followWindow.deadline, followWindow.aim], [deadline, aim]);
  assert.equal(follow.body.askedCeo ?? follow.body.untimed, undefined);
  assert.equal(toCeo().length, 0);
  const snapshot = backlog.orderingSnapshot(Date.now());
  assert.equal(snapshot.jobs.find(j => j.id === follow.body.id)?.due, deadline, 'pacing reads the inherited time');
});
