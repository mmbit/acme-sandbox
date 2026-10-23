// HQ's money check, for the watch on the live apps (watch.ts): each day's sales and ad spend against the days before,
// and the orders refunded since the last check. A swing is a job for Finance (infra/products.md, "HQ's watch").
import { db } from './db.ts';
import { createJob } from './jobs.ts';
import { STANDING } from './jobcodes.ts';
import { euros } from './payments.ts';
import { spendByDay } from './spend.ts';
import * as company from './company.ts';
import * as metrics from './metrics.ts';
import type { LiveApp } from './watch.ts';

const BASE_DAYS = 7;

// watch_days: what the money check last saw of a day. inputs: the numbers it compared, the day's and the BASE_DAYS days
// before it. noted: the kinds of swing it found then (Finding's kind, a JSON list).
db.exec(`create table if not exists watch_days (product text not null, day text not null, inputs text not null,
  noted text not null, primary key (product, day))`);
// watch_refunds: the orders an app had refunded in all its days, at each day's check
db.exec(`create table if not exists watch_refunds (product text not null, day text not null, refunded integer not null,
  primary key (product, day))`);

// When a day counts as a swing, against the BASE_DAYS before it. company/org.yaml's `watch:` may tune any of them.
const LIMITS = {
  steadySaleDays: 5, // sales on at least this many of the days before make them steady: only then do sales swing
  salesChance: 0.01, // so few sales (or none), after steady ones, had at most this chance (Poisson, at the average before)
  orderValueShare: 0.5, // what a kept order brought in, at most this share of what it brought in before
  refundsAtLeast: 3, // orders refunded since the last check, and at least refundsTimes the daily rate before
  refundsTimes: 3,
  unpaidOrdersAtLeast: 5, // orders on the day, of which the share not paid rose by at least unpaidShareRise
  unpaidShareRise: 0.25,
  spendTimes: 1.5, // ad spend at least this many times the daily average before, with sales no higher than before
  spendDays: 5, // ad spend recorded on at least this many of the reported days before: only then does spend swing
  firstSpendEuros: 15, // this much ad spend on a day after none, with sales no higher than on the reported days before
};
type Limits = typeof LIMITS;

// A day's numbers. reported: the app's order summary covered the day after it ended. Without it, its orders are
// unknown and the counts are 0. spendCents: null when no ad spend was recorded for the day, which is unknown, not 0.
type MoneyDay = {
  day: string;
  reported: boolean;
  orders: number;
  paid: number;
  unpaid: number;
  refunded: number;
  kept: number;
  keptCents: number;
  spendCents: number | null;
};
// One reason a day is a swing: its kind, and why in a sentence
type Finding = { kind: 'sales' | 'order value' | 'unpaid' | 'ad spend'; why: string };
// A day's swing: why, in a sentence each, and the day with the BASE_DAYS before it
type DaySwing = { app: LiveApp; day: string; why: string[]; days: MoneyDay[] };
// What the check last saw of a day
type Looked = { inputs: string; noted: string };
// The orders an app reported refunded in all its days at this check, against the earlier checks
type Refunds = {
  slug: string;
  total: number;
  since: { day: string; refunded: number; days: number } | null;
  perDay: number;
};

