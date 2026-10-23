// node --test shared/payments/tax.test.ts   (pure functions, no setup)
import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleFor, salesCountries, taxIncluded } from './tax.ts';

const dutch = { vatPercent: 21, basis: 'Dutch VAT 21%, no small-business scheme' };

test('a known rule splits the VAT out of the price: 21% of €4.99 is €0.87', () => {
  assert.deepEqual(taxIncluded(499, 'NL', { NL: dutch }), {
    status: 'known',
    country: 'NL',
    vatPercent: 21,
    vatCents: 87,
    totalCents: 499,
    basis: dutch.basis,
  });
  const lower = taxIncluded(399, 'NL', { NL: dutch });
  assert.equal(lower.status === 'known' && lower.vatCents, 69);
  const zeroRated = taxIncluded(499, 'NL', { NL: { vatPercent: 0, basis: 'Exempt' } });
  assert.equal(zeroRated.status === 'known' && zeroRated.vatCents, 0);
});

test('a country without a usable rule stays unknown, never the home rate', () => {
  const territory = {
    NL: dutch,
    DE: null,
    BE: { vatPercent: 21 },
    FR: { vatPercent: 'twenty', basis: 'x' },
    AT: { vatPercent: 120, basis: 'x' },
    IT: { vatPercent: 22, basis: '  ' },
  };
  for (const country of ['DE', 'BE', 'FR', 'AT', 'IT', 'GB']) {
    assert.deepEqual(taxIncluded(499, country, territory), { status: 'unknown', country }, country);
    assert.equal(ruleFor(territory, country), null, country);
  }
  for (const country of [null, undefined, 'nl', 'NLD', 'toString', '__proto__']) {
    assert.deepEqual(taxIncluded(499, country, territory), { status: 'unknown', country: null }, String(country));
  }
  assert.deepEqual(taxIncluded(4.99, 'NL', territory), { status: 'unknown', country: 'NL' });
  assert.deepEqual(taxIncluded(499, 'NL', null), { status: 'unknown', country: 'NL' });
});

test("a sale's countries are the ones whose rule it can rely on", () => {
  assert.deepEqual(salesCountries({ NL: dutch, DE: null, BE: { vatPercent: 21 }, AT: { ...dutch, vatPercent: 20 } }), [
    'AT',
    'NL',
  ]);
  assert.deepEqual(salesCountries(undefined), []);
  assert.deepEqual(salesCountries({}), []);
});
