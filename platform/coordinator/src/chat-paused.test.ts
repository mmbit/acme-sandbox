// node --test src/chat-paused.test.ts: the intercom's turn when it can't start. HQ says why it waits, only the
// intercom's slot takes it, and a limit doesn't hold it for its seat's reset.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Running } from './harness.ts';

const h = await harness('chat-paused');
const say = async (text: string) => assert.equal((await h.board('/api/chat', { text })).status, 200);
// a claim on a seat of the worker's: the intercom's slot (chat) or an ordinary one
const claim = async (seat: string, chat = false) => {
  const job = await h.claim(seat.split('-')[0], { seat, util: 0, ...(chat ? { kind: 'chat' } : {}) });
  return job && ({ ...job, seat } as Running);
};
const seats = async (...states: [string, string, number?][]) => {
  for (const [seat, state, until] of states)
    await h.worker('seat', { seat, engine: 'claude', state, until, util: 0.5 });
};
const chat = async () => (await h.board('/api/chat')).body as { thinking: boolean | string; paused: unknown };

test("the board's turn is the intercom slot's alone: an ordinary slot takes other work, never the turn", async () => {
  await say('Is the back link fixed?');
  const work = h.queue({ agent: 'bolt', engine: 'claude' });
  assert.equal(
    (await claim('claude-1'))?.id,
    work,
    'an ordinary slot takes the work, though the turn is first in line',
  );
  assert.equal(await claim('claude-1'), null);
  const turn = (await claim('claude-1', true))!;
  assert.equal(turn.kind, 'chat', "the intercom's slot takes the turn");
  await h.finish(turn, { result: 'Yes.' });
});

test("a turn its seat's limit stopped waits for no reset: the intercom's slot takes it on the next seat with room", async () => {
  const reset = Date.now() + 2 * 86400e3;
  await seats(['claude-1', 'sleeping', reset], ['claude-2', 'draining', Date.now() + 86400e3]);
  await say('Did that come through?');
  const turn = (await claim('claude-1', true))!;
  await h.finish(turn, { status: 'limited', seat: 'claude-1', resetAt: reset });
  assert.deepEqual([h.job(turn.id).status, h.job(turn.id).until], ['queued', null], 'not held until claude-1 resets');
  const again = (await claim('claude-2', true))!;
  assert.equal(again.id, turn.id, "the draining seat, the board's reserve, takes it");
  assert.match(again.note, /^You were paused/);
  await h.finish(again, { result: 'It did.' });
  // work stopped the same way still waits for its own seat's reset, or a seat with room (unchanged)
  h.queue({ agent: 'bolt', engine: 'claude' });
  const work = (await claim('claude-1'))!;
  await h.finish(work, { status: 'limited', seat: 'claude-1', resetAt: reset });
  assert.equal(h.job(work.id).until, reset);
});

test('HQ hears why the turn waits instead of "thinking": a quiet worker, every seat at its limit, a try later', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    await say('Bit hard to find the way back to the store from these pages');
    const now = await chat();
    assert.deepEqual([now.thinking, now.paused], [true, null], 'a turn the worker is about to take is under way');
    mock.timers.tick(61_000);
    assert.deepEqual(
      (await chat()).paused,
      { why: 'restarting' },
      'a worker quiet for a minute runs nothing: restarting',
    );
    let turn = (await claim('claude-1', true))!;
    assert.equal((await chat()).paused, null, 'running, with the worker there: thinking');
    mock.timers.tick(61_000);
    assert.deepEqual((await chat()).paused, { why: 'restarting' }, 'a running turn too, once its worker is quiet');
    await h.finish(turn, { status: 'interrupted' });
    const back = Date.now() + 3 * 3600e3;
    await seats(['claude-1', 'sleeping', back + 3600e3], ['claude-2', 'sleeping', back]);
    assert.deepEqual(
      (await chat()).paused,
      { why: 'seat', until: back },
      'every seat at its limit: back when the first wakes',
    );
    await seats(['claude-2', 'draining', back]);
    assert.equal((await chat()).paused, null, "a draining seat is the board's reserve: the turn can run");
    turn = (await claim('claude-2', true))!;
    await h.finish(turn, { status: 'failed', result: 'the CLI crashed' });
    assert.deepEqual(
      (await chat()).paused,
      { why: 'later', until: Date.now() + 120_000 },
      'a failed try, tried again in two minutes',
    );
    mock.timers.tick(121_000);
    await seats(['claude-1', 'login'], ['claude-2', 'login']);
    assert.deepEqual((await chat()).paused, { why: 'signin' });
    await h.finish((await claim('claude-2', true))!, { result: 'Fixed.' });
    assert.equal((await chat()).paused, null, 'answered: nothing waits');
  } finally {
    mock.timers.reset();
  }
});

test("a turn for a Codex CEO is an ordinary Codex slot's: the intercom slot is Claude's", async () => {
  const id = h.queue({ agent: 'bolt', kind: 'chat', engine: 'codex' });
  assert.equal(await claim('claude-1', true), null);
  assert.equal((await claim('codex-1'))?.id, id);
});