// Each of the last BASE_DAYS days is checked once the app reported its orders in full, and again whenever a number it
// compares changes: the day's own or one of the days before it (ad spend recorded late or corrected, orders reported
// late, refunds). A comparison that lacked the numbers to judge is made again once they come. Finance hears each kind
// of swing on a day once, and again only if a check in between found it gone. A day the app hasn't reported waits: it
// never counts as a day without sales.
export function checkDays(apps: LiveApp[], now: number) {
  const yesterday = metrics.addDays(company.companyDay(now), -1);
  const first = metrics.addDays(yesterday, 1 - BASE_DAYS);
  const limits = currentLimits();
  const found: DaySwing[] = [];
  const checked: { slug: string; day: string; inputs: string; noted: Finding['kind'][] }[] = [];
  for (const app of apps) {
    const window = moneyDays(app.slug, metrics.addDays(first, -BASE_DAYS), yesterday);
    for (let i = BASE_DAYS; i < window.length; i++) {
      const moneyDay = window[i];
      if (!moneyDay.reported) continue;
      const days = window.slice(i - BASE_DAYS, i + 1);
      const { day } = moneyDay;
      const inputs = JSON.stringify(days);
      const looked = db
        .prepare('select inputs, noted from watch_days where product = ? and day = ?')
        .get(app.slug, day) as Looked | undefined;
      if (looked?.inputs === inputs) continue;
      const preceding = days.slice(0, -1);
      const before = preceding.filter(d => d.reported);
      const findings = [...salesSwings(moneyDay, before, limits), ...spendSwings(moneyDay, preceding, limits)];
      const notedBefore: Finding['kind'][] = JSON.parse(looked?.noted ?? '[]');
      const fresh = findings.filter(f => !notedBefore.includes(f.kind));
      if (fresh.length) found.push({ app, day, why: fresh.map(f => f.why), days });
      checked.push({ slug: app.slug, day, inputs, noted: findings.map(f => f.kind) });
    }
  }
  if (found.length) financeSwings(found);
  for (const { slug, day, inputs, noted } of checked)
    db.prepare(
      `insert into watch_days (product, day, inputs, noted) values (?, ?, ?, ?) on conflict (product, day)
      do update set inputs = excluded.inputs, noted = excluded.noted`,
    ).run(slug, day, inputs, JSON.stringify(noted));
}

// Once a day: the orders refunded since the last check, whatever day they were made, against the rate before
export function checkRefunds(apps: LiveApp[], now: number) {
  const today = company.companyDay(now);
  const limits = currentLimits();
  const checked = apps.map(app => {
    const refunds = refundsAt(app.slug, today);
    return { app, refunds, why: refundSwings(refunds, limits) };
  });
  const found = checked.filter(c => c.why.length);
  if (found.length)
    createJob({
      agent: company.roles().finance,
      word: STANDING.refunds, // (its task code's word)
      title: `Refund wave on ${found.map(f => f.app.name).join(', ')} (${today})`,
      prompt:
        "HQ's daily money check found more orders refunded than before:\n\n" +
        found.map(f => `${f.app.name}:\n- ${f.why.join('\n- ')}`).join('\n\n') +
        '\n\nIt counts the orders newly refunded since the last check, whatever day they were made. ' +
        FINANCE_NOTE,
    });
  for (const { refunds } of checked)
    db.prepare('insert or replace into watch_refunds (product, day, refunded) values (?, ?, ?)').run(
      refunds.slug,
      today,
      refunds.total,
    );
  return true;
}

function moneyDays(slug: string, from: string, to: string): MoneyDay[] {
  const orders = new Map(metrics.ordersByDay(slug, 'live', from, to).map(o => [o.day, o]));
  const reported = metrics.reportedDays(slug, 'live', from, to);
  const spend = spendByDay(slug, from, to);
  const days = Array.from({ length: metrics.daysFrom(from, to) + 1 }, (_, i) => metrics.addDays(from, i));
  return days.map(day => {
    const o = orders.get(day) ?? { orders: 0, paid: 0, refunded: 0, kept: 0, kept_cents: 0 };
    return {
      day,
      reported: reported.has(day),
      orders: o.orders,
      paid: o.paid,
      unpaid: o.orders - o.paid,
      refunded: o.refunded,
      kept: o.kept,
      keptCents: o.kept_cents,
      spendCents: spend.get(day) ?? null,
    };
  });
}

