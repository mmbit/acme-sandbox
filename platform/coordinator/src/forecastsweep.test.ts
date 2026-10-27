// node --test src/forecastsweep.test.ts   (uses a throwaway DATA_DIR): the minute's sweep (forecast.ts sweep) stores new
// work's estimate as the plays have shown it since it was queued, and its first outlook from the minute's one play.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('forecastsweep');
const forecast = await import('./forecast.ts');
const predictions = await import('./predictions.ts');
const pastpool = await import('./pastpool.ts');

const MIN = 60_000,
  HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());

const past = (title: string, minutes: number) => {
  const ended = T0 - 48 * HOUR;
  return h.pastJob({ title, run: { started: ended - minutes * MIN, ended }, merged: ended + HOUR });
};

test("new work keeps the size the plays showed since it was queued, and the minute's play's outlook", async () => {
  for (const [title, minutes] of [
    ['Paint the harbour map', 30],
    ['Paint the harbour map in winter', 40],
    ['Paint the harbour map at night', 50],
  ] as const)
    past(title, minutes);
  await h.worker('seat', { seat: 'claude-a', engine: 'claude', state: 'ready', util: 0.1 });
  pastpool.keep(); // as the server keeps it (forecast.ts start).
  const id = h.queue({ agent: 'kit', title: 'Paint the harbour map for the harbourmaster', engine: 'claude' });
  // the play after its queueing sizes it on the spot; a done job like it ends after that
  forecast.refresh(T0);
  const longer = past('Paint the harbour map for the harbourmaster at night', 400);

  const played = forecast.sweep(T0 + MIN);
  const row = h.db.prepare('select agent_ms, picks, start, done, eta from predictions where job = ?').get(id) as {
    agent_ms: number;
    picks: string;
    start: number;
    done: number;
    eta: number;
  };
  assert.equal(row.agent_ms, 40 * MIN, 'the size it was shown with');
  assert.ok(!(JSON.parse(row.picks) as number[]).includes(longer));
  const outlook = played.usual.get(id)!;
  assert.deepEqual([row.start, row.done, row.eta], [outlook.start, outlook.done, outlook.merged]);
  assert.equal(forecast.lastPlayed(), played, 'the sweep keeps its play as the latest');
});
