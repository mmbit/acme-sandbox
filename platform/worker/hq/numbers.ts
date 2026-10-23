// What the apps count (the coordinator's metrics.ts): the home list, or one app's dashboard, as plain text or the
// route's JSON. One app's carries the support chat's lines for it (Care › Numbers), and a company kit may add its own
// lines (kits.ts).
import * as api from './api.ts';
import { euroAmount, minute, present, print, round, stop, text } from './output.ts';

const USAGE = 'usage: hq numbers [<slug>] [--days n] [--mode live|preview] [--json]';

export const numbers = {
  help: `
   hq numbers [<slug>] [--days n] [--mode live|preview] [--json]
                                                     what the apps count, as HQ's Numbers shows it: without a slug one line
                                                     per app, the shop's baskets and the company's own dashboards (28 days
                                                     unless --days); with one, its
                                                     funnel, revenue, countries, ad labels, where its page loads came
                                                     from, what was ordered and each A/B test's standing (days: 1-400;
                                                     mode: live counts or the preview's).
                                                     Numbers per day only, nobody's data`,

  async run(args: string[]) {
    let app = '';
    let days = '';
    let mode = '';
    let asJson = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const value = args[i + 1] ?? '';
      if (arg === '--json') {
        asJson = true;
      } else if (arg === '--days') {
        if (!/^[0-9]+$/.test(value)) stop(USAGE);
        days = value;
        i++;
      } else if (arg === '--mode') {
        if (value !== 'live' && value !== 'preview') stop(USAGE);
        mode = value;
        i++;
      } else if (arg.startsWith('-') || app !== '') {
        stop(USAGE);
      } else {
        app = arg;
      }
    }
    const answer = await api.call(`numbers?app=${api.uri(app)}&days=${days}&mode=${mode}`);
    if (answer.status !== 200) stop(`hq numbers: ${api.errorIn(answer.body)} (HTTP ${answer.status})`);
    if (asJson) return print(answer.body.replace(/\n+$/, ''));
    const counts = JSON.parse(answer.body);
    print(...(present(counts.apps) ? homeList(counts) : dashboard(counts)));
  },
};

// A day's ad spend on an app, for HQ's watch (the coordinator's spend.ts). The euros go as typed, so HQ checks the
// same text the agent wrote. Days are the company's.
export const spend = {
  help: `
   hq spend <slug> <YYYY-MM-DD> <euros>              a day's total ad spend on an app (a day on the company's clock),
                                                     recorded again to correct it. HQ's watch alerts the board at once
                                                     when an app with spend is down, and Finance hears when spend rises
                                                     with sales flat`,

  async run(args: string[]) {
    if (args.length !== 3) stop('usage: hq spend <slug> <YYYY-MM-DD> <euros>');
    const [app, day, euros] = args;
    const answer = await api.call('spend', { body: { app, day, euros } });
    if (answer.status !== 200) stop(`hq spend: ${api.errorIn(answer.body)} (HTTP ${answer.status})`);
    const recorded = JSON.parse(answer.body);
    print(`Recorded: ad spend on ${text(recorded.app)}, ${text(recorded.day)}: ${euroAmount(recorded.cents / 100)}`);
  },
};

// 0.1234 reads 12.34%, and a missing rate –
const percent = (rate: number | null | undefined) =>
  rate === null || rate === undefined ? '–' : `${round(rate * 10000) / 100}%`;

const rateOf = (n: number, of: number) => (of > 0 ? percent(n / of) : '–');

const utc = (time: string | null | undefined) =>
  time === null || time === undefined ? 'never' : `${minute(time)} UTC`;

type Money = { kept: number; paid: number; orders: number; eur: number };

const money = ({ kept, paid, orders, eur }: Money) =>
  `${kept} kept of ${paid} paid (${orders} made), ${euroAmount(eur)}`;

const listed = <T>(entries: T[] | null | undefined, line: (entry: T) => string) =>
  (entries ?? []).length === 0 ? ['  none yet'] : entries!.map(entry => `  ${line(entry)}`);

// ---- the home list

type AppLine = Money & {
  slug: string;
  name: string;
  status: string;
  mode: string;
  revenue: number;
  page: number;
  conversion?: number | null;
  test?: { id: string; state: string };
  updated?: string | null;
};

type HomeCounts = {
  days: number;
  from: string;
  to: string;
  apps: AppLine[];
  broken: { slug: string; error: string }[];
  baskets?: Baskets | null;
  dashboards?: CompanyDashboard[];
};

// A company kit's dashboard (kits.ts, template/kits/README.md)
type Figure = { label: string; value: number | string | null; unit?: string; sub?: string };
type CompanyDashboard = {
  id: string;
  name: string;
  about?: string;
  figures?: Figure[];
  daily?: {
    title?: string;
    columns: { key: string; label?: string; unit?: string }[];
    rows: Record<string, number | string | null>[];
  };
  bars?: { title?: string; rows?: { label: string; value: number | null; unit?: string }[] }[];
  targets?: { label: string; goal: number; unit?: string; lower?: boolean; value: number | null; mark?: string }[];
};