// What makes the day's sales a swing against the reported days before (none: an ordinary day)
function salesSwings(day: MoneyDay, before: MoneyDay[], limits: Limits): Finding[] {
  if (!before.length) return [];
  const findings: Finding[] = [];
  const saleDays = before.filter(d => d.paid > 0).length;
  const sales = averageOf(before, d => d.paid);
  if (saleDays >= limits.steadySaleDays) {
    const orderValue = sumOf(before, d => d.keptCents) / sumOf(before, d => d.kept);
    if (day.paid < sales && chanceAtMost(day.paid, sales) <= limits.salesChance)
      findings.push({
        kind: 'sales',
        why: `${day.paid ? salesOf(day.paid) : 'No sales'}, against ${sales.toFixed(1)} a day on the ${before.length} reported days before.`,
      });
    if (day.kept && day.keptCents / day.kept <= limits.orderValueShare * orderValue)
      findings.push({
        kind: 'order value',
        why: `${eur(day.keptCents)} kept from ${day.kept} orders (${eur(day.keptCents / day.kept)} each), against ${eur(orderValue)} an order before.`,
      });
  }
  const ordersBefore = sumOf(before, d => d.orders);
  const unpaidBefore = ordersBefore ? sumOf(before, d => d.unpaid) / ordersBefore : 0;
  if (day.orders >= limits.unpaidOrdersAtLeast && day.unpaid / day.orders >= unpaidBefore + limits.unpaidShareRise)
    findings.push({
      kind: 'unpaid',
      why: `${day.unpaid} of ${day.orders} orders not paid (${percent(day.unpaid / day.orders)}), against ${percent(unpaidBefore)} before: payments may be failing.`,
    });
  return findings;
}

// The chance of n or fewer sales on a day, when days average `mean` sales (Poisson), for n below the mean. Below the
// mean each term is smaller than the one above it, so the sum starts at n, relative to that term, and stops once a
// term no longer adds to it: under 10 times the square root of the mean. The term at n is taken in logarithms, since
// e^-mean alone is 0 in floating point from a mean of about 745.
function chanceAtMost(n: number, mean: number) {
  let sum = 0;
  let term = 1;
  for (let k = n; k >= 0 && term > sum * Number.EPSILON; k--) {
    sum += term;
    term *= k / mean;
  }
  return Math.exp(n * Math.log(mean) - mean - logFactorial(n)) * sum;
}

// ln(n!): summed below 20, and Stirling's series from there, off by less than 1e-9
function logFactorial(n: number) {
  if (n < 20) {
    let sum = 0;
    for (let k = 2; k <= n; k++) sum += Math.log(k);
    return sum;
  }
  return n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n) + 1 / (12 * n) - 1 / (360 * n ** 3);
}

// Ad spend up, with sales no higher than before, against the reported days before that have ad spend recorded. After
// days with no ad spend, firstSpend decides. Spend on a day the app didn't report still counts as spend before.
// preceding: the BASE_DAYS days before, reported or not. Ad spend is recorded apart from the orders.
function spendSwings(day: MoneyDay, preceding: MoneyDay[], limits: Limits): Finding[] {
  if (day.spendCents === null) return [];
  const before = preceding.filter(d => d.reported);
  if (!preceding.some(d => (d.spendCents ?? 0) > 0)) return firstSpend(day, before, limits);
  const recorded = before.filter(d => d.spendCents !== null);
  if (recorded.length < limits.spendDays) return [];
  const spend = averageOf(recorded, d => d.spendCents!);
  const sales = averageOf(recorded, d => d.paid);
  if (!(spend > 0 && day.spendCents >= limits.spendTimes * spend && day.paid <= sales)) return [];
  return [
    {
      kind: 'ad spend',
      why:
        `Ad spend ${eur(day.spendCents)}, against ${eur(spend)} a day on the ${recorded.length} days before with ` +
        `spend recorded, with ${salesOf(day.paid)} against ${sales.toFixed(1)} a day.`,
    },
  ];
}

// Ad spend on a day after none: no record of it on the days before, or records of none. Its sales against the reported
// days before, and when none of them is reported, its sales alone: there is nothing to compare them with.
function firstSpend(day: MoneyDay, before: MoneyDay[], limits: Limits): Finding[] {
  const sales = before.length ? averageOf(before, d => d.paid) : null;
  if (day.spendCents! < limits.firstSpendEuros * 100 || (sales !== null && day.paid > sales)) return [];
  const salesBefore =
    sales === null
      ? 'and no order summary from the app for the days before to compare them with'
      : `against ${sales.toFixed(1)} a day on the ${before.length} reported days before`;
  return [
    {
      kind: 'ad spend',
      why:
        `Ad spend ${eur(day.spendCents!)}, after no ad spend recorded on the ${BASE_DAYS} days before, with ` +
        `${salesOf(day.paid)} ${salesBefore}.`,
    },
  ];
}

