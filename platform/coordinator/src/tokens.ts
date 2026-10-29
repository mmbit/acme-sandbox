// Where the AI seats' tokens go, live from the usage table (usage.ts): the Numbers home's Tokens dashboard, the
// platform's own beside the apps' and the kits'. Claude's API-equivalent cost
// per day, kind of job and seat, Codex's tokens per kind, the up-front context a run reads again on every turn, and what
// resumed runs cost. Numbers, kinds of job and seat ids only, never text. Its shape is a kit dashboard's
// (template/kits/README.md, "Numbers").
import { db } from './db.ts';
import { companyDay, companyMoment } from './company.ts';
import { addDays, daysFrom } from './metrics.ts';
import { kindOf } from './jobkinds.ts';

// One group of runs: an hour, an engine, a seat and a kind of job, its sums.
type Group = {
  hour: string;
  engine: string;
  seat: string | null;
  kind: string;
  runs: number;
  cost: number;
  tokens: number;
  measured: number;
  upfront: number;
  measuredTokens: number;
  resumed: number;
  idle: number;
  idled: number;
  resumedCost: number;
};

// a stack of coins
const COINS = [
  '..######..',
  '.#......#.',
  '.########.',
  '.#......#.',
  '.########.',
  '.#......#.',
  '.########.',
  '.#......#.',
  '..######..',
];

// The dashboard for the Numbers home's days (from, to: company days, as metrics.ts home() gives them).
export function dashboard(r: { from: string; to: string }) {
  const groups = groupsIn(r.from, r.to),
    medians = mediansIn(r.from, r.to);
  const claude = groups.filter(g => g.engine !== 'codex'),
    codex = groups.filter(g => g.engine === 'codex');
  const kinds = kindsOf(claude);
  return {
    id: 'tokens',
    name: 'Tokens',
    about: 'Where the AI seats’ tokens go: per kind of job and seat',
    icon: COINS,
    tile: `${usd(sum(claude, g => g.cost))} Claude · ${millions(sum(codex, g => g.tokens))} M Codex tokens`,
    figures: figuresOf(claude, codex, medians),
    daily: {
      title: 'Claude per day',
      sub: 'API-equivalent cost in US dollars, in all and per kind of job',
      columns: [
        { key: 'cost', label: 'All kinds', unit: 'USD' },
        ...kinds.map(kind => ({ key: `kind:${kind}`, label: named(kind), unit: 'USD' })),
      ],
      rows: perDay(r.from, r.to, claude, kinds),
    },
    bars: [
      bar(
        { title: 'Claude per kind of job', sub: COST, unit: 'USD' },
        claude,
        g => named(g.kind),
        g => g.cost,
      ),
      bar(
        { title: 'Claude per seat', sub: COST, unit: 'USD' },
        claude,
        g => g.seat ?? 'no seat',
        g => g.cost,
      ),
      bar(
        { title: 'Codex per kind of job', sub: CODEX, unit: 'M' },
        codex,
        g => named(g.kind),
        g => g.tokens / 1e6,
      ),
      upfrontBar(claude, medians),
      resumedBar(claude),
    ],
  };
}

const COST = 'API-equivalent cost',
  CODEX = 'Millions of tokens: input and cache reads';
type Medians = Map<string | null, number | null>;

function figuresOf(claude: Group[], codex: Group[], medians: Medians) {
  const share = percent(upfrontShare(claude));
  return [
    {
      label: 'Claude, at API prices',
      value: twoDecimals(sum(claude, g => g.cost)),
      unit: 'USD',
      sub: `${sum(claude, g => g.runs)} runs`,
    },
    { label: 'Codex tokens', value: millions(sum(codex, g => g.tokens)), unit: 'M', sub: 'input and cache reads' },
    {
      label: 'Up-front context',
      value: thousands(medians.get(null)),
      unit: 'k tokens',
      sub: `median at a run’s start · ${share ?? '–'}% of tokens`,
    },
    {
      label: 'Resumed runs',
      value: twoDecimals(sum(claude, g => g.resumedCost)),
      unit: 'USD',
      sub: `${sum(claude, g => g.resumed)} runs`,
    },
  ];
}

function upfrontBar(claude: Group[], medians: Medians) {
  return {
    title: 'Up-front context per kind of job',
    sub: 'Median tokens a run starts with (Claude). Its share: of the tokens its runs read, how much is that context read again each turn',
    share: false,
    rows: kindsOf(claude.filter(g => g.measured)).map(kind => ({
      label: `${named(kind)} · ${percent(upfrontShare(claude.filter(g => g.kind === kind))) ?? '–'}%`,
      value: thousands(medians.get(kind)),
      unit: 'k tokens',
    })),
  };
}

function resumedBar(claude: Group[]) {
  return {
    title: 'Resumed runs per kind of job',
    sub: 'What a run that took its session up again cost, and how long the session sat idle before it',
    rows: kindsOf(claude.filter(g => g.resumed)).map(kind => {
      const of = claude.filter(g => g.kind === kind);
      const idle = sum(of, g => g.idled) ? sum(of, g => g.idle) / sum(of, g => g.idled) : null;
      return {
        label: `${named(kind)} · ${sum(of, g => g.resumed)} runs, ${idle === null ? '–' : minutes(idle)} idle`,
        value: twoDecimals(sum(of, g => g.resumedCost)),
        unit: 'USD',
      };
    }),
  };
}

