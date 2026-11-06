// node --test src/forecastfirst.test.ts   (throwaway DATA_DIR and the test company): a request in the seconds between
// the server's start and its first play (forecast.ts start, firstPlay) waits for that play, and plays nothing itself.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('forecastfirst');
const forecast = await import('./forecast.ts');

test('a request before the first play is answered after it, with no play of its own', async () => {
  const job = await h.start({ agent: 'bolt' });
  let plays = 0;
  forecast.afterEach(() => plays++);
  // The reads ahead of the first play (matching.ts readPastAhead, headroom.ts priceAhead) go a slice a turn, each turn
  // a setImmediate: held here, they stay unread until the test lets them go on.
  mock.timers.enable({ apis: ['setImmediate'] });
  try {
    forecast.start();
    let answeredAfter: number | undefined;
    const asked = h.agent('projects', job.token).then(r => ((answeredAfter = plays), r));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(answeredAfter, undefined, 'not answered before the reads ahead are in');
    assert.equal(plays, 0, 'nothing played for the request');
    while (answeredAfter === undefined) {
      mock.timers.tick(1);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await asked).status, 200);
    assert.equal(answeredAfter, 1, 'answered after the first play');
    assert.equal(plays, 1, 'the first play alone');
  } finally {
    mock.timers.reset();
  }
});
