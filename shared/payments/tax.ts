// The VAT a consumer price includes, from the seller's own rule for the buyer's country. A country without a rule has
// an unknown tax, and nothing is sold there: a guess, such as the home country's rate, never stands in for a rule.

// A seller's rule for one country: the VAT rate its prices include there, and where that treatment is recorded.
export type TaxRule = { vatPercent: number; basis: string };
// One country's rule per two-letter code: a sale's territory.
export type Territory = Record<string, TaxRule>;
export type TaxResult =
  | { status: 'known'; country: string; vatPercent: number; vatCents: number; totalCents: number; basis: string }
  | { status: 'unknown'; country: string | null };

const COUNTRY = /^[A-Z]{2}$/;

// The rule a sale to country can rely on, or null.
export function ruleFor(territory: unknown, country: unknown): TaxRule | null {
  if (typeof country !== 'string' || !COUNTRY.test(country)) return null;
  if (!territory || typeof territory !== 'object' || !Object.hasOwn(territory, country)) return null;
  const rule = (territory as Record<string, Partial<TaxRule> | null>)[country];
  const vatPercent = rule?.vatPercent;
  const basis = typeof rule?.basis === 'string' ? rule.basis.trim() : '';
  const known = typeof vatPercent === 'number' && Number.isFinite(vatPercent) && vatPercent >= 0 && vatPercent <= 100;
  return known && basis ? { vatPercent, basis } : null;
}

// The countries a sale may go to: those whose rule it can rely on, in order.
export function salesCountries(territory: unknown) {
  const countries = territory && typeof territory === 'object' ? Object.keys(territory) : [];
  return countries.filter(country => ruleFor(territory, country)).sort();
}

// The VAT within a total, in whole cents rounded half up, for a buyer in country.
export function taxIncluded(totalCents: number, country: unknown, territory: unknown): TaxResult {
  const rule = ruleFor(territory, country);
  if (!rule || !Number.isInteger(totalCents) || totalCents < 0) {
    return { status: 'unknown', country: typeof country === 'string' && COUNTRY.test(country) ? country : null };
  }
  const vatCents = Math.round((totalCents * rule.vatPercent) / (100 + rule.vatPercent));
  return {
    status: 'known',
    country: country as string,
    vatPercent: rule.vatPercent,
    vatCents,
    totalCents,
    basis: rule.basis,
  };
}
