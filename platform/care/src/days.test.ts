// node --test src/days.test.ts
// The company's days in its own time zone: on both sides of UTC, a day is its calendar date, never converted twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './company.ts';
import { day, iso, working, addWorkingDays, workingDaysBetween } from './days.ts';

const at = (s: string) => Date.parse(s);
for (const zone of ['America/New_York', 'Europe/Amsterdam', 'Pacific/Auckland', 'UTC']) {
  test(`working days in ${zone}: Friday noon plus one is Monday, Sunday to Monday is one`, () => {
    settings.timeZone = zone;
    assert.equal(iso(addWorkingDays(at('2026-10-02T12:00:00Z'), 1)), '2026-10-05');
    assert.equal(workingDaysBetween(at('2026-10-04T12:00:00Z'), at('2026-10-05T12:00:00Z')), 1);
    assert.equal(working(at('2026-10-03T12:00:00Z')), false, 'Saturday');
    assert.equal(working(day(at('2026-10-05T12:00:00Z'))), true, 'a day from here is the date it is');
    assert.equal(iso(at('2026-10-05')), '2026-10-05', 'a date-only date is that date');
  });
}

test('a moment is its date in the company’s zone, and holidays are skipped', () => {
  settings.timeZone = 'America/New_York';
  assert.equal(iso(at('2026-10-06T02:00:00Z')), '2026-10-05', '22:00 the evening before, in New York');
  settings.timeZone = 'Europe/Amsterdam';
  assert.equal(iso(at('2026-10-05T22:30:00Z')), '2026-10-06', '00:30 the next day, in Amsterdam');
  settings.holiday = d => d === '2026-10-05';
  assert.equal(iso(addWorkingDays(at('2026-10-02T12:00:00Z'), 1)), '2026-10-06');
  settings.holiday = () => false;
});
