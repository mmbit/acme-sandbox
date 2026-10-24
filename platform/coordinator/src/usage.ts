// Token use per job run, for Finance's seat economics (Max vs Team vs API, and whether to add a seat). Numbers and model
// names only, never text. The worker sends the engine's own figures from the end of a run: Claude's result event (tokens
// per model and total_cost_usd, Claude Code's API-equivalent price, reported on a subscription too; team members
// included) or Codex's turn.completed. Both are running totals for the whole session, and a resumed session starts from
// the totals it saved (checked with both CLIs), so adding up runs would count the earlier ones again. Each run is stored
// as what it added since the session's previous report, whichever job made it (a fix round or a touch-up check goes on
// in its author's session: the worker's carry.ts); a run whose figures are lower than that one started over (a new home,
// or a session that never saved) and is stored whole. A run cut off by a worker restart reports nothing; its tokens show
// up in the session's next run, if the engine saved them.
import { db, once } from './db.ts';

const FIELDS = ['input', 'cacheWrite', 'cacheRead', 'output', 'cost'] as const;
type Tokens = Record<(typeof FIELDS)[number], number>;
type Totals = { models: Record<string, Tokens>; cost: number | null };

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const MODEL = /^[\w.:@\/\[\]-]{1,80}$/;

// What the worker sent, as numbers (anything else is dropped): { models: { <model>: Tokens }, cost?, resumed? }.
function totalsOf(u: any): Totals | undefined {
  if (!u || typeof u !== 'object' || !u.models || typeof u.models !== 'object') return;
  const models = Object.entries(u.models).filter(([m]) => MODEL.test(m)).slice(0, 12)
    .map(([m, t]: [string, any]) => [m, Object.fromEntries(FIELDS.map(f => [f, num(t?.[f])])) as Tokens] as const);
  if (!models.length) return;
  return { models: Object.fromEntries(models), cost: typeof u.cost === 'number' ? num(u.cost) : null };
}

// What a run added to the session's running totals since `before`, its earlier report: the whole run when it started over
const addedTo = (now: Totals, before?: Totals) => {
  let base: Totals = before ?? { models: {}, cost: null };
  const grew = Object.entries(base.models).every(([m, t]) => now.models[m] && FIELDS.every(f => now.models[m][f] >= t[f]))
    && (base.cost ?? 0) <= (now.cost ?? 0);
  if (!grew) base = { models: {}, cost: null };
  const added = Object.entries(now.models).map(([m, t]) =>
    [m, Object.fromEntries(FIELDS.map(f => [f, t[f] - (base.models[m]?.[f] ?? 0)])) as Tokens] as const);
  const sum = (f: (typeof FIELDS)[number]) => added.reduce((s, [, t]) => s + t[f], 0);
  return { models: added.filter(([, t]) => FIELDS.some(f => t[f] > 0)).map(([m]) => m).join(','), input: sum('input'),
    cache_write: sum('cacheWrite'), cache_read: sum('cacheRead'), output: sum('output'),
    cost: now.cost === null ? null : Math.round((now.cost - (base.cost ?? 0)) * 1e6) / 1e6 };
};

export function recordUsage(r: { job: number; engine: string; seat?: string | null; session?: string | null; usage: unknown }) {
  const now = totalsOf(r.usage);
  if (!now) return;
  // (the session's latest report, not only this job's)
  const prev = (r.usage as any).resumed === true && r.session ? db.prepare(
    'select totals from usage where session = ? order by id desc limit 1').get(r.session) as { totals: string } | undefined : undefined;
  const a = addedTo(now, prev && JSON.parse(prev.totals));
  db.prepare(`insert into usage (job, ts, engine, seat, session, models, input, cache_write, cache_read, output, cost, totals)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.job, new Date().toISOString(), r.engine, r.seat ?? null, r.session ?? null,
    a.models, a.input, a.cache_write, a.cache_read, a.output, a.cost, JSON.stringify(now));
}

// Rows from before the base was the session's: a carried session's first run in a job holds the whole session. Each run
// whose session has an earlier report from another job becomes what it added to it, by the same rule. Worked out from
// the rows' totals alone, so it gives the same figures however often it runs.
export function rebaseCarried() {
  const rows = db.prepare(`select id, job, session, totals from usage where session in
    (select session from usage where session is not null group by session having count(distinct job) > 1) order by id`).all() as
    { id: number; job: number; session: string; totals: string }[];
  const last = new Map<string, { job: number; totals: string }>();
  const set = db.prepare(`update usage set models = ?, input = ?, cache_write = ?, cache_read = ?, output = ?, cost = ?
    where id = ?`);
  for (const r of rows) {
    const before = last.get(r.session);
    if (before && before.job !== r.job) {
      const a = addedTo(JSON.parse(r.totals), JSON.parse(before.totals));
      set.run(a.models, a.input, a.cache_write, a.cache_read, a.output, a.cost, r.id);
    }
    last.set(r.session, r);
  }
}
once('2026-10-24-usage-carried-sessions', rebaseCarried);