// ---- reading: the period's runs grouped by hour (a company day is whole hours of UTC in every zone on the hour)
function groupsIn(from: string, to: string): Group[] {
  return (
    db
      .prepare(
        `with runs as materialized (select job, substr(ts, 1, 13) hour, engine, seat, coalesce(cost, 0) cost,
        input, cache_write, cache_read, opening, turns, resumed, idle_ms from usage where ts >= ? and ts < ?),
      ${KINDS}
      select r.hour, r.engine, r.seat, k.kind, count(*) runs, sum(r.cost) cost, sum(r.input + r.cache_read) tokens,
        count(r.opening) measured, coalesce(sum(r.opening * r.turns), 0) upfront,
        sum(iif(r.opening is null, 0, r.input + r.cache_write + r.cache_read)) measuredTokens,
        count(iif(r.resumed = 1, 1, null)) resumed, coalesce(sum(iif(r.resumed = 1, r.idle_ms, null)), 0) idle,
        count(iif(r.resumed = 1, r.idle_ms, null)) idled,
        sum(iif(r.resumed = 1, r.cost, 0)) resumedCost
      from runs r join kinds k on k.job = r.job group by 1, 2, 3, 4`,
      )
      .all(...periodOf(from, to)) as Group[]
  ).filter(g => companyDay(Date.parse(`${g.hour}:00:00Z`)) >= from);
}

// The median opening per kind of job, and of all (the null key): over the runs whose opening was measured
function mediansIn(from: string, to: string) {
  const rows = db
    .prepare(
      `with runs as materialized (select job, opening from usage where ts >= ? and ts < ? and opening is not null),
      ${KINDS}
      select k.kind, median(r.opening) median from runs r join kinds k on k.job = r.job group by k.kind
      union all select null, median(opening) from runs`,
    )
    .all(...periodOf(from, to)) as { kind: string | null; median: number | null }[];
  return new Map(rows.map(row => [row.kind, row.median]));
}

// each run's job's kind, once per job
const KINDS = `kinds as materialized (select j.id job, ${kindOf()} kind
  from jobs j indexed by jobs_report where j.id in (select job from runs))`;

// the period's first and last company days as UTC times, for usage.ts
function periodOf(from: string, to: string) {
  const start = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(companyMoment(y, m, d, 0, 0)).toISOString();
  };
  return [start(from), start(addDays(to, 1))];
}

// ---- shaping
function perDay(from: string, to: string, claude: Group[], kinds: string[]) {
  const days = Array.from({ length: daysFrom(from, to) + 1 }, (_, i) => addDays(from, i));
  const rows = new Map(
    days.map(day => [day, { day, cost: 0, ...Object.fromEntries(kinds.map(k => [`kind:${k}`, 0])) }]),
  );
  for (const g of claude) {
    const row = rows.get(companyDay(Date.parse(`${g.hour}:00:00Z`))) as Record<string, number> | undefined;
    if (!row) continue;
    row.cost += g.cost;
    row[`kind:${g.kind}`] += g.cost;
  }
  return [...rows.values()].map(row =>
    Object.fromEntries(Object.entries(row).map(([key, v]) => [key, typeof v === 'number' ? twoDecimals(v) : v])),
  );
}

function bar(
  head: { title: string; sub: string; unit: string },
  groups: Group[],
  by: (g: Group) => string,
  value: (g: Group) => number,
) {
  const sums = [...totals(groups, by, value)].sort((a, b) => b[1] - a[1]);
  return { ...head, rows: sums.map(([label, v]) => ({ label, value: twoDecimals(v), unit: head.unit })) };
}

// Of the tokens the measured runs read, the share that is their opening context read again on every turn.
const upfrontShare = (groups: Group[]) => {
  const tokens = sum(groups, g => g.measuredTokens);
  return tokens ? sum(groups, g => g.upfront) / tokens : null;
};

const totals = (groups: Group[], by: (g: Group) => string, value: (g: Group) => number) => {
  const out = new Map<string, number>();
  for (const g of groups) out.set(by(g), (out.get(by(g)) ?? 0) + value(g));
  return out;
};
const kindsOf = (groups: Group[]) =>
  [
    ...totals(
      groups,
      g => g.kind,
      g => g.cost,
    ),
  ]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
const sum = (groups: Group[], value: (g: Group) => number) => groups.reduce((s, g) => s + value(g), 0);
const named = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);
const twoDecimals = (v: number) => Math.round(v * 100) / 100;
const usd = (v: number) => `$${Math.round(v).toLocaleString('en-GB')}`;
const millions = (v: number) => Math.round(v / 1e5) / 10;
const thousands = (v: number | null | undefined) => (v == null ? null : Math.round(v / 100) / 10);
const percent = (share: number | null) => (share === null ? null : Math.round(share * 1000) / 10);
const minutes = (ms: number) => (ms < 3600e3 ? `${Math.round(ms / 60e3)} min` : `${Math.round(ms / 360e3) / 10} h`);
