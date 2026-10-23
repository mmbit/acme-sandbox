// What a live app's paid ads cost per day, as whoever runs the ads records it (hq spend). The watch reads it: an outage
// while money goes out reaches the board at once (watch.ts), and spend that rises while sales stay flat is a money swing
// (money.ts).
// Euros per day on the company's clock, the days the apps count their orders in (metrics.ts). Numbers only, nobody's data.
//   POST /api/agent/spend {app, day, euros}   the day's total for that app's ads, replacing what was recorded for it
import { existsSync } from 'node:fs';
import { REPO_DIR } from './config.ts';
import { companyDay } from './company.ts';
import { db } from './db.ts';
import * as metrics from './metrics.ts';

db.exec(`create table if not exists ad_spend (product text not null, day text not null, cents integer not null,
  recorded_by text not null, recorded text not null, primary key (product, day))`);

const MAX_EUROS = 100_000,
  BACK_DAYS = 60;

// The day's total, or why it can't be recorded
export function recordSpend(o: { app: unknown; day: unknown; euros: unknown }, by: string, now = Date.now()) {
  const app = String(o.app ?? ''),
    day = o.day,
    euros = amountOf(o.euros);
  if (!metrics.isSlug(app) || !existsSync(`${REPO_DIR}/products/${app}/product.yaml`))
    return `no product ${JSON.stringify(app.slice(0, 40))} in products/`;
  const today = companyDay(now);
  if (!metrics.isDay(day) || day > today || day < metrics.addDays(today, -BACK_DAYS))
    return `the day is a date on the company's clock (YYYY-MM-DD) from the last ${BACK_DAYS} days, today included`;
  if (!Number.isFinite(euros) || euros < 0 || euros > MAX_EUROS)
    return `euros is the day's total, from 0 to ${MAX_EUROS}`;
  const cents = Math.round(euros * 100);
  db.prepare(
    `insert into ad_spend (product, day, cents, recorded_by, recorded) values (?, ?, ?, ?, ?)
    on conflict (product, day) do update set cents = excluded.cents, recorded_by = excluded.recorded_by, recorded = excluded.recorded`,
  ).run(app, day, cents, by, new Date(now).toISOString());
  return { app, day, cents };
}

// A number, or a string of digits with a decimal point if any: anything else (blank, true, a list) is NaN, never 0 or 1
const amountOf = (value: unknown) =>
  typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) ? Number(value) : NaN;

// An app's spend per day, from..to (both included): only the days with a record
export function spendByDay(app: string, from: string, to: string) {
  const recorded = db
    .prepare('select day, cents from ad_spend where product = ? and day between ? and ? order by day')
    .all(app, from, to) as { day: string; cents: number }[];
  return new Map(recorded.map(r => [r.day, r.cents]));
}

// Who runs the app's ads: the agent who recorded its latest spend from..to, or null without a record
export const spendRecordedBy = (app: string, from: string, to: string) =>
  (
    db
      .prepare(
        'select recorded_by from ad_spend where product = ? and day between ? and ? order by recorded desc limit 1',
      )
      .get(app, from, to) as { recorded_by: string } | undefined
  )?.recorded_by ?? null;
