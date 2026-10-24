// node --test platform/hq/world/clock.test.js   (the clock as the page's query sets it; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as clock from './clock.js';

const at = (query, calendar) => clock.init(new URLSearchParams(query), calendar);

test("New Year's Eve is on from the evening until the next morning, and the day check notices both ends", () => {
  clock.setHour(17.5);
  at('date=2026-12-31');
  assert.deepEqual([...clock.holidays()], []);
  clock.setHour(18);
  assert.deepEqual([...clock.checkDay()], ['newYear']);
  assert.equal(clock.checkDay(), null);
  at('date=2027-01-01');
  clock.setHour(6.5);
  assert.deepEqual([...clock.checkDay()], ['newYear']);
  clock.setHour(7);
  assert.deepEqual([...clock.checkDay()], []);
});

test("?date= previews a holiday, keeping the company's time of day", () => {
  at('date=2026-10-30');
  assert.equal(clock.today().toDateString(), 'Fri Oct 30 2026');
  assert.equal(clock.today().getHours(), clock.companyFormats().hourAt(Date.now()) | 0);
  assert.equal(clock.season(), 'autumn');
  assert.deepEqual([...clock.holidays()], ['halloween']);
});

test("the bunting goes up on the brand's founding day, and only then", () => {
  const calendar = { founded: '03-14', holidays: [] };
  clock.setHour(12);
  at('date=2026-03-14', calendar);
  assert.deepEqual([...clock.holidays()], ['birthday']);
  at('date=2026-03-15', calendar);
  assert.deepEqual([...clock.holidays()], []);
  at('date=2026-09-25');
  assert.deepEqual([...clock.holidays()], []);
});

test("HQ's times and days read the company's clock, wherever this device is", () => {
  clock.setTimeZone('Europe/Amsterdam');
  try {
    const evening = Date.parse('2026-12-31T22:30:00Z'); // 23:30 in Amsterdam
    assert.equal(clock.timeOf(evening), '23:30');
    assert.equal(clock.timeOf(new Date(evening).toISOString()), '23:30', 'a date string too');
    assert.equal(clock.dayTime(evening), 'Thu 31 Dec, 23:30');
    assert.equal(clock.clockWhen(Date.parse('2026-01-01T08:00:00Z')), 'Thu 09:00', 'another day: its weekday');
    assert.equal(clock.clockWhen(Date.now()), clock.timeOf(Date.now()), 'today: the time alone');
    // the design system's words (shared/signs), on the company's clock
    const past = Date.now() - 60_000;
    assert.equal(clock.fromNow(past), clock.clockWhen(past), 'a time past: its clock time');
    assert.equal(clock.fromNow(Date.now() + 25 * 60_000), '25 min', 'within the day: a glance');
    assert.equal(clock.fromNow(Date.parse('2026-12-31T23:30:00Z')), 'Fri 1 Jan', 'far off: its date there, not UTC’s');
    assert.equal(clock.companyFormats('EUR').money(2695, 'en'), '€26.95');
  } finally {
    clock.setTimeZone('UTC');
  }
});
