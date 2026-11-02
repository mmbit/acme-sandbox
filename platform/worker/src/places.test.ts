// node --test src/places.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatPlaces } from './places.ts';

const seat = () => ({
  id: 'claude-1',
  engine: 'claude',
  util: 0.2,
  resets: 0,
  week: 0.71,
  weekResets: 0,
  drainAt: 0.8,
});

test('a seat approaching its own stop admits one claim including a claim still in flight', async () => {
  const places = seatPlaces({});
  const tight = seat();
  const pending = Promise.withResolvers<void>();
  assert.equal(places.roomOn(tight), true);
  const claim = places.hold(
    tight,
    false,
    () => false,
    () => pending.promise,
  );
  assert.equal(places.roomOn(tight), false);
  assert.equal(places.roomOn(tight, true), true, 'the board retains its reserved access');
  pending.resolve();
  await claim;
  assert.equal(places.roomOn(tight), true);
  tight.week = 0.7;
  places.take(tight);
  assert.equal(places.roomOn(tight), false, 'the approach boundary is inclusive');
  places.release(tight);
  tight.week = 0.8;
  assert.equal(places.roomOn(tight), false, 'a ready row at its configured stop cannot start work');
  assert.equal(places.roomOn(tight, true), true);
  const fullPlan = { ...tight, id: 'claude-2', drainAt: 1, week: 0.995 };
  assert.equal(places.roomOn(fullPlan), true, 'the last percent is available to work');
  places.take(fullPlan);
  assert.equal(places.roomOn(fullPlan), false, 'near the limit, one job at a time');
  places.release(fullPlan);
  fullPlan.week = 1;
  assert.equal(places.roomOn(fullPlan), false, 'a full week admits no new work');
});

test('the approach limit counts adopted runs and held meetings and lifts when usage resets', () => {
  const places = seatPlaces({ claude: 2 });
  const tight = seat();
  places.take(tight);
  assert.equal(places.roomOn(tight), false);
  tight.week = 0.4;
  assert.equal(places.roomOn(tight), true);
  places.take(tight);
  assert.equal(places.roomOn(tight), false, 'the configured cap still holds away from the stop');
  places.release(tight);
  tight.week = 0.78;
  tight.weekResets = Date.now() - 1;
  assert.equal(places.roomOn(tight), true, 'an expired weekly reading does not restrict the new week');
  tight.util = 0.75;
  assert.equal(places.roomOn(tight), false, 'the active five-hour window restricts it independently');
  assert.equal(places.roomOn({ ...tight, credits: true }), true, 'authorized credits bypass quota pacing');
});
