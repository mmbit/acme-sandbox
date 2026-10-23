// node --test src/agent-state.test.ts   (an agent's state on its card: idle only once none of its jobs is running)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('agent-state');
const { status } = await import('./events.ts');

test('an agent with another job still running stays at work on it as one ends, pauses or parks', async () => {
  const intercom = await h.start({ agent: 'moss', title: 'Intercom chat with the board' });
  const zine = await h.start({ agent: 'moss', title: 'The zine’s proof' });
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'The zine’s proof']);
  await h.finish(zine);
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'Intercom chat with the board']);
  const again = await h.start({ agent: 'moss', title: 'The zine, again' });
  await h.finish(again, { status: 'limited', resetAt: Date.now() + 3_600_000 });
  assert.equal(status.get('moss')?.state, 'working');
  const asks = await h.start({ agent: 'moss', title: 'A card' });
  await h.park(asks, {});
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'Intercom chat with the board']);
  // none left running: idle
  await h.finish(intercom);
  assert.equal(status.get('moss')?.state, 'idle');
});

test("a review loop's job is at work under its whole name: its step, the work's title and its round", async () => {
  const review = await h.start({ agent: 'kit', title: 'Gift wrap at checkout', step: 'Reviewing', round: 2 });
  assert.equal(status.get('kit')?.task, 'Reviewing: Gift wrap at checkout (round 2)');
  const other = await h.start({ agent: 'kit', title: 'The zine' });
  await h.finish(other);
  assert.equal(status.get('kit')?.task, 'Reviewing: Gift wrap at checkout (round 2)', 'and again once the other ends');
  status.clear();
  // @ts-expect-error the query makes a fresh copy of the module (a restart), a path TypeScript can't resolve
  await import('./jobs.ts?named');
  assert.equal(status.get('kit')?.task, 'Reviewing: Gift wrap at checkout (round 2)', 'and after a restart');
  await h.finish(review);
});

test('a restart forgets every state, but an agent with a job running is at work on it from the start', async () => {
  const forty = await h.start({ agent: 'wren', title: 'The forty' });
  status.clear();
  // @ts-expect-error the query makes a fresh copy of the module (a restart), a path TypeScript can't resolve
  await import('./jobs.ts?restart');
  assert.deepEqual([status.get('wren')?.state, status.get('wren')?.task], ['working', 'The forty']);
  assert.equal(status.get('moss'), undefined, 'idle agents stay as they were: no state');
  await h.finish(forty);
});

test('a run cut off without a word rests its agent as the stale sweep puts it back, unless another of theirs runs', async () => {
  const intercom = await h.start({ agent: 'moss', title: 'Intercom chat with the board' });
  const zine = await h.start({ agent: 'moss', title: 'The zine’s proof' });
  const lost = async (job: { id: number }) => {
    h.db.prepare('update jobs set heartbeat = 0 where id = ?').run(job.id);
    assert.equal(await h.claim(), null); // nothing for this engine: only the claim's sweep
    assert.equal(h.job(job.id).status, 'queued');
  };
  await lost(zine);
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['working', 'Intercom chat with the board']);
  await lost(intercom);
  assert.deepEqual([status.get('moss')?.state, status.get('moss')?.task], ['sleeping', 'Paused']);
});
