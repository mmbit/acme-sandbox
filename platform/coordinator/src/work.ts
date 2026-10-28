// What the company got done each day, on its own clock, for HQ's Wire look (renderers/wire): lines changed (the code
// and docs our agents' commits on main changed: commitlines.ts), tokens written (the worker's tellTokens), counted as
// server.ts's agent events come in, tests passed (as each push's tests are kept: testresults.ts), pull requests merged
// and jobs finished (from their own tables). Today and the 13 days before; and each agent's week.
import { db } from './db.ts';
import { companyFormats } from './company.ts';
import { firstCounted, linesSince } from './commitlines.ts';
import { boardJobs } from './boardnames.ts';

// tokens: null on a day before they were counted.
db.exec(
  'create table if not exists work_days (day text primary key, lines integer not null default 0, tests integer not null default 0, tokens integer)',
);

const DAYS = 14;
// a moment's day on the company's clock: "2026-10-10". Every zone's offset is
// whole quarter hours, so a day starts on one: each quarter hour's day is worked out once, not each row's
const QUARTER = 9e5;
const makeDayOf = () => {
  const { dayAt } = companyFormats(),
    known = new Map<number, string>();
  return (t: string | number | Date) => {
    const q = Math.floor(new Date(t).getTime() / QUARTER);
    return known.get(q) ?? known.set(q, dayAt(q * QUARTER)).get(q)!;
  };
};

// Accumulate today's tests and tokens. Line totals come from commitlines.ts.
export function count({ tests = 0, tokens = 0 }: { tests?: number; tokens?: number }) {
  if (!tests && !tokens) return;
  const dayOf = makeDayOf();
  db.prepare(
    `insert into work_days (day, tests, tokens) values (?, ?, ?)
    on conflict(day) do update set tests = tests + excluded.tests,
      tokens = coalesce(tokens + excluded.tokens, excluded.tokens, tokens)`,
  ).run(dayOf(Date.now()), tests, tokens || null);
}

// a pull request merged now (its first merge counts, should it be marked again)
export const markMerged = (pr: number) =>
  db
    .prepare("update prs set status = 'merged', merged_at = coalesce(merged_at, ?) where number = ?")
    .run(new Date().toISOString(), pr);

// the last 14 days, oldest first: { day, lines, tests, tokens, prs, jobs }. Tests and tokens are counted as they come
// in, and lines from main's first commit, so a day before the first one counted has none to give: null, never 0.
export function days(now = Date.now()) {
  const dayOf = makeDayOf();
  const list = Array.from({ length: DAYS }, (_, i) => dayOf(now - (DAYS - 1 - i) * 864e5));
  const since = new Date(now - (DAYS + 1) * 864e5).toISOString(),
    tally = (rows: { t: string; weight?: number }[]) => {
      const n = new Map<string, number>();
      for (const { t, weight = 1 } of rows) {
        const day = dayOf(t);
        n.set(day, (n.get(day) ?? 0) + weight);
      }
      return n;
    };
  const kept = new Map(
    (
      db.prepare('select day, tests, tokens from work_days where day >= ?').all(list[0]) as {
        day: string;
        tests: number;
        tokens: number | null;
      }[]
    ).map(r => [r.day, r]),
  );
  const lines = tally(linesSince(since).map(({ at, lines }) => ({ t: at, weight: lines })));
  const firstLines = firstCounted();
  const prs = tally(db.prepare('select merged_at as t from prs where merged_at >= ?').all(since) as { t: string }[]);
  const jobs = tally(
    db.prepare("select finished as t from jobs where status = 'done' and finished >= ?").all(since) as { t: string }[],
  );
  const first = (db.prepare('select min(day) day from work_days').get() as { day: string | null }).day ?? list.at(-1)!,
    firstTokens = (
      db.prepare('select min(day) day from work_days where tokens is not null').get() as { day: string | null }
    ).day;
  return list.map(day => ({
    day,
    lines: firstLines === null || day < dayOf(firstLines) ? null : (lines.get(day) ?? 0),
    tests: day < first ? null : (kept.get(day)?.tests ?? 0),
    tokens: firstTokens === null || day < firstTokens ? null : (kept.get(day)?.tokens ?? 0),
    prs: prs.get(day) ?? 0,
    jobs: jobs.get(day) ?? 0,
  }));
}

// What's on the company's plate now (HQ's throughput, at the foot of its home): jobs waiting (queued, or held for the
// board's card), at work, and done in the last 24 hours, each split into the review loop's (reviews and their rulings)
// and the rest; the done ones also hour by hour, oldest first, [work, reviews] each. A call's chat isn't work.
const HOURS = 24;
export function piles(now = Date.now()) {
  const out = { waiting: { work: 0, review: 0 }, active: { work: 0, review: 0 }, done: { work: 0, review: 0 } };
  const rows = db
    .prepare(
      `select case status when 'running' then 'active' else 'waiting' end pile,
        kind in ('review', 'consolidate') review, count(*) n
      from jobs where kind != 'chat' and status in ('queued', 'blocked', 'running')
      group by pile, review`,
    )
    .all() as { pile: 'waiting' | 'active'; review: number; n: number }[];
  for (const { pile, review, n } of rows) out[pile][review ? 'review' : 'work'] += n;
  const hours = Array.from({ length: HOURS }, () => [0, 0]),
    done = db
      .prepare(
        `select finished, kind in ('review', 'consolidate') review from jobs indexed by jobs_done_tally
        where kind != 'chat' and status = 'done' and finished >= ?`,
      )
      .all(new Date(now - HOURS * 36e5).toISOString()) as { finished: string; review: number }[];
  for (const { finished, review } of done) {
    const ago = Math.floor((now - Date.parse(finished)) / 36e5);
    hours[HOURS - 1 - Math.min(HOURS - 1, Math.max(0, ago))][review]++;
    out.done[review ? 'review' : 'work']++;
  }
  return { ...out, done: { ...out.done, hours } };
}

// Each agent's last 7 days: jobs done (and each day's, oldest first) and pull requests merged, and the last work job
// they finished (Wire's cards), by its id and its title as the board reads it (boardnames.ts).
export function agents(now = Date.now()) {
  const dayOf = makeDayOf();
  const list = Array.from({ length: 7 }, (_, i) => dayOf(now - (6 - i) * 864e5)),
    since = new Date(now - 8 * 864e5).toISOString(),
    out: Record<
      string,
      {
        jobs: number;
        days: number[];
        prs: number;
        last: { id: number; title: string | null; finished: string } | null;
      }
    > = {};
  const of = (agent: string) => (out[agent] ??= { jobs: 0, days: list.map(() => 0), prs: 0, last: null });
  for (const r of db
    .prepare("select agent, finished from jobs indexed by jobs_done_tally where status = 'done' and finished >= ?")
    .all(since) as {
    agent: string;
    finished: string;
  }[]) {
    const i = list.indexOf(dayOf(r.finished));
    if (i < 0) continue;
    of(r.agent).days[i]++;
    of(r.agent).jobs++;
  }
  for (const r of db
    .prepare('select author agent, count(*) n from prs where merged_at >= ? group by author')
    .all(new Date(now - 7 * 864e5).toISOString()) as { agent: string; n: number }[])
    of(r.agent).prs = r.n;
  const last = db
    .prepare(
      "select id, agent, title, max(finished) finished from jobs indexed by jobs_last_work where status = 'done' and kind = 'work' group by agent",
    )
    .all() as { id: number; agent: string; title: string; finished: string }[];
  for (const { id, agent, title, finished } of boardJobs(last)) of(agent).last = { id, title, finished };
  return out;
}
