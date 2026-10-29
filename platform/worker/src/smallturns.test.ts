// node --test src/smallturns.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callsAsTheyCome } from './smallturns.ts';

// Calls due in a queue, each answered only when the test says so: what was claimed, in order
function queue(due: string[]) {
  const claimed: string[] = [],
    answers = new Map<string, () => void>();
  return {
    claimed,
    claim: async () => {
      const next = due.shift();
      if (!next) return false as const;
      claimed.push(next);
      return { answered: new Promise<void>(done => answers.set(next, done)) };
    },
    answer: (call: string) => answers.get(call)!(),
  };
}
const turn = () => new Promise(done => setImmediate(done));

test("a call due behind one still going is made at once, not after the first one's answer", async () => {
  // The board's handwriting being read, and the book's judge due behind it (29 Oct)
  const q = queue(['handwriting', 'judge']);
  let going = true;
  const loop = callsAsTheyCome({
    claim: q.claim,
    atOnce: 3,
    idleMs: 1000,
    going: () => going,
    sleep: turn,
    failed: err => assert.fail(String(err)),
  });
  await turn();
  assert.deepEqual(q.claimed, ['handwriting', 'judge'], 'the judge is claimed while the handwriting read goes');
  going = false;
  q.answer('handwriting');
  q.answer('judge');
  await loop;
});

test('no more than atOnce calls go together; the next is claimed as one ends', async () => {
  const q = queue(['a', 'b', 'c']);
  let going = true;
  const loop = callsAsTheyCome({
    claim: q.claim,
    atOnce: 2,
    idleMs: 1000,
    going: () => going,
    sleep: turn,
    failed: err => assert.fail(String(err)),
  });
  await turn();
  assert.deepEqual(q.claimed, ['a', 'b']);
  q.answer('a');
  await turn();
  await turn();
  assert.deepEqual(q.claimed, ['a', 'b', 'c']);
  going = false;
  q.answer('b');
  q.answer('c');
  await loop;
});

test('with nothing due it waits idleMs before it looks again, and a failed claim or call goes on', async () => {
  const slept: number[] = [],
    failed: unknown[] = [];
  let claims = 0;
  await callsAsTheyCome({
    claim: async () => {
      claims++;
      if (claims === 1) throw new Error('HQ away');
      if (claims === 2) return { answered: Promise.reject(new Error('the CLI died')) };
      return false;
    },
    atOnce: 3,
    idleMs: 1000,
    going: () => claims < 3,
    sleep: async ms => void slept.push(ms),
    failed: err => void failed.push((err as Error).message),
  });
  await turn();
  assert.deepEqual(failed, ['HQ away', 'the CLI died']);
  assert.deepEqual(slept, [1000, 1000], 'it waited after the failed claim and after the empty one, not after the call');
});
