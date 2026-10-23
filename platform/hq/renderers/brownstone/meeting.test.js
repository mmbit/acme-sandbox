// node --test platform/hq/renderers/brownstone/meeting.test.js   (the board's words and tags, no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagRow, turnPips, wrap } from './meeting.js';

test('a word longer than its line is cut with a mark, and the topic stops there', () => {
  assert.deepEqual(wrap('Rocketlings launch', [9, 9, 9]), ['ROCKETL..']);
  assert.deepEqual(wrap('Launching Rocketlings', [9, 9]), ['LAUNCHING', 'ROCKETL..']);
  assert.deepEqual(wrap('Pricing the expansion', [9, 9]), ['PRICING', 'THE EXP..']);
  assert.deepEqual(wrap('Pricing the expansion', [14, 14]), ['PRICING THE', 'EXPANSION']);
});

test('the tag row keeps the latest projects named and folds the earlier ones into the first chip', () => {
  // the coordinator's order: the oldest change first, so the plan that just changed comes last
  const tags = ['Ads', 'HQ', 'Rocketlings'].map(name => ({ name })),
    lit = [false, false, true];
  assert.deepEqual(tagRow(tags, lit, 37), [
    { s: '+2', lit: false },
    { s: 'ROCKET', lit: true },
  ]);
  assert.deepEqual(tagRow(tags, [true, false, false], 37), [
    { s: '+2', lit: true },
    { s: 'ROCKET', lit: false },
  ]);
  assert.deepEqual(
    tagRow(tags, lit, 53).map(chip => chip.s),
    ['ADS', 'HQ', 'ROCKET'],
  );
});

test("the latest project stays named on the narrowest board, the inner wings' 37 px", () => {
  assert.deepEqual(tagRow([{ name: 'Rocketlings' }], [true], 37), [{ s: 'ROCKET', lit: true }]);
  assert.deepEqual(
    tagRow(
      ['HQ', 'Carrel'].map(name => ({ name })),
      [false, true],
      37,
    ).map(chip => chip.s),
    ['HQ', 'CARREL'],
  );
  assert.deepEqual(
    tagRow(
      ['Ads', 'Knop Works', 'Carrel'].map(name => ({ name })),
      [false, false, true],
      37,
    ).map(chip => chip.s),
    ['+2', 'CARREL'],
  );
  // even a row too narrow for it keeps the latest named, never a lone count
  assert.deepEqual(
    tagRow(
      ['HQ', 'Carrel'].map(name => ({ name })),
      [false, true],
      24,
    ).map(chip => chip.s),
    ['+1', 'CARREL'],
  );
});

test("the turn's pips stand apart, in colours none of the board's chips, words or markers use", () => {
  const pips = turnPips(1, 2);
  assert.deepEqual(
    pips.map(pip => pip.x),
    [0, 4],
  );
  assert.notEqual(pips[0].c, pips[1].c);
  for (const pip of pips) assert.ok(!['#ffd966', '#bfe3ff', '#e8505b', '#3b3355', '#5b8def'].includes(pip.c));
});
