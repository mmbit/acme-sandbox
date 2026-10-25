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
const threadends = await import('./threadends.ts');
const ordering = await import('./ordering.ts');

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

test("the CEO's ask from the intercom takes its window as it's queued, or is refused until it says it has none", async () => {
  const token = await intercom();
  const ask = (more: Record<string, unknown>) =>
    h.agent('job', token, { agent: 'kit', title: 'The names fall back', prompt: 'x', ...more });

  const untimed = opened();
  const refused = await ask({ thread: untimed });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /the board's ask \(on the intercom\).*--by <when>.*--by none/s);
  assert.equal((db.prepare("select count(*) n from jobs where title = 'The names fall back'").get() as any).n, 0);

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
  assert.deepEqual(toCeo(), [], "the CEO's own ask is asked in its own run");
});

test("on a live call its agent judges the time, never asking the board; another agent's follow-up handing out its item asks the CEO", async () => {
  const plain = opened();
  const call = await liveCall('kit');
  const queued = await h.agent('job', call, { agent: 'bolt', title: 'The phone logs', prompt: 'x', thread: plain });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.match(
    queued.body.untimed,
    new RegExp(`Don't ask the board by when.*\\(${queued.body.id}\\): its thread.*untimed`),
  );
  const loose = await h.agent('job', call, { agent: 'bolt', title: 'The phone bill', prompt: 'x' });
  assert.equal(loose.status, 200, JSON.stringify(loose.body));
  assert.match(loose.body.untimed, /in no thread.*\(\d+\), with the open thread it serves/);

  // a promise with its time, handed out: its thread's window, and nobody asked
  const promise = await h.agent('item', call, { kind: 'promise', owner: 'bolt', what: 'The logs', deadline: '2h' });
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

  // kit's follow-up hands out an item with no time: the CEO is asked
  assert.equal(
    (await h.voice('call-end', { agent: 'kit', lines: ['Board: read the logs.'], request: 0, token: call })).status,
    200,
  );
  const followUp = (
    db.prepare("select job from calls where agent = 'kit' order by id desc limit 1").get() as { job: number }
  ).job;
  const run = await h.claimJob(followUp);
  const task = await h.agent('item', run.token, {
    kind: 'task',
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
  assert.equal(out.body.askedCeo, 'juno');
  assert.match(toCeo()[0].text, new RegExp(`Job #${out.body.id} for bolt .*board's ask \\(from a call\\)`));

  // an agent's own work isn't an ask
  const handOn = await h.agent('job', run.token, {
    agent: 'bolt',
    title: 'Its follow-on',
    prompt: 'x',
    thread: plain,
  });
  assert.equal(handOn.status, 200, JSON.stringify(handOn.body));
  assert.equal(handOn.body.untimed ?? handOn.body.askedCeo, undefined);
  assert.equal(toCeo().length, 1);
});

test("a promise on a live call about its owner's work under way is linked to it, and its thread takes the time at once", async () => {
  const fallback = opened();
  const work = await h.start({ agent: 'wren', title: 'The names fall back', thread: fallback });
  const call = await liveCall('juno');
  const promise = await h.agent('item', call, {
    kind: 'promise',
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
  const first = await h.agent('item', call, { kind: 'promise', owner: 'wren', what: 'The names' });
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
    [{ deadline: '40m', job: loose.id }, 409, /in no thread: note the promise without it/],
    [{ deadline: '40m', job: loose.id, thread: opened() }, 409, /wasn't queued on this call/],
    [{ deadline: '40m', job: carrying.body.id }, 409, /carries item #\d+ already/],
  ] as const) {
    const before = items();
    const refused = await h.agent('item', call, { kind: 'promise', owner: 'wren', what: 'x', ...body });
    assert.equal(refused.status, status, JSON.stringify(refused.body));
    assert.match(refused.body.error, error);
    assert.equal(items(), before, 'nothing recorded');
  }
});

// Last: it switches planning by threads on, which the claim orders needs by.
test('work a timed thread with no task yet needs takes its window: the claim gives it a latest start', async () => {
  writeFileSync(`${h.repo}/company/projects.yaml`, `planning: threads\n${PROJECTS}`);
  threadends.watch();
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
