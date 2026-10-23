// The holidays a company can dress up for (HQ's building, a shop's front), the one table every app reads: each from its
// first day (or hour) up to, but not including, its end. 'MM-DD' or 'MM-DD HH', compared as text against the local date
// and hour (not toISOString's UTC slice, which would shift the window near local midnight). A window that ends before it
// starts runs over New Year. Which of them a company keeps is its own: calendar.holidays in company/brand.yaml.
// Browsers and Node import it by its path in the repo (HQ serves it at /shared/holidays/holidays.js).
export const HOLIDAYS = {
  halloween: ['10-24', '11-02'],
  sinterklaas: ['12-01', '12-06'],
  pakjesavond: ['12-05 17', '12-06'], // Sinterklaas's last evening: a carrot in the shoe for his horse
  christmas: ['12-01', '12-27'],
  newYear: ['12-31 18', '01-01 07'], // New Year's Eve, from the evening until the morning after
};

// The names of the holidays in kept (every one by default) that are on at local date 'MM-DD' and hour h (0 to 24), in
// the table's order
export function holidaysOn(date, h, kept = Object.keys(HOLIDAYS)) {
  const now = `${date} ${String(Math.floor(h)).padStart(2, '0')}`;
  const on = ([from, until]) => (from < until ? now >= from && now < until : now >= from || now < until);
  return Object.keys(HOLIDAYS).filter(name => kept.includes(name) && on(HOLIDAYS[name]));
}
