// What every model call cost (a ledger row each), the caps that stop the next call, and the breaker for an outage.
import { CAP, CREDIT, EUR_PER_USD, HQ_APP } from './config.ts';
import { settings } from './company.ts';
import { db, hash, linkKey, now } from './db.ts';
import type { Usage } from './model.ts';
import * as numbers from './numbers.ts';

// ---- prices: USD per million tokens, from the Model releases note's table (input, output, 5-minute cache write, cache read).
// A model priced by prompt length has a `long` tier: a call whose prompt (input, cache write and cache read together)
// is over `over` tokens is billed entirely at the `long` prices.
type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };
export const PRICES: Record<string, Price & { long?: Price & { over: number } }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01,
    long: { over: 100_000, input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
// A model missing from the table is priced as the dearest one in it, so the caps err on the safe side
const DEAREST = PRICES['claude-opus-5-5'];
const warned = new Set<string>();
function price(model: string) {
  const id = model.replace(/-\d{8}$/, ''); // a dated id ('claude-haiku-4-5-20251001') costs what its alias costs
  if (PRICES[id]) return PRICES[id];
  if (!warned.has(id)) { warned.add(id); console.error(`ledger: no price for ${id}: priced as Opus 5.5 until PRICES has it`); }
  return DEAREST;
}

// in dollars, as the provider bills; the caps count euros at the day's rate
const usdCost = (model: string, u: Usage) => {
  const base = price(model);
  const p = base.long && u.input + u.cacheWrite + u.cacheRead > base.long.over ? base.long : base;
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
};
export const cost = (model: string, u: Usage) => usdCost(model, u) * EUR_PER_USD;

// The ledger stays when conversations are deleted, so an IP is kept only as a keyed hash: a plain hash of an IPv4
// address is undone by trying all four billion
const ipKey = (ip: string) => hash(`ledger-ip:${linkKey}:${ip}`);

// A draft thrown away mid-stream never sees its final usage: count the characters it streamed (about four a token), and
// if the provider hadn't reported usage yet, the request's characters as uncached input (the dearest reading)
export const estimate = (seen: Usage | null, chars: number, requestChars = 0): Usage => {
  const u = seen ?? { input: Math.ceil(requestChars / 4), cacheWrite: 0, cacheRead: 0, output: 0 };
  return { ...u, output: Math.max(u.output, Math.ceil(chars / 4)) };
};

// phone: a phone call's answers (phone.ts)
export type Purpose = 'reply' | 'draft' | 'summary' | 'draft-reply' | 'question-log' | 'question' | 'answer' | 'eval' | 'inbox' | 'phone';
export function record(r: { app: string; conversation?: number | null; session?: string | null; ip?: string | null;
  purpose: Purpose; model: string; usage: Usage; estimate?: boolean; at?: number }) {
  const usd = usdCost(r.model, r.usage), eur = usd * EUR_PER_USD;
  db.prepare(`insert into ledger (at, app, conversation, session, ip, purpose, model, input, cache_write, cache_read, output, eur, usd, estimate)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.at ?? now(), r.app, r.conversation ?? null, r.session ?? null,
    r.ip ? ipKey(r.ip) : null, r.purpose, r.model, r.usage.input, r.usage.cacheWrite, r.usage.cacheRead, r.usage.output, eur,
    usd, r.estimate ? 1 : 0);
  return eur;
}

// ---- the caps (CAP in config.ts): which one stops another model call now, or null
const DAY_MS = 864e5;
const dayStart = (t: number) => t - (t % DAY_MS); // UTC
// the company's day, as one person's budgets count it: a stop lasts until its end (engine.ts)
const todayStart = (t: number) => numbers.bounds(numbers.dayOf(t))[0];
export const dayEnd = (t = now()) => numbers.bounds(numbers.dayOf(t))[1];
// the month is the company's (its days, numbers.ts), as Care › Numbers adds it up, so the month there is what this counts
const monthStart = (t: number) => numbers.bounds(`${numbers.dayOf(t).slice(0, 7)}-01`)[0];
const monthEnd = (t: number) => { const [y, m] = numbers.dayOf(t).split('-').map(Number); return numbers.bounds(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10))[0]; };
const sum = (where: string, ...args: any[]) =>
  (db.prepare(`select coalesce(sum(eur), 0) as eur, count(*) as n from ledger where ${where}`).get(...args) as { eur: number; n: number });

const over = (eur: number, cap: number) => eur >= cap - 1e-9; // sums of floats: €0.14 + €0.01 is at the €0.15 cap

export type Cap = 'credit' | 'month' | 'app' | 'conversation' | 'calls' | 'session' | 'ip';
export function blocked(o: { app: string; conversation?: number | null; session?: string | null; ip?: string | null;
  verified: boolean }, t = now()): Cap | null {
  // the month's cap and an app's day cap stop every conversation: the minutes past them are counted (numbers.ts), apart
  // from the provider's outages, until the cap's month or day is over or a check finds it lifted (a cap raised).
  // With a share of their own (hqMonth), HQ's drafts stop at it and the chats at the rest, so a busy inbox never shows
  // customers the outage card (audit C8). HQ's own stop is no outage: it counts no minutes.
  // The month's total stops everyone whatever the shares: HQ may be past its own (the share set or lowered mid-month).
  const share = Math.max(CAP.hqMonth ?? settings.hqMonth, 0);
  const capDown = () => { numbers.down('cap', '', t, monthEnd(t)); return 'month' as const; };
  // the prepaid credit nearly gone stops every call before the provider refuses them; it lifts once a deploy brings the
  // recharged credit
  const c = credit(t);
  if (c && c.left <= CREDIT_STOP_USD) { numbers.down('cap', '', t); return 'credit'; }
  if (over(sum('at >= ?', monthStart(t)).eur, CAP.month)) return capDown(); // every app and purpose together
  if (share > 0 && o.app === HQ_APP) {
    if (over(sum('app = ? and at >= ?', HQ_APP, monthStart(t)).eur, share)) return 'month';
  } else {
    if (share > 0 && over(sum('app != ? and at >= ?', HQ_APP, monthStart(t)).eur, CAP.month - share)) return capDown();
    numbers.up('cap', '', t);
  }
  if (over(sum('app = ? and at >= ?', o.app, dayStart(t)).eur, CAP.appDay)) { numbers.down('cap', o.app, t, dayStart(t) + DAY_MS); return 'app'; }
  numbers.up('cap', o.app, t);
  // One person's budgets count the company's day, so someone back another day (the session lives 30 days, and a
  // conversation with it) is answered again; what one day may spend stays capped
  const today = todayStart(t);
  if (o.conversation != null) {
    const c = sum('conversation = ? and at >= ?', o.conversation, today);
    if (over(c.eur, CAP.conversation)) return 'conversation';
    if (c.n >= CAP.calls) return 'calls';
  }
  // before any check, a session and an IP get small budgets of their own
  if (!o.verified) {
    if (o.session && over(sum('session = ? and at >= ?', o.session, today).eur, CAP.sessionUnverified)) return 'session';
    if (o.ip && over(sum('ip = ? and at >= ?', ipKey(o.ip), today).eur, CAP.ipDayUnverified)) return 'ip';
  }
  return null;
}

// What one purpose has spent this month (the company's month, as the caps count it): the phone's own cap reads its own
// (phone.ts)
export const monthSpend = (purpose: Purpose, t = now()) => sum('purpose = ? and at >= ?', purpose, monthStart(t)).eur;

// ---- the prepaid credit (CREDIT in config.ts), in dollars, by our own records: what's left, and the last week's pace a day.
// Other keys on the same credit (an eval workspace) aren't in this ledger: their monthly limit counts in full for every
// calendar month since, the current one included.
// With a plan's monthly credit, the months are its billing cycles. Each cycle's spend comes out of its monthly credit
// first, and what's over it out of the prepaid one. What's left is the prepaid credit plus what the current cycle's
// monthly credit still holds. Spend in the credit's first cycle before CREDIT.at counts against that cycle's monthly
// credit (it may have been prepaid: the safe side). Other keys' limits still renew on the 1st, and a calendar month's
// limit may be spent on any of its days: it counts in every cycle that month overlaps (by now), so the count can only
// be high.
export const CREDIT_STOP_USD = 1, CREDIT_WARN_USD = [5, 2];
const PACE_DAYS = 7;
// a row from before the dollars were kept: its euros at today's rate
const usdSince = (t: number, until = Infinity) =>
  (db.prepare('select coalesce(sum(coalesce(usd, eur / ?)), 0) as usd from ledger where at >= ? and at < ?').get(EUR_PER_USD, t, until) as { usd: number }).usd;
type Cycle = { start: number; end: number };
export function credit(t = now()): { left: number; perDay: number; renews: number | null } | null {
  if (!CREDIT) return null;
  const { usd, at, monthly } = CREDIT;
  let prepaidLeft = usd;
  let current = cycle(at);
  while (current.end <= t) {
    prepaidLeft -= Math.max(0, spentInCycle(current, t) - monthlyCreditLeft(current));
    current = cycle(current.end);
  }
  // at least a day, so an hour's spend just after loading isn't read as a day's pace
  const days = Math.min(PACE_DAYS, Math.max(1, (t - at) / DAY_MS));
  const perDay = usdSince(Math.max(at, t - days * DAY_MS)) / days;
  // the current cycle's spend comes off the monthly credit it still holds, and what is over comes off the prepaid credit
  const left = prepaidLeft + monthlyCreditLeft(current) - spentInCycle(current, t);
  return { left, perDay, renews: monthly ? current.end : null };
}
// a cycle's monthly credit, less what was spent in it before the prepaid credit was read
function monthlyCreditLeft(billingCycle: Cycle) {
  const { at, monthly } = CREDIT!;
  if (!monthly || billingCycle.start < monthly.from) return 0;
  return Math.max(0, monthly.usd - usdSince(billingCycle.start, at));
}
// our spend in a cycle since the prepaid credit was read, and the other keys' limits for every calendar month the cycle
// overlaps by t
function spentInCycle(billingCycle: Cycle, t: number) {
  const { at, othersMonthUsd } = CREDIT!;
  const until = billingCycle.end > t ? Infinity : billingCycle.end;
  const countedUntil = Math.min(billingCycle.end - 1, t);
  return usdSince(Math.max(billingCycle.start, at), until) + calendarMonths(billingCycle.start, countedUntil) * othersMonthUsd;
}
// how many calendar months (UTC) the span touches, the first and last included
function calendarMonths(from: number, until: number) {
  const a = new Date(from), b = new Date(until);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1;
}

// The warning the board is owed now: once at each step the credit passes (the lowest it has passed, if it fell past
// several at once), each credit (its amount and time, so a recharge starts again) on its own. creditWarned() records it once HQ
// has the card
export function creditWarning(t = now()) {
  const c = credit(t);
  if (!c) return null;
  const passed = CREDIT_WARN_USD.filter(step => c.left <= step), heard = warnedSteps(t);
  if (!passed.length || passed.every(step => heard.includes(step))) return null;
  return { ...c, steps: passed, stopAt: CREDIT_STOP_USD };
}
// a new billing cycle's monthly credit counts as a recharge: the steps are owed again
const creditKey = (t: number) => `${CREDIT!.usd}@${CREDIT!.at}` + (CREDIT!.monthly ? `+${CREDIT!.monthly.usd}@${cycle(t).start}` : '');
const warnedSteps = (t: number) => (db.prepare('select step from credit_warnings where credit = ?').all(creditKey(t)) as { step: number }[]).map(r => r.step);
export function creditWarned(steps: number[], t = now()) {
  const add = db.prepare('insert or ignore into credit_warnings (credit, step, at) values (?, ?, ?)');
  for (const step of steps) add.run(creditKey(t), step, t);
}

// the billing cycle t falls in (a calendar month without a monthly credit)
function cycle(t: number): Cycle {
  const firstStart = CREDIT?.monthly ? new Date(CREDIT.monthly.from) : null;
  const day = firstStart ? firstStart.getUTCDate() : 1;
  const timeOfDay = firstStart ? firstStart.getTime() - Date.UTC(firstStart.getUTCFullYear(), firstStart.getUTCMonth(), day) : 0;
  const startIn = (year: number, month: number) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(day, lastDay)) + timeOfDay;
  };
  const date = new Date(t);
  const year = date.getUTCFullYear();
  const thisMonth = date.getUTCMonth();
  const month = startIn(year, thisMonth) > t ? thisMonth - 1 : thisMonth;
  return { start: startIn(year, month), end: startIn(year, month + 1) };
}

// ---- HQ's numbers: spend since a time (one app or all), and the dearest conversations
export const spend = (o: { app?: string; since: number }) =>
  o.app ? sum('app = ? and at >= ?', o.app, o.since).eur : sum('at >= ?', o.since).eur;

export const top = (o: { since: number; n: number }) =>
  db.prepare(`select conversation, app, sum(eur) as eur, count(*) as calls from ledger
    where at >= ? and conversation is not null group by conversation, app order by eur desc limit ?`).all(o.since, o.n) as
    { conversation: number; app: string; eur: number; calls: number }[];

// ---- the breaker: down after a failed call and a failed retry; while down, one probe at most every 30 s.
// Its changes are stored (numbers.ts: outage minutes): down at the failure that trips it, each failed probe, up at the
// first call that works
const PROBE = Number(process.env.CARE_PROBE_MS), PROBE_MS = Number.isFinite(PROBE) && PROBE > 0 ? PROBE : 30_000; // shorter only in the local harness's check
let failures = 0;
let lastTry = 0;
export const breaker = {
  state: (): 'up' | 'down' => failures >= 2 ? 'down' : 'up',
  failed(t = now()) { failures++; lastTry = t; if (failures >= 2) numbers.down('breaker', '', t); },
  ok(t = now()) { if (failures >= 2) numbers.up('breaker', '', t); failures = 0; },
  // whether this call may go to the provider: always while up; while down, the first caller after 30 s is the probe
  probe(t = now()) {
    if (failures < 2) return true;
    if (t - lastTry < PROBE_MS) return false;
    lastTry = t;
    return true;
  },
};