function financeSwings(found: DaySwing[]) {
  createJob({
    agent: company.roles().finance,
    word: STANDING.moneySwing, // (its task code's word)
    title: `Money swing on ${found.map(f => `${f.app.name} (${f.day})`).join(', ')}`,
    prompt:
      `HQ's money check found a swing against the ${BASE_DAYS} days before (the company's days), on a day whose numbers came ` +
      'in or changed:\n\n' +
      found
        .map(f => `${f.app.name}, ${f.day}:\n${f.why.map(w => `- ${w}`).join('\n')}\n\n${table(f.days)}`)
        .join('\n\n') +
      '\n\n' +
      "Orders are counted on the day they were made. Refunded: that day's orders refunded by now. Unpaid: made, never " +
      'paid. Kept: what the paid orders not refunded brought in. Ad spend is what was recorded with hq spend: "not ' +
      'recorded" is unknown, not none. A day ' +
      '"not in" had no order summary from the app after it ended: its orders are unknown and left out. ' +
      FINANCE_NOTE,
  });
}

function table(days: MoneyDay[]) {
  const spendOf = (d: MoneyDay) => (d.spendCents === null ? 'not recorded' : eur(d.spendCents));
  return [
    '| Day | Orders | Paid | Unpaid | Refunded | Kept | Ad spend |',
    '|---|---|---|---|---|---|---|',
    ...days.map(d =>
      d.reported
        ? `| ${d.day} | ${d.orders} | ${d.paid} | ${d.unpaid} | ${d.refunded} | ${eur(d.keptCents)} | ${spendOf(d)} |`
        : `| ${d.day} | not in | | | | | ${spendOf(d)} |`,
    ),
  ].join('\n');
}

// The app's refunds now, with the last check in the BASE_DAYS before and the daily rate between the checks before it
function refundsAt(slug: string, today: string): Refunds {
  const earlier = db
    .prepare('select day, refunded from watch_refunds where product = ? and day < ? and day >= ? order by day')
    .all(slug, today, metrics.addDays(today, -BASE_DAYS)) as { day: string; refunded: number }[];
  const total = metrics.refundedTotal(slug, 'live');
  const first = earlier[0];
  const last = earlier.at(-1);
  const since = last
    ? { day: last.day, refunded: total - last.refunded, days: metrics.daysFrom(last.day, today) }
    : null;
  const perDay =
    first && last && first !== last ? (last.refunded - first.refunded) / metrics.daysFrom(first.day, last.day) : 0;
  return { slug, total, since, perDay };
}

function refundSwings(refunds: Refunds, limits: Limits) {
  if (!refunds.since) return [];
  const { day, refunded, days } = refunds.since;
  if (refunded < limits.refundsAtLeast || refunded < limits.refundsTimes * refunds.perDay * days) return [];
  return [
    `${refunded} orders refunded since the check on ${day}, whatever day they were made, against ${refunds.perDay.toFixed(1)} a day before.`,
  ];
}

// The thresholds, as company/org.yaml's `watch:` tunes them
const currentLimits = () => {
  const tuned = company.yamlFile('company/org.yaml')?.watch ?? {};
  return Object.fromEntries(
    Object.entries(LIMITS).map(([k, v]) => [k, Number.isFinite(tuned[k]) ? Number(tuned[k]) : v]),
  ) as Limits;
};

const FINANCE_NOTE =
  "Numbers only: no customer's details, and keep it that way in what you write.\n\n" +
  'Judge whether it is real or ordinary (a quiet day, a test order, a refund batch). If it needs action: a fault ' +
  "goes to the app's engineer, the ads to whoever runs them (hq job), and only what needs the board goes to it, " +
  'as one card.';

const averageOf = (days: MoneyDay[], pick: (d: MoneyDay) => number) => sumOf(days, pick) / days.length;
const sumOf = (days: MoneyDay[], pick: (d: MoneyDay) => number) => days.reduce((sum, d) => sum + pick(d), 0);
const percent = (share: number) => `${Math.round(share * 100)}%`;
const salesOf = (n: number) => (n === 1 ? '1 sale' : `${n} sales`);
const eur = (cents: number) => euros(cents, 'eur');