type BasketCounts = { paid: number; several: number; returning: number; known: number };
type Baskets = BasketCounts & { basket: number; checkout: number; days: (BasketCounts & { day: string })[] };
const BASKET_DAYS = 14; // the days listed one by one, newest first (only days with a paid basket; a dashboard's with something)

function homeList({ days, from, to, apps, broken, baskets, dashboards }: HomeCounts) {
  const lines = [`Numbers for the last ${days} days (${from} to ${to}, days on the company's clock):`];
  if (apps.length === 0) lines.push('  No app counts yet (none has app/metrics.json).');
  for (const app of apps) {
    const test = present(app.test) ? `; test ${text(app.test.id)}: ${text(app.test.state)}` : '';
    lines.push(
      `  ${app.slug} (${text(app.name)}), ${text(app.status)}, counting ${text(app.mode)}: ${euroAmount(app.revenue)} from ${app.paid} paid orders, ${app.page} page loads (${percent(app.conversion)} paid)${test}. Last push: ${utc(app.updated)}.`,
    );
  }
  for (const app of broken) lines.push(`  ${app.slug}: ${text(app.error)} (not counting)`);
  if (present(baskets)) lines.push('', ...basketLines(baskets));
  // the company kits' dashboards, each a tile in HQ (kits.ts dashboard)
  for (const dashboard of dashboards ?? []) lines.push('', ...dashboardLines(dashboard));
  return lines;
}

// A company dashboard as HQ prints it: its figures, the days with something (newest first), its bars and its targets
function dashboardLines({ id, name, about, figures, daily, bars, targets }: CompanyDashboard) {
  const value = (v: unknown, unit?: string) => {
    if (v === null || v === undefined) return '–';
    if (typeof v === 'string') return text(v);
    if (unit === 'EUR') return euroAmount(Number(v));
    if (unit === '%') return `${v}%`;
    return unit ? `${v} ${unit}` : `${v}`;
  };
  const lines = [`${text(name)} (${text(id)})${present(about) ? `: ${text(about)}` : ''}`];
  for (const f of figures ?? [])
    lines.push(`  ${text(f.label)}: ${value(f.value, f.unit)}${present(f.sub) ? ` (${text(f.sub)})` : ''}`);
  const columns = daily?.columns ?? [];
  const busy = [...(daily?.rows ?? [])]
    .reverse()
    .filter(row => columns.some(c => Number(row[c.key])))
    .slice(0, BASKET_DAYS);
  if (busy.length > 0) lines.push(`  ${text(daily?.title ?? 'Per day')} (newest first, days with something):`);
  for (const row of busy)
    lines.push(
      `    ${text(row.day)}: ${columns.map(c => `${value(row[c.key], c.unit)} ${text(c.label ?? c.key)}`).join(', ')}`,
    );
  for (const bar of bars ?? [])
    lines.push(
      `  ${text(bar.title ?? 'Breakdown')}: ${(bar.rows ?? []).map(r => `${text(r.label)} ${value(r.value, r.unit)}`).join(', ') || 'none yet'}`,
    );
  for (const t of targets ?? [])
    lines.push(
      `  Target, ${text(t.label)}: ${value(t.goal, t.unit)} or ${t.lower ? 'less' : 'more'}, now ${value(t.value, t.unit)}${present(t.mark) ? ` (${text(t.mark)})` : ''}`,
    );
  return lines;
}

// The shop's live paid baskets: those with more than one thing, and those from a buyer who paid for one in the 12 months
// before (of the baskets whose buyer is known).
function basketLines(baskets: Baskets) {
  const counts = ({ paid, several, returning, known }: BasketCounts) => {
    const ofKnown = known < paid ? ` of the ${known} whose buyer is known` : '';
    return `${paid} paid, ${several} with more than one thing (${rateOf(several, paid)}), ${returning} from a buyer who came back (${rateOf(returning, known)}${ofKnown})`;
  };
  const shown = [...baskets.days].reverse().slice(0, BASKET_DAYS);
  return [
    `The shop's baskets (live): ${baskets.basket} orders put in, ${baskets.checkout} in a checkout opened, ${counts(baskets)}.`,
    ...shown.map(day => `  ${day.day}: ${counts(day)}`),
    ...(baskets.days.length > shown.length
      ? [`  (${baskets.days.length - shown.length} earlier days with baskets: --json has every day)`]
      : []),
  ];
}

// ---- one app's dashboard

