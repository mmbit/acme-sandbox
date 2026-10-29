// Where the AI seats' tokens go, live from the usage table (usage.ts): the Numbers home's Tokens dashboard, the
// platform's own beside the apps' and the kits'. Claude and Codex in one unit, tokens (all a run read and wrote, cache
// reads included: both engines report them alike), per day, kind of job and seat, with Claude's API-equivalent cost
// beside; the context a run opens with, read again on every turn; and what resumed runs cost. Numbers, kinds of job and
// seat ids only, never text. Its shape is a kit dashboard's (template/kits/README.md, "Numbers").
// (one unit for both engines, labels that say what they count)
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
  return {
    id: 'tokens',
    name: 'Tokens',
    about: 'Where the AI seats’ tokens go: Claude and Codex, per kind of job and seat',
    icon: COINS,
    tile: `Claude ${short(sum(claude, g => g.tokens))} · Codex ${short(sum(codex, g => g.tokens))} tokens`,
    figures: figuresOf(claude, codex, medians),
    daily: {
      title: 'Tokens per day',
      sub: 'Claude and Codex together; the table has each, and Claude at API prices',
      columns: [
        { key: 'tokens', label: 'Both engines', unit: 'tokens' },
        { key: 'claude', label: 'Claude', unit: 'tokens' },
        { key: 'codex', label: 'Codex', unit: 'tokens' },
        { key: 'cost', label: 'Claude at API prices', unit: 'USD' },
      ],
      rows: perDay(r.from, r.to, groups),
    },
    bars: [
      bar({ title: 'Claude per kind of job', sub: TOKENS }, claude, g => named(g.kind)),
      bar({ title: 'Codex per kind of job', sub: TOKENS }, codex, g => named(g.kind)),
      bar({ title: 'Tokens per seat', sub: `Claude’s seats and Codex’s. ${TOKENS}` }, groups, g => g.seat ?? 'no seat'),
      openingBar(claude, medians),
      resumedBar(claude),
    ],
  };
}

const TOKENS = 'All a run read and wrote, cache reads included';
type Medians = Map<string | null, number | null>;

function figuresOf(claude: Group[], codex: Group[], medians: Medians) {
  const all = sum(claude, g => g.tokens) + sum(codex, g => g.tokens),
    share = (groups: Group[]) => (all ? `${Math.round((100 * sum(groups, g => g.tokens)) / all)}% of all` : 'none yet');
  const runs = (groups: Group[]) =>
    plural(
      sum(groups, g => g.runs),
      'run',
    );
  return [
    { label: 'Claude', value: sum(claude, g => g.tokens), unit: 'tokens', sub: `${share(claude)} · ${runs(claude)}` },
    { label: 'Codex', value: sum(codex, g => g.tokens), unit: 'tokens', sub: `${share(codex)} · ${runs(codex)}` },
    {
      label: 'Claude at API prices',
      value: dollars(sum(claude, g => g.cost)),
      unit: 'USD',
      sub: 'what its tokens would cost on the API (the seats are flat-rate)',
    },
    {
      label: 'Context a run opens with',
      value: hundreds(medians.get(null)),
      unit: 'tokens',
      sub: `Claude’s median, read again each turn: ${percent(upfrontShare(claude)) ?? '–'}% of what its measured runs read`,
    },
  ];
}

function openingBar(claude: Group[], medians: Medians) {
  return {
    title: 'Opening context per kind of job',
    sub: 'The median a Claude run has read before it starts (its instructions, brief and tools), read again on every turn. After each kind: that context’s share of all its runs read',
    share: false,
    rows: kindsOf(claude.filter(g => g.measured)).map(kind => ({
      label: `${named(kind)} · ${percent(upfrontShare(claude.filter(g => g.kind === kind))) ?? '–'}% of its measured reads`,
      value: hundreds(medians.get(kind)),
      unit: 'tokens',
    })),
  };
}

function resumedBar(claude: Group[]) {
  return {
    title: 'Resumed runs per kind of job',
    sub: 'Claude runs that took their session up again: what they cost at API prices, and how long the session sat idle first',
    rows: kindsOf(claude.filter(g => g.resumed)).map(kind => {
      const of = claude.filter(g => g.kind === kind);
      const idle = sum(of, g => g.idled) ? sum(of, g => g.idle) / sum(of, g => g.idled) : null;
      return {
        label: `${named(kind)} · ${plural(
          sum(of, g => g.resumed),
          'run',
        )}, ${idle === null ? '–' : minutes(idle)} idle`,
        value: dollars(sum(of, g => g.resumedCost)),
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
        input, cache_write, cache_read, output, opening, turns, resumed, idle_ms from usage where ts >= ? and ts < ?),
      ${KINDS}
      select r.hour, r.engine, r.seat, k.kind, count(*) runs, sum(r.cost) cost, sum(r.input + r.cache_write + r.cache_read + r.output) tokens,
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
function perDay(from: string, to: string, groups: Group[]) {
  const days = Array.from({ length: daysFrom(from, to) + 1 }, (_, i) => addDays(from, i));
  const rows = new Map(days.map(day => [day, { day, tokens: 0, claude: 0, codex: 0, cost: 0 }]));
  for (const g of groups) {
    const row = rows.get(companyDay(Date.parse(`${g.hour}:00:00Z`)));
    if (!row) continue;
    row.tokens += g.tokens;
    row[g.engine === 'codex' ? 'codex' : 'claude'] += g.tokens;
    row.cost += g.cost;
  }
  return [...rows.values()].map(row => ({ ...row, cost: dollars(row.cost) }));
}

// tokens per label, the most first
function bar(head: { title: string; sub: string }, groups: Group[], by: (g: Group) => string) {
  const sums = [...totals(groups, by, g => g.tokens)].sort((a, b) => b[1] - a[1]);
  return { ...head, rows: sums.map(([label, v]) => ({ label, value: v, unit: 'tokens' })) };
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
      g => g.tokens,
    ),
  ]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
const sum = (groups: Group[], value: (g: Group) => number) => groups.reduce((s, g) => s + value(g), 0);
// (a kind as the board reads it: 'pr fix' is the fixes a pull request's review asked for)
const named = (kind: string) =>
  kind === 'pr fix' ? 'Fixes after review' : kind.charAt(0).toUpperCase() + kind.slice(1);
// (dollars: cents only under $100, where they still say something)
const dollars = (v: number) => (v < 100 ? Math.round(v * 100) / 100 : Math.round(v));
const hundreds = (v: number | null | undefined) => (v == null ? null : Math.round(v / 100) * 100);
const percent = (share: number | null) => (share === null ? null : Math.round(share * 100));
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;
// a big count as the tile's line says it: 3 figures and B, M or k
const short = (v: number) =>
  v >= 999.5e6
    ? `${+(v / 1e9).toPrecision(3)} B`
    : v >= 999.5e3
      ? `${+(v / 1e6).toPrecision(3)} M`
      : `${Math.round(v / 1e3)} k`;
const minutes = (ms: number) => (ms < 3600e3 ? `${Math.round(ms / 60e3)} min` : `${Math.round(ms / 360e3) / 10} h`);
