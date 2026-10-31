// Consolidator starts from the shared play and weekly room relative to time until reset.
import { db } from './db.ts';
import { findAgent } from './jobs.ts';
import { prepared } from './predictions.ts';
import { startPlan } from './eta.ts';
import { threadOfBranch } from './panel.ts';
import type { ProspectiveRun } from './reviewplan.ts';

const WEEK_MS = 7 * 24 * 3_600_000;

export function brief(pr: number, candidates: string[]) {
  const seats = db.prepare('select engine, state, pace, week, week_resets from seats').all();
  const ruling = choices(pr, candidates, 'ruling');
  return `Engine availability: ${JSON.stringify(seats)}.
Consolidator capacity (start is epoch milliseconds, weekLeft is allowance left divided by time left in the week, null is unknown): ${JSON.stringify(ruling)}.
Suggest a ruling consolidator by weighing the projected starts and each engine's weekly room against its resets above.
Spare the scarce engine
when the other can do the work and start in time.`;
}

export function choices(pr: number, candidates: string[], stage: string, now = Date.now()) {
  const { branch, round } = db.prepare('select branch, round from prs where number = ?').get(pr) as {
    branch: string;
    round: number;
  };
  const { id } = db.prepare('select coalesce(max(id), 0) + 1 id from jobs').get() as { id: number };
  const thread = threadOfBranch(branch);
  const engines = new Map<string, ReturnType<typeof engineRoom>>();
  return candidates.map(agent => {
    const engine = findAgent(agent)!.engine;
    if (!engines.has(engine)) {
      const run: ProspectiveRun = {
        id,
        pr,
        round,
        branch,
        thread,
        stage,
        agent,
        engine,
        kind: 'consolidate',
        status: 'queued',
      };
      const projection = prepared(now, [], ['usual'], run);
      engines.set(engine, engineRoom(projection, id, engine));
    }
    return { agent, engine, ...engines.get(engine)! };
  });
}

function engineRoom({ snapshot: queue, sizes }: ReturnType<typeof prepared>, id: number, engine: string) {
  const start = startPlan(queue, sizes.usual).get(id)!;
  const seats = queue.seats.filter(
    seat => seat.engine === engine && !['closed', 'login', 'paused'].includes(seat.state),
  );
  const measured = seats.filter(seat => seat.week !== null && seat.weekResets !== null && seat.weekResets > queue.now);
  const left = measured.reduce((sum, seat) => sum + Math.max(0, 1 - seat.week!), 0);
  const weeks = measured.reduce((sum, seat) => sum + (seat.weekResets! - queue.now) / WEEK_MS, 0);
  return {
    start,
    // A ratio of one leaves the same fraction of allowance as time in the week. Unknown readings cast no vote.
    weekLeft: weeks ? left / weeks : null,
  };
}