type Step = { id: string; label?: string };
type Arm = {
  letter: string;
  metric: { n: number; of: number; rate?: number | null };
  guardrail?: { n: number; of: number; rate?: number | null };
  p?: number | null;
};
type Test = {
  id: string;
  question?: string;
  state: string;
  reason: string;
  days: number;
  progress: number;
  finish: number;
  start: string;
  end?: string;
  arms: Arm[];
};
type Dashboard = {
  name: string;
  slug: string;
  status: string;
  mode: string;
  from: string;
  to: string;
  days: number;
  updated?: string | null;
  file: {
    steps: Step[];
    funnel?: string[] | null;
    blind?: { text?: string; after: string };
    what?: { title?: string; labels?: Record<string, string> };
  };
  steps: Record<string, number>;
  totals: {
    orders: number;
    paid: number;
    refunded: number;
    kept: number;
    eur: number;
    net: number | null;
    netUnknown?: number;
    margin?: number | null;
  };
  countries: (Money & { country?: string | null })[];
  campaigns: (Money & { campaign?: string | null; page: number })[];
  sources?: { source?: string | null; n: number }[];
  what: (Money & { what?: string | null })[];
  stepWhat: Record<string, { what?: string | null; n: number }[]>;
  tests: Test[];
  targets: { id: string; label?: string; goal: number; unit?: string }[];
  chat?: Chat | null;
  lines?: string[];
};

