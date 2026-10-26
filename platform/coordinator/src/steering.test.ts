// node --test src/steering.test.ts (held work through hq, with a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { completionHooks } from '../../worker/src/completion.ts';
import type { Running } from './harness.ts';
import { projectsHarness } from './projects.fixture.ts';
import { followthroughFixture } from './followthrough.fixture.ts';

const { h, thread, engineOf } = await projectsHarness('steering');
const { db } = h;
const pauses = await import('./pauses.ts');
const messages = await import('./messages.ts');
const { ceo, roles } = await import('./company.ts');
const { agreed } = await followthroughFixture(h);
const logged = (agent: string, why: string) =>
  assert.ok(db.prepare('select 1 from events where agent = ? and instr(text, ?) > 0').get(agent, why), why);

const HQ = new URL('../../worker/bin/hq', import.meta.url).pathname;

async function inboxHook(job: Running, event: 'PostToolUse' | 'Stop') {
  const configured: Record<string, { hooks: { command: string }[] }[] | undefined> = completionHooks(job.kind, {
    hq: `bash ${HQ}`,
    messages: true,
  });
  const hooks = configured[event];
  assert.ok(hooks?.length, `${job.kind} has a ${event} inbox hook`);
  let output = '';
  for (const entry of hooks)
    for (const hook of entry.hooks) {
      const child = spawn('bash', ['-c', hook.command], {
        env: { PATH: process.env.PATH, HQ_URL: h.base, HQ_TOKEN: job.token, HQ_AGENT: job.agent },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let error = '';
      child.stdout.on('data', chunk => {
        output += chunk;
      });
      child.stderr.on('data', chunk => {
        error += chunk;
      });
      child.stdin.end(JSON.stringify({ hook_event_name: event }));
      const code = await new Promise(resolve => child.on('close', resolve));
      assert.equal(code, 0, error);
    }
  return output;
}

test.beforeEach(() =>
  db.exec(`delete from jobs; delete from threads; delete from thread_needs; delete from pauses;
  delete from pause_until; delete from messages; delete from calls; delete from call_items; delete from prs; delete from decisions`),
);

test('the owner and CEO amend a pause in place with their reason while other agents cannot', async () => {
  const levels = thread('levels');
  const owner = await h.start({ agent: 'wren' });
  const chief = await h.start({ agent: ceo() });
  const other = await h.start({ agent: 'kit' });
  const held = h.queue({ agent: 'kit', thread: levels });
  const first = await h.hq(owner, 'project', 'pause', 'game', 'Wait for the result', '--by-hand');
  assert.equal(first.code, 0, first.out);
  const id = pauses.open()[0].id;
  for (const actor of [owner, chief]) {
    const why = `Still missing the result, judged by ${actor.agent}`;
    const changed = await h.hq(actor, 'project', 'pause', 'game', why, '--until-time', '2h');
    assert.equal(changed.code, 0, changed.out);
    assert.equal(pauses.open()[0].id, id);
    assert.equal(pauses.open()[0].why, why);
    assert.equal(await h.claim(engineOf(held)), null);
    logged(actor.agent, why);
  }
  assert.notEqual((await h.hq(other, 'project', 'pause', 'game', 'Let it run', '--by-hand')).code, 0);
  assert.equal(pauses.open()[0].id, id);
});

test('only the pause owner or CEO can move held jobs and threads out, with a reason on the feed', async () => {
  const chief = await h.start({ agent: ceo() });
  const owner = await h.start({ agent: 'wren' });
  const other = await h.start({ agent: 'kit' });
  const destination = thread('destination', 'shop');
  assert.equal(typeof pauses.pause({ project: 'game', why: 'Hold game work', byHand: true }, 'wren'), 'object');
  for (const actor of [owner, chief]) {
    const source = thread(`source-${actor.agent}`);
    const held = h.queue({ agent: 'kit', thread: source });
    assert.notEqual((await h.hq(other, 'job', 'move', String(held), destination, '--why', 'Escape the hold')).code, 0);
    assert.notEqual((await h.hq(actor, 'job', 'move', String(held), destination)).code, 0);
    const why = `Separate the HQ repair, judged by ${actor.agent}`;
    const moved = await h.hq(actor, 'job', 'move', String(held), destination, '--why', why);
    assert.equal(moved.code, 0, moved.out);
    assert.equal(h.job(held).thread, destination);
    logged(actor.agent, why);
    const threadWhy = `Separate the repair thread, judged by ${actor.agent}`;
    const movedThread = await h.hq(actor, 'thread', 'move', source, 'shop', '--why', threadWhy);
    assert.equal(movedThread.code, 0, movedThread.out);
    logged(actor.agent, threadWhy);
  }
  assert.equal(pauses.open().length, 1, 'the source pause stays on');
});

test('the CEO and Process add waits to HQ jobs with reasons while their ordinary owner cannot', async () => {
  const prerequisite = h.queue({ agent: 'moss' });
  const owner = await h.start({ agent: 'kit' });
  for (const agent of [ceo(), roles().process]) {
    const actor = await h.start({ agent });
    const held = h.queue({ agent: 'kit', stage: 'fix', pr: 91 });
    assert.notEqual(
      (await h.hq(owner, 'waits', String(held), 'add', String(prerequisite), '--why', 'Wait for the repair')).code,
      0,
    );
    assert.notEqual((await h.hq(actor, 'waits', String(held), 'add', String(prerequisite))).code, 0);
    const why = `This fix needs the repair first, judged by ${agent}`;
    const added = await h.hq(actor, 'waits', String(held), 'add', String(prerequisite), '--why', why);
    assert.equal(added.code, 0, added.out);
    assert.ok(h.jobs.outstandingWaits(held).some(w => w.id === prerequisite));
    logged(agent, why);
  }
});

test('the CEO links another calls held item with a reason while an unrelated agent cannot', async () => {
  const chief = await h.start({ agent: ceo() });
  const other = await h.start({ agent: 'kit' });
  const { item } = agreed({ kind: 'decision' }, Date.now(), 'moss');
  assert.equal(typeof pauses.pause({ project: 'game', why: 'Hold game work', byHand: true }, 'wren'), 'object');
  assert.notEqual((await h.hq(other, 'item', 'link', String(item), 'pause:game', '--why', 'Keep this hold')).code, 0);
  assert.notEqual((await h.hq(chief, 'item', 'link', String(item), 'pause:game')).code, 0);
  const why = 'The game hold is the work this decision governs';
  const linked = await h.hq(chief, 'item', 'link', String(item), 'pause:game', '--why', why);
  assert.equal(linked.code, 0, linked.out);
  assert.equal(pauses.open()[0].item, item);
  logged(ceo(), why);
});

test('an idle CEOs message reaches the next run despite the desk pause and returns there if unread', async () => {
  const sender = await h.start({ agent: 'kit' });
  assert.equal(
    typeof pauses.pause({ project: 'unsorted', why: 'Hold Front Desk work', byHand: true }, ceo()),
    'object',
  );
  const why = 'The hold needs your judgment because the repair is ready';
  const said = await h.hq(sender, 'say', ceo(), why);
  assert.equal(said.code, 0, said.out);
  messages.sweep();
  assert.equal(db.prepare('select count(*) n from jobs where agent = ?').get(ceo())!.n, 0);
  logged(sender.agent, why);
  // The next ordinary run reads it without creating another job on the desk.
  const next = await h.start({ agent: ceo(), thread: thread('next-check', 'shop') });
  const inbox = await h.agent('inbox', next.token, {});
  assert.equal(inbox.status, 200);
  assert.ok(inbox.body.some((m: { text: string }) => m.text === why));
  await h.finish(next, { status: 'yielded' });
  messages.sweep();
  const chat = await h.start({ agent: ceo(), kind: 'chat' });
  assert.ok((await inboxHook(chat, 'PostToolUse')).includes(why), 'an unacknowledged offer reaches intercom');
  const message = inbox.body.find((m: { text: string }) => m.text === why);
  const delivery = (await h.agent(`sent?id=${message.message}`, sender.token)).body[0];
  assert.ok(delivery.delivered, 'the configured hook acknowledges the message');
  assert.equal(delivery.job, chat.id);
  assert.equal(await inboxHook(chat, 'PostToolUse'), '');
  await h.finish(chat);

  const later = await h.claimJob(next.id);
  assert.equal(later.id, next.id);
  const last = 'The repair result is ready for the next judgment';
  assert.equal((await h.hq(sender, 'say', ceo(), last)).code, 0);
  assert.ok((await h.agent('inbox', later.token, {})).body.some((m: { text: string }) => m.text === last));
  await h.finish(later);
  messages.sweep();
  const finalChat = await h.start({ agent: ceo(), kind: 'chat' });
  const stopped = JSON.parse(await inboxHook(finalChat, 'Stop'));
  assert.equal(stopped.decision, 'block');
  assert.ok(stopped.reason.includes(last));
  assert.equal(await inboxHook(finalChat, 'Stop'), '');
});

test('a correction for a paused CEO job stays there while another CEO run reads its inbox', async () => {
  const sender = await h.start({ agent: 'kit' });
  const chief = await h.start({ agent: ceo(), engine: 'claude' });
  await h.finish(chief, { status: 'interrupted', session: 'kept-ceo-session' });
  const correction = 'Stop the old work: the board replaced the call item';
  const sent = messages.send({ agent: sender.agent, job: sender.id }, ceo(), correction, chief.id);
  assert.equal(typeof sent, 'object');
  const id = (sent as { id: number }).id;
  const other = await h.start({ agent: ceo(), kind: 'chat' });
  assert.equal(await inboxHook(other, 'PostToolUse'), '');
  assert.deepEqual((await h.agent('inbox-ack', other.token, { ids: [id] })).body.delivered, []);
  messages.sweep();
  const waiting = (await h.agent(`sent?id=${id}`, sender.token)).body[0];
  assert.equal(waiting.job, chief.id);
  assert.equal(waiting.delivered, null);
  await h.finish(other);
  const resumed = await h.claim('claude');
  assert.equal(resumed?.id, chief.id);
  assert.ok((await h.agent('inbox', resumed!.token, {})).body.some((m: { text: string }) => m.text === correction));
  await h.finish(resumed!);
  messages.sweep();
  const ended = (await h.agent(`sent?id=${id}`, sender.token)).body[0];
  assert.ok(ended.became, 'an unread targeted correction follows ordinary job-end delivery');
});

test('a needed CEO answer gets independent work when idle or when its running job ends unread', async () => {
  const callerThread = thread('caller');
  const sender = await h.start({ agent: 'kit', thread: callerThread });
  for (const running of [false, true]) {
    const chief = running ? await h.start({ agent: ceo(), engine: 'claude' }) : null;
    const said = await h.hq(sender, 'say', '--needs-answer', ceo(), `Need your judgment during this run: ${running}`);
    assert.equal(said.code, 0, said.out);
    if (chief) await h.finish(chief);
    messages.sweep();
    const sent = (await h.agent('sent', sender.token)).body[0];
    assert.ok(sent.became, 'the answer has its own job rather than waiting for another CEO run');
    assert.equal(sent.needsAnswer, true);
    const answer = h.job(sent.became);
    assert.notEqual(answer.thread, callerThread);
    assert.ok(answer.thread.startsWith('game/'), 'the answer stays in the callers project');
    assert.ok(!h.jobs.outstandingWaits(answer.id).some(wait => wait.id === sender.id));
  }
});

test('a reason does not let the CEO shed a board decision or add a card answer to a started prompt', async () => {
  const chief = await h.start({ agent: ceo() });
  const source = thread('held');
  const destination = thread('repair', 'shop');
  const held = h.queue({ agent: 'kit', thread: source });
  const decision = await h.agent('decisions', chief.token, { name: 'Choose the direction', blocks: ['game'] });
  assert.equal(decision.status, 200);
  const why = 'This work needs to move first';
  for (const command of [
    ['job', 'move', String(held), destination, '--why', why],
    ['thread', 'move', source, 'shop', '--why', why],
    ['project', 'pause', 'game', why, '--by-hand'],
  ])
    assert.notEqual((await h.hq(chief, ...command)).code, 0);
  assert.equal(h.job(held).thread, source);
  assert.equal(pauses.open()[0].decision?.id, decision.body.id);

  const card = await h.ask(chief);
  const started = await h.start({ agent: 'kit', thread: destination });
  await h.finish(started, { status: 'yielded', session: 'already-read' });
  const added = await h.hq(chief, 'waits', String(started.id), 'add', `request:${card}`, '--why', 'Needs the answer');
  assert.notEqual(added.code, 0);
  assert.equal(db.prepare('select session from jobs where id = ?').get(started.id)!.session, 'already-read');
  assert.equal(db.prepare('select count(*) n from request_waits where job = ?').get(started.id)!.n, 0);
});
