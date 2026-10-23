// node --test shared/ordernumber/ordernumber.test.ts   (pure functions, no setup)
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOk, newNumber, numberOf, numberOk, spaced, withCheck } from './ordernumber.js';

test('the Damm check digit as published (572 → 4), and a number passes only with it', () => {
  assert.equal(withCheck('572'), '5724');
  assert.ok(checkOk('5724'));
  assert.ok(!checkOk('5723') && !checkOk('4') && !checkOk('57 24') && !checkOk(5724));
});

test('a new order number is 7 digits with its check; every digit misheard or two swapped makes no other', () => {
  for (let i = 0; i < 200; i++) {
    const n = newNumber();
    assert.ok(/^\d{7}$/.test(n) && numberOk(n), n);
    for (let at = 0; at < 7; at++) {
      for (let d = 0; d < 10; d++)
        if (String(d) !== n[at]) assert.ok(!numberOk(n.slice(0, at) + d + n.slice(at + 1)), `${n}: ${at} → ${d}`);
      if (at < 6 && n[at] !== n[at + 1])
        assert.ok(!numberOk(n.slice(0, at) + n[at + 1] + n[at] + n.slice(at + 2)), `${n}: swap at ${at}`);
    }
  }
  assert.ok(checkOk(newNumber(8)) && newNumber(8).length === 8, 'another length, with the same check');
  assert.ok(!numberOk(withCheck('1234567')), 'an 8-digit number is not an order number');
});

test('a number as said or typed, and as it is read out', () => {
  const n = withCheck('482917');
  assert.equal(numberOf(` ${n.slice(0, 3)} ${n.slice(3)} `), n);
  assert.equal(numberOf(`${n.slice(0, 3)}-${n.slice(3)}.`), n);
  assert.equal(numberOf(withCheck('48291')), null);
  assert.equal(numberOf(null), null);
  assert.equal(spaced(n), `${n.slice(0, 3)} ${n.slice(3)}`);
  assert.equal(spaced('12345678', ' '), '1234 5678');
});
