// node --test src/board.test.ts   (the board's quiet hours from its profile, on its own clock across weekends and a clock
// change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quiet, upAfter, type Profile } from './board.ts';

// Ours (company/board.yaml): weekdays up 08:00 and quiet from 23:00, weekends up 10:00 and quiet from 01:00, 20 minutes
// for something it asked for
const ours: Profile = {
  zone: 'Europe/Amsterdam',
  weekdays: { up: 8 * 60, work: 9 * 60 + 30, quiet: 23 * 60 },
  weekends: { up: 10 * 60, work: null, quiet: 60 },
  askedMinutes: 20,
  ...{ who: '', work: '', time: '', preferences: [] },
};
// A time on Amsterdam's clock in November (CET, UTC+1)
const cet = (day: string, time: string) => Date.parse(`${day}T${time}:00+01:00`);
const until = (at: number, askedFor = false) => quiet(at, askedFor, ours)?.until ?? null;

test('a weekday night is quiet from 23:00 until 08:00, and something the board asked for still reaches it until 23:20', () => {
  assert.equal(until(cet('2026-11-10', '22:59')), null, 'Tuesday evening');
  assert.equal(until(cet('2026-11-10', '23:00')), cet('2026-11-11', '08:00'));
  assert.equal(until(cet('2026-11-10', '23:10'), true), null, 'asked for, just after quiet starts');
  assert.equal(until(cet('2026-11-10', '23:25'), true), cet('2026-11-11', '08:00'));
  assert.equal(until(cet('2026-11-11', '03:00')), cet('2026-11-11', '08:00'));
  assert.equal(until(cet('2026-11-11', '07:59')), cet('2026-11-11', '08:00'));
  assert.equal(until(cet('2026-11-11', '08:00')), null, 'up');
});

test("the weekend's nights (Friday's and Saturday's) are quiet from 01:00 until 10:00; Sunday's is a weekday's", () => {
  assert.equal(until(cet('2026-11-13', '23:30')), null, 'Friday night');
  assert.equal(until(cet('2026-11-14', '00:30')), null);
  assert.equal(until(cet('2026-11-14', '01:00')), cet('2026-11-14', '10:00'), 'Saturday morning');
  assert.equal(until(cet('2026-11-14', '09:00')), cet('2026-11-14', '10:00'));
  assert.equal(until(cet('2026-11-14', '23:30')), null, 'Saturday night');
  assert.equal(until(cet('2026-11-15', '02:00')), cet('2026-11-15', '10:00'), 'Sunday morning');
  assert.equal(until(cet('2026-11-15', '23:30')), cet('2026-11-16', '08:00'), 'Sunday night: Monday is a workday');
});

test("the quiet hours keep the board's clock across a clock change, and without a profile nothing is quiet", () => {
  // Sunday 28 March 2027: summer time starts at 02:00, so up at 10:00 is 08:00 UTC
  assert.equal(quiet(Date.parse('2027-03-28T07:30:00Z'), false, ours)?.until, Date.parse('2027-03-28T08:00:00Z'));
  assert.equal(quiet(Date.parse('2027-03-28T08:00:00Z'), false, ours), null);
  assert.equal(quiet(cet('2026-11-11', '03:00'), false, null), null);
  // a part of the week without quiet holds nothing
  assert.equal(
    quiet(cet('2026-11-11', '03:00'), false, { ...ours, weekdays: { ...ours.weekdays, quiet: null } }),
    null,
  );
});

test("a time to tell the board that lands in its quiet hours is told as the time it's up; one outside them as it is", () => {
  assert.equal(upAfter(cet('2026-11-11', '03:10'), ours), cet('2026-11-11', '08:00'));
  assert.equal(upAfter(cet('2026-11-11', '14:00'), ours), null);
  assert.equal(upAfter(null, ours), null);
});
