// node --test shared/format/format.test.ts   (the calendar formats on a company's clock)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copiesOf, formats } from './format.js';

const { dayAt, hourAt } = formats({ locales: { en: 'en-GB' }, currency: 'EUR', timeZone: 'Europe/Amsterdam' });

test("the hour at a moment is the company clock's, with its minutes as a fraction", () => {
  assert.equal(hourAt(Date.parse('2026-07-01T10:15:00Z')), 12.25); // summer time, two hours ahead
  assert.equal(hourAt(Date.parse('2026-12-31T17:00:00Z')), 18); // winter time, one hour ahead
  assert.equal(hourAt(Date.parse('2026-12-31T23:30:00Z')), 0.5); // past midnight there: the next day's first hour
  assert.equal(dayAt(Date.parse('2026-12-31T23:30:00Z')), '2027-01-01');
});

test("a moment's day and time read on the company's clock, in the reader's language", () => {
  const { moment } = formats({ locales: { en: 'en-GB', nl: 'nl-NL' }, currency: 'EUR', timeZone: 'Europe/Amsterdam' });
  const evening = Date.parse('2026-12-31T22:30:00Z'); // 23:30 there
  assert.equal(moment(evening, 'en'), '31 December at 23:30');
  assert.equal(moment(evening, 'nl'), '31 december om 23:30');
  assert.equal(moment(evening, 'en', { short: true }), '31 Dec, 23:30');
});

test('the hour follows the clocks going back', () => {
  assert.equal(hourAt(Date.parse('2026-10-25T00:30:00Z')), 2.5); // still summer time
  assert.equal(hourAt(Date.parse('2026-10-25T01:30:00Z')), 2.5); // the same hour again, in winter time
});

test("a line's copies before its name: only from two, and nothing for a view without them", () => {
  assert.deepEqual([{ quantity: 2 }, { quantity: 1 }, {}].map(copiesOf), ['2 × ', '', '']);
});
