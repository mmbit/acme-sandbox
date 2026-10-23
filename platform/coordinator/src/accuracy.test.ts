// node --test src/accuracy.test.ts   (uses a throwaway DATA_DIR): hq estimate --accuracy's matching tried within a
// thread beside HQ's way.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('accuracy');

const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());

// A done work job of `agent`'s in `thread`, queued at `created`, that ran `minutes` from `started`, sized at that.
type Done = { agent: string; title: string; thread: string | null; created: number; started: number; minutes: number };
function done({ started, minutes, ...j }: Done) {
  return h.pastJob({ ...j, run: { started, ended: started + minutes * MIN }, sized: minutes * MIN });
}

test('the matching is tried within a thread too, on the work with three or more of its thread done before it', async () => {
  const before = T0 - 3 * DAY;
  // three of the thread's jobs took an hour; three of the same agent's outside it, alike in their words, ten minutes
  for (const n of ['one', 'two', 'three']) {
    done({
      agent: 'kit',
      title: `Repair the bridge ${n}`,
      thread: 'engine/m2',
      created: before,
      started: before,
      minutes: 60,
    });
    done({
      agent: 'kit',
      title: `Repair the harbour ${n}`,
      thread: null,
      created: before,
      started: before,
      minutes: 10,
    });
  }
  const queued = T0 - 2 * DAY;
  done({
    agent: 'kit',
    title: 'Repair the harbour bridge',
    thread: 'engine/m2',
    created: queued,
    started: queued,
    minutes: 60,
  });
  const reader = await h.start({ agent: 'bolt', title: 'Reading accuracy' });
  const r = await h.agent('estimate/accuracy', reader.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.matching_by_thread;
  // HQ's way takes the mean of all six (35 minutes); within the thread, the hour its own took
  assert.deepEqual([m.jobs, m.usual.median_factor, m.thread_first.median_factor], [1, 1.71, 1]);
  const { out } = await h.hq(reader, 'estimate', '--accuracy');
  assert.match(out, /on the 1 job with 3 or more of its thread done before it:/);
  assert.match(out, /the same within its thread: the median miss ×1 either way/);
});