function dashboard(counts: Dashboard) {
  const { file, steps, totals } = counts;
  const names = new Map(file.steps.map(step => [step.id, step.label ?? step.id]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const stepCount = (id: string) => (steps && Object.hasOwn(steps, id) ? steps[id] : undefined) ?? 0;
  const funnel = file.funnel ?? file.steps.map(step => step.id);
  const labels = file.what?.labels ?? {};
  const labelOf = (what: string | null | undefined) =>
    present(what) ? text((Object.hasOwn(labels, what) ? labels[what] : undefined) ?? what) : 'not said';
  const margin =
    totals.margin === null || totals.margin === undefined ? '.' : `, margin before ads ${euroAmount(totals.margin)}.`;
  const net = totals.net === null ? `net unknown for ${totals.netUnknown} kept` : `net ${euroAmount(totals.net)}`;
  const lines = [
    `${text(counts.name)} (${counts.slug}), ${text(counts.status)}, counting ${text(counts.mode)}: ${counts.from} to ${counts.to} (${counts.days} days on the company's clock). Last push: ${utc(counts.updated)}.`,
    '',
    'Funnel:',
    ...funnel.map((id, i) => {
      const before = i > 0 ? ` (${rateOf(stepCount(id), stepCount(funnel[i - 1]))} of the step before)` : '';
      return `  ${nameOf(id)}: ${stepCount(id)}${before}`;
    }),
  ];
  if (present(file.blind?.text)) lines.push(`  (after ${nameOf(file.blind!.after)}: ${text(file.blind!.text)})`);
  lines.push(
    `All steps: ${file.steps.map(step => `${step.id} ${stepCount(step.id)}`).join(', ')}`,
    '',
    `Orders: ${totals.orders} made, ${totals.paid} paid, ${totals.refunded} refunded, ${totals.kept} kept. Revenue ${euroAmount(totals.eur)} (${net})${margin}`,
    'Countries:',
    ...listed(counts.countries, country => `${text(country.country ?? 'unknown')}: ${money(country)}`),
    'Ad labels:',
    ...listed(
      counts.campaigns,
      campaign => `${text(campaign.campaign ?? 'no label')}: ${campaign.page} page loads, ${money(campaign)}`,
    ),
    'Every load by where it came from (agent-<name> and prefetch are left out of page loads and visitors):',
    ...listed(counts.sources, source => `${text(source.source ?? 'not kept')}: ${source.n}`),
    `${text(file.what?.title ?? 'What was ordered')}:`,
    ...listed(counts.what, ordered => `${labelOf(ordered.what)}: ${money(ordered)}`),
  );
  for (const [step, byWhat] of Object.entries(counts.stepWhat)) {
    lines.push(`${nameOf(step)} by what:`, ...listed(byWhat, entry => `${labelOf(entry.what)}: ${entry.n}`));
  }
  lines.push('Tests:', ...((counts.tests ?? []).length === 0 ? ['  none'] : counts.tests.flatMap(testLines)));
  if ((counts.targets ?? []).length > 0) {
    lines.push(
      'Targets:',
      ...counts.targets.map(
        target => `  ${text(target.label ?? target.id)}: no value yet (goal ${target.goal} ${text(target.unit ?? '')})`,
      ),
    );
  }
  if (present(counts.chat)) lines.push(...chatLines(counts.chat));
  // what a company kit adds (kits.ts)
  lines.push(...(counts.lines ?? []).map(line => text(line)));
  return lines;
}

function testLines(test: Test) {
  const question = present(test.question) ? `: ${text(test.question)}` : '';
  const end = present(test.end) ? ` to ${text(test.end)}` : '';
  return [
    `  ${test.id}${question}`,
    `    ${text(test.state)}: ${text(test.reason)} Day ${test.days}, ${round(test.progress * 100)}% of the finish line (${test.finish} per version), from ${text(test.start)}${end}.`,
    ...test.arms.map(armLine),
  ];
}

function armLine({ letter, metric, guardrail, p }: Arm) {
  const guard = present(guardrail) ? `, guardrail ${guardrail.n}/${guardrail.of} = ${percent(guardrail.rate)}` : '';
  return `    ${letter}: ${metric.n}/${metric.of} = ${percent(metric.rate)}${guard}${chanceAgainstA(p)}`;
}

function chanceAgainstA(p: number | null | undefined) {
  if (p === null || p === undefined) return '';
  if (p < 0.001) return ', p < 0.001 against A';
  return `, p = ${round(p * 1000) / 1000} against A`;
}

// ---- the support chat's lines (Care › Numbers)

type TimingValue = number | { over: number } | null;
type Chat = {
  app: string;
  from: string;
  to: string;
  conversations?: number | null;
  resolved?: number | null;
  resolvedRate?: number | null;
  person?: number | null;
  personRate?: number | null;
  questions?: number | null;
  questionRate?: number | null;
  kb: number;
  timing?: Record<string, { n: number; p50: TimingValue; p95: TimingValue; max: TimingValue }> | null;
  helped?: { asked?: number | null; yes?: number | null; no?: number | null } | null;
  reply: { share?: number | null; aim: number; answered: number; waiting: number; oldest?: number | null };
  outage?: number | null;
  cap?: number | null;
  cost?: number | null;
  perConversation?: number | null;
  updated?: string | null;
};

const counted = (n: unknown) => (n === null || n === undefined ? 'not counted yet' : text(n));
const per100 = (rate: unknown) => (rate === null || rate === undefined ? '' : ` (${text(rate)} per 100 conversations)`);
const euros = (amount: number | null | undefined) =>
  amount === null || amount === undefined ? 'not counted yet' : euroAmount(amount);
const minutes = (n: unknown) => (n === null || n === undefined ? 'not counted yet' : `${text(n)} minutes`);

// Turn timing, a line per series (care's numbers.ts took())
const seconds = (ms: TimingValue): string =>
  ms === null ? '–' : typeof ms === 'number' ? `${round(ms / 100) / 10} s` : `>${seconds(ms.over)}`;
function timingLines(timing: Chat['timing']) {
  if (timing === null || timing === undefined) return ['  Turn timing: not counted yet.'];
  const series = Object.entries(timing);
  if (!series.length) return ['  Turn timing: no turns timed.'];
  return [
    '  Turn timing, by <provider>.<channel>.<what>.<outcome> (cut: stopped by the customer or by us):',
    ...series.map(([name, x]) =>
      name.includes('.rounds.')
        ? `    ${text(name)}: ${text(x.n)} turns, rounds: median ${text(x.p50)}, 95th ${text(x.p95)}, most ${text(x.max)}`
        : `    ${text(name)}: ${text(x.n)}, median ${seconds(x.p50)}, 95th ${seconds(x.p95)}, longest ${seconds(x.max)}`,
    ),
  ];
}

function chatLines(chat: Chat) {
  const { reply, helped } = chat;
  const share =
    reply.share === null || reply.share === undefined
      ? 'none decided yet'
      : `${reply.share}% within ${reply.aim} working days`;
  const oldest =
    reply.oldest === null || reply.oldest === undefined ? '.' : `, the oldest for ${reply.oldest} working days.`;
  const each = present(chat.perConversation) ? ` (${euros(chat.perConversation)} a conversation).` : '.';
  return [
    '',
    `The support chat (${text(chat.app)}, ${chat.from} to ${chat.to}, counts only; the board reads it all in Care › Numbers):`,
    `  ${counted(chat.conversations)} conversations. Resolved without a person: ${counted(chat.resolved)}${per100(chat.resolvedRate)}; emails to a person: ${counted(chat.person)}${per100(chat.personRate)}.`,
    `  New questions: ${counted(chat.questions)}${per100(chat.questionRate)}; knowledge base entries: ${text(chat.kb)}. Did this help? asked ${counted(helped?.asked)}, Yes ${counted(helped?.yes)}, Not really ${counted(helped?.no)}.`,
    `  Replies by the board: ${share} (${text(reply.answered)} answered), ${text(reply.waiting)} waiting${oldest}`,
    `  Outage: ${minutes(chat.outage)} (at the provider); past a cap: ${minutes(chat.cap)} (ours). Cost: ${euros(chat.cost)}${each}`,
    ...timingLines(chat.timing),
    `  Last from care: ${utc(chat.updated)}.`,
  ];
}
