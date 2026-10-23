// Content-free run measurements for the Process audit.
import { db } from './db.ts';
import { org } from './company.ts';
import type { Metrics } from '../../worker/tooling/metrics.ts';

// One snapshot per claimed run. The worker sends it before finish while that run is still open.
db.exec(
  `create table if not exists tooling (run integer primary key references runs(id), engine text not null, metrics text not null)`,
);

export function keepMetrics(job: number, engine: string, metrics: Metrics) {
  const run = db.prepare('select id from runs where job = ? and ended is null').get(job) as { id: number };
  db.prepare('insert or replace into tooling (run, engine, metrics) values (?, ?, ?)').run(
    run.id,
    engine,
    JSON.stringify(metrics),
  );
}

export function listMetrics(since: string, until: string) {
  const departments = new Map<string, string>();
  for (const department of org().departments ?? [])
    for (const agent of department.agents ?? []) departments.set(agent.id, department.id);
  const rows = db
    .prepare(
      `select r.id, r.job, r.started, r.ended, r.ended_as, j.agent, j.kind, j.engine requestedEngine,
    t.engine, t.metrics from runs r join jobs j on j.id = r.job left join tooling t on t.run = r.id
    where r.started >= ? and r.started < ? and r.ended is not null order by r.started, r.id`,
    )
    .all(since, until) as any[];
  return {
    since,
    until,
    runs: rows.map(row => ({
      run: row.id,
      job: row.job,
      started: row.started,
      ended: row.ended,
      outcome: row.ended_as,
      engine: row.engine ?? null,
      requestedEngine: row.requestedEngine,
      department: departments.get(row.agent) ?? null,
      kind: row.kind,
      minutes: (Date.parse(row.ended) - Date.parse(row.started)) / 60_000,
      metrics: row.metrics ? JSON.parse(row.metrics) : null,
    })),
  };
}

export function getInterval(since: unknown, until: unknown): { since: string; until: string } | null {
  const end = until === undefined ? Date.now() : typeof until === 'string' ? Date.parse(until) : NaN;
  const start = since === undefined ? end - 3 * 86_400_000 : typeof since === 'string' ? Date.parse(since) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && start < end
    ? { since: new Date(start).toISOString(), until: new Date(end).toISOString() }
    : null;
}
