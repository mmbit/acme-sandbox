// node --test src/places.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatPlaces } from './places.ts';
import { pacedRest, pacedRuns, pacedRunsRise } from './pace.ts';

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
  assert.equal(places.roomOn(tight, { pastStop: true }), true, 'the board retains its reserved access');
  pending.resolve();
  await claim;
  assert.equal(places.roomOn(tight), true);
  tight.week = 0.7;
  places.take(tight);
  assert.equal(places.roomOn(tight), false, 'the approach boundary is inclusive');
  places.release(tight);
  tight.week = 0.8;
  assert.equal(places.roomOn(tight), false, 'a ready row at its configured stop cannot start work');
  assert.equal(places.roomOn(tight, { pastStop: true }), true);
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

test('pacing admits the weekly affordable concurrency, including claims in flight, without losing the last place', async () => {
  const now = Date.now(),
    hour = 3600_000;
  const paced = { ...seat(), week: 0.5, drainAt: 1, weekResets: now + 120 * hour };
  const places = seatPlaces({ claude: 10 }, s => pacedRuns(s as typeof paced, 1, 0.001)?.runs);
  const cap = pacedRuns(paced, 1, 0.001)!.runs;
  assert.equal(cap, 4);
  for (let i = 0; i < cap; i++) {
    assert.equal(places.roomOn(paced), true);
    places.take(paced);
  }
  assert.equal(places.roomOn(paced), false);
  assert.equal(places.roomOn(paced, { held: true }), true, 'a held meeting can claim its own reserved place');
  places.take(paced);
  assert.equal(places.roomOn(paced, { held: true }), true, 'existing reservations survive a reduced pacing cap');
  places.release(paced);
  assert.equal(places.roomOn(paced, { pastPace: true }), true, 'urgent claims bypass the pace cap');
  places.release(paced);
  assert.equal(places.roomOn(paced), true);
  assert.equal(pacedRuns(paced, 1, null)!.runs, 1, 'an unmeasured cost retains one place');
  const expensive = seatPlaces({}, s => pacedRuns(s as typeof paced, 1, 0.1)?.runs);
  assert.equal(expensive.roomOn(paced), true);
  expensive.take(paced);
  assert.equal(expensive.roomOn(paced), false, 'a sub-run allowance retains one working place');
  paced.week = 0.95;
  assert.equal(places.roomOn(paced, { pastPace: true }), false, 'urgent work still respects the near-stop band');
  paced.week = 1;
  assert.equal(expensive.roomOn(paced), false, 'the configured stop still holds');
});

test('a seat whose one run costs more than its allowance rests after each run and lands on its week at its reset', () => {
  const hour = 3600_000,
    from = Date.parse('2026-11-04T11:00:00Z');
  // (4 November's readings and measured prices of the two seats furthest over their allowance)
  for (const [week, price, resets] of [
    [0.6, 0.007110083953136636, '2026-11-09T06:00:00Z'],
    [0.58, 0.0073126198136988325, '2026-11-09T22:00:00Z'],
  ] as const) {
    const paced = { ...seat(), util: 0, week, drainAt: 1, weekResets: Date.parse(resets) };
    let now = from,
      restUntil: number | undefined,
      worked = 0;
    const places = seatPlaces({}, s => pacedRuns(s as typeof paced, 1, price, now, restUntil)?.runs);
    // A backlog of one-hour runs, each claimed as soon as the seat has an ordinary place.
    while (now < paced.weekResets) {
      if (!places.roomOn(paced)) {
        assert.ok(paced.week < 1 || now > paced.weekResets - 3 * hour, 'the seat reaches its stop only at its reset');
        if (restUntil !== undefined && restUntil > now)
          assert.equal(places.roomOn(paced, { pastPace: true }), true, 'urgent work bypasses the rest');
        now = Math.max(now + 60_000, restUntil ?? 0);
        continue;
      }
      const ran = Math.min(hour, paced.weekResets - now);
      paced.week += (price * ran) / hour;
      now += ran;
      worked += ran;
      restUntil = pacedRest(paced, 1, price, ran, restUntil, now);
    }
    assert.ok(paced.week > 0.97 && paced.week < 1.01, `lands on its week: ${paced.week}`);
    assert.ok(worked > 50 * hour, 'the seat keeps working through the week');
  }
});

test("a default seat's last day paces it toward the relaxed reserve, so one run doesn't rest it to its reset", () => {
  const hour = 3600_000,
    now = Date.now();
  const lastDay = { week: 0.882, weekResets: now + 21 * hour };
  assert.ok(pacedRuns(lastDay, 0.9, 0.007, now)!.perHour > 0, 'the relaxing reserve leaves an allowance');
  const rest = pacedRest(lastDay, 0.9, 0.007, hour, undefined, now)!;
  assert.ok(Math.abs(rest - (now + 13 * hour)) < 60_000, `it rests ${(rest - now) / hour} h, not to its reset`);
});

test('a paced seat takes another run at a time once its growing allowance affords it, with its running work spending', () => {
  const hour = 3600_000,
    now = Date.now();
  const paced = { week: 0.7, drainAt: 1, weekResets: now + 120 * hour };
  assert.equal(pacedRuns(paced, 1, 0.002, now)!.runs, 1);
  const idle = pacedRunsRise(paced, 1, 0.002, 0, now)!;
  assert.ok(Math.abs(idle - (now + 50 * hour)) < 2000, `idle, it takes two at ${(idle - now) / hour} h`);
  assert.equal(pacedRuns(paced, 1, 0.002, idle)!.runs, 2);
  const busy = pacedRunsRise(paced, 1, 0.002, 0.002, now)!;
  assert.ok(Math.abs(busy - (now + 100 * hour)) < 2000, `with one run spending, at ${(busy - now) / hour} h`);
  assert.equal(pacedRuns({ ...paced, week: 0.9 }, 1, 0.002, busy)!.runs, 2);
  assert.equal(pacedRunsRise(paced, 1, null, 0, now), undefined, 'an unknown cost keeps its one place');
});
