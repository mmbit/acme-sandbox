// node --test src/forecast.test.ts   (throwaway DATA_DIR and the test company): what plays the queue again. A change HQ
// makes does, a moment later; a running job's own feed (its steps, its status) changes nothing the play reads, so it
// doesn't; and a request reads the latest play, never playing it itself.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('forecast');
const forecast = await import('./forecast.ts');
forecast.start();
const SETTLE_MS = 10_000;

test("a running job's steps and status keep the latest forecast; a job queued plays the queue again a moment later", async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const job = await h.start({ agent: 'bolt' });
    mock.timers.tick(SETTLE_MS);
    const latest = forecast.current();
    for (const body of [
      { type: 'log', text: 'Bash: npm run gates' },
      { type: 'status', state: 'working', text: 'Running the gates' },
    ])
      assert.equal((await h.agent('event', job.token, body)).status, 200);
    mock.timers.tick(SETTLE_MS);
    assert.equal(forecast.current(), latest, 'the same play');
    h.queue({ agent: 'wren' });
    assert.equal(forecast.current(), latest, 'a request reads the latest play');
    mock.timers.tick(SETTLE_MS);
    const again = forecast.current();
    assert.notEqual(again, latest, 'played again');
    assert.ok(
      again.snapshot.jobs.some(j => j.agent === 'wren'),
      'with the job queued',
    );
  } finally {
    mock.timers.reset();
  }
});
