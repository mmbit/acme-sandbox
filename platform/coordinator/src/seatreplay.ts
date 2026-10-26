// The live plan replayed on one snapshot with one hypothetical Claude subscription.
import { db } from './db.ts';
import * as predictions from './predictions.ts';
import { inspect, type Snapshot, type Size } from './eta.ts';
import { threadOutlooks, standing, undrawnWords, type ThreadOutlook } from './forecast.ts';
import { extraClaude } from './seatcapacity.ts';
import { HORIZON_DAYS } from './simulation.ts';

type NamedThread = { id: string; name: string; project: string; project_name: string };

export function replay(given: unknown, now = Date.now()) {
  if (given !== '5x' && given !== '20x') return [400, 'extra_seat takes 5x or 20x'] as const;
  const started = performance.now();
  const { snapshot, sizes } = predictions.prepared(now);
  const added = extraClaude(snapshot, given === '5x' ? 5 : 20);
  if (!added.available) return { scenario: 'added_claude_seat', available: false, reason: added.reason };
  const before = played(snapshot, sizes);
  const after = played(added.snapshot, sizes);
  const threads = db
    .prepare(
      `select t.id, t.name, t.project, p.name project_name from threads t
    join projects p on p.id = t.project where t.status = 'open' order by t.project, t.created`,
    )
    .all() as NamedThread[];
  const projects = [...Map.groupBy(threads, t => t.project)].map(([, own]) => ({
    name: own[0].project_name,
    before: projectTime(own, before.threads),
    after: projectTime(own, after.threads),
    threads: own.map(t => ({
      name: t.name,
      window: snapshot.windows?.[t.id] ?? { deadline: null, aim: null },
      before: threadTime(before.threads.get(t.id)),
      after: threadTime(after.threads.get(t.id)),
      change_ms: change(before.threads.get(t.id)?.finish, after.threads.get(t.id)?.finish),
    })),
  }));
  const unpriced = snapshot.seats
    .filter(s => {
      const r = snapshot.rates[s.engine];
      const week = typeof r?.week === 'object' && r.week !== null ? r.week[s.id] : r?.week;
      return r?.five[s.id] == null || week == null;
    })
    .map(s => s.id);
  return {
    scenario: 'added_claude_seat',
    available: true,
    at: now,
    capacity: added.capacity,
    projects,
    unpriced,
    account: { before: before.account, after: after.account },
    resources: before.resources,
    changes: changes(projects.flatMap(p => p.threads)),
    horizon_days: HORIZON_DAYS,
    played_ms: Math.round(performance.now() - started),
  };
}

function played(snapshot: Snapshot, sizes: { usual: Map<number, Size>; slow: Map<number, Size> }) {
  const usual = inspect(snapshot, sizes.usual);
  const slow = inspect(snapshot, sizes.slow, { pace: 'slow' });
  return {
    threads: threadOutlooks(snapshot, usual.outlooks, slow.outlooks, sizes.usual),
    account: { usual: usual.seats, slow: slow.seats, review_queue: usual.review_queue },
    resources: usual.resources,
  };
}

function threadTime(outlook: ThreadOutlook | undefined) {
  return {
    conditional: !!outlook?.cards.length || !!outlook?.capacityConditions?.length,
    capacity_conditions: outlook?.capacityConditions ?? [],
    eta: outlook?.eta ?? null,
    finish: outlook?.finish ?? null,
    held: outlook?.held ?? null,
    slack_ms: outlook?.slack ?? null,
    standing: outlook ? standing(outlook) : null,
    reason: !outlook
      ? 'No open work in the play'
      : outlook.eta !== null
        ? null
        : (undrawnWords(outlook) ?? 'Held or no merge within the replay horizon'),
  };
}

function projectTime(threads: NamedThread[], outlooks: Map<string, ThreadOutlook>) {
  const times = threads.map(t => threadTime(outlooks.get(t.id)));
  const latest = (field: 'eta' | 'finish' | 'held') =>
    times.some(t => t[field] === null) ? null : Math.max(...times.map(t => t[field]!));
  return { eta: latest('eta'), finish: latest('finish'), held: latest('held') };
}

const change = (before: number | null | undefined, after: number | null | undefined) =>
  before == null || after == null ? null : before - after;

function changes(threads: { change_ms: number | null }[]) {
  return {
    earlier: threads.filter(t => t.change_ms !== null && t.change_ms > 0).length,
    later: threads.filter(t => t.change_ms !== null && t.change_ms < 0).length,
    unchanged: threads.filter(t => t.change_ms === 0).length,
    unresolved: threads.filter(t => t.change_ms === null).length,
  };
}
