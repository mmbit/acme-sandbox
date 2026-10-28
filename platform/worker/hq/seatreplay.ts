// The paired added-seat replay, in names for the CEO's call tools.
import type { SeatAccount } from '../../coordinator/src/playledger.ts';
import { at, duration } from './estimate.ts';
import { print, text } from './output.ts';

type Time = { eta: number | null; finish: number | null; held: number | null };
type ThreadTime = Time & {
  conditional?: boolean;
  slack_ms: number | null;
  standing: string | null;
  reason: string | null;
};
export type Replay = {
  scenario: 'added_claude_seat';
  available: boolean;
  reason?: string;
  at: number;
  capacity: {
    plan: number;
    source: string;
    source_plan: number;
    confidence: string;
    five_agent_hours: number;
    week_agent_hours: number;
    stop: number;
    pacing: boolean;
    measured: { fiveHours: number; weekHours: number; fiveIntervals: number; weekIntervals: number } | null;
    assumptions: string[];
  };
  projects: {
    name: string;
    before: Time;
    after: Time;
    threads: {
      name: string;
      window: { deadline: number | null; aim: number | null };
      before: ThreadTime;
      after: ThreadTime;
    }[];
  }[];
  account: {
    before: { usual: SeatAccount[]; slow: SeatAccount[] };
    after: { usual: SeatAccount[]; slow: SeatAccount[] };
  };
  changes: { earlier: number; later: number; unchanged: number; unresolved: number };
  unpriced: string[];
  horizon_days: number;
  played_ms: number;
};

export function show(replay: Replay) {
  if (!replay.available) return print(`Added-seat replay unavailable: ${text(replay.reason)} Nothing changed.`);
  const c = replay.capacity;
  print(
    `Hypothetical added Claude Max ${c.plan}x, live plan at ${at(replay.at)}. Nothing changed.`,
    `Confidence: ${c.confidence}. Based on measured Max ${c.source_plan}x usage.`,
    `Estimated agent time per fresh window at ${(c.stop * 100).toFixed(0)}% reserve threshold: ` +
      `${duration(c.five_agent_hours * 60)} per five-hour window, ${duration(c.week_agent_hours * 60)} per week. ` +
      `Pacing ${c.pacing ? 'on' : 'off'}.`,
  );
  if (c.measured)
    print(
      `Measurement support: ${c.measured.fiveHours.toFixed(1)} agent-hours across ` +
        `${c.measured.fiveIntervals} five-hour intervals, ${c.measured.weekHours.toFixed(1)} agent-hours across ` +
        `${c.measured.weekIntervals} weekly intervals, within the last 14 days.`,
    );
  print(...c.assumptions);
  if (replay.unpriced.length)
    print(
      `${replay.unpriced.length} existing seats have unmeasured fill rates. Quota exhaustion is uncertain where quotas constrain service. Credit-enabled seats retain credit admission.`,
    );
  showAccounts(replay);
  showProjects(replay);
  const changes = replay.changes;
  print(
    `Deliverable finishes: ${changes.earlier} earlier, ${changes.later} later, ${changes.unchanged} unchanged, ${changes.unresolved} unresolved.`,
  );
  print(`Played both usual and slow sizes in ${(replay.played_ms / 1000).toFixed(1)} s.`);
}

function showProjects(replay: Replay) {
  print(`Before → with added seat. ETA means merged. Live means deployed. Reach: ${replay.horizon_days} days.`);
  for (const project of replay.projects) {
    print('', `${text(project.name)}: ${pair(project.before, project.after)}`);
    for (const thread of project.threads) {
      const window =
        thread.window.deadline === null
          ? 'no window'
          : `aim ${time(thread.window.aim)}, deadline ${time(thread.window.deadline)}`;
      print(
        `  ${text(thread.name)}: ${pair(thread.before, thread.after)}; ${window}`,
        `    Before: ${standing(thread.before)}. With added seat: ${standing(thread.after)}.`,
      );
    }
  }
}

function showAccounts(replay: Replay) {
  for (const [name, account] of [
    ['Before', replay.account.before],
    ['With added seat', replay.account.after],
  ] as const) {
    print(`${name}, usual pace seat predictions:`);
    for (const seat of account.usual) {
      const exhaustions = seat.events.filter(event => event.type === 'exhaustion');
      if (!exhaustions.length) print(`  ${seat.seat}: no predicted exhaustion`);
      for (const event of exhaustions) {
        const started = event.started_at === null ? 'hold active at cutoff, original start unknown' : 'runs dry';
        const idle = event.idle_ms == null ? 'idle unknown' : `idle ${duration(event.idle_ms / 60_000)}`;
        const work = event.running_continues ? `work continues, then ${idle}` : idle;
        print(
          `  ${seat.seat}: ${time(event.at)}, ${event.quota}, ${started}, return ${time(event.until ?? null)}, ${work}`,
        );
        for (const run of event.running ?? [])
          print(
            `    Job ${run.job}${run.stage ? ` (${run.stage})` : ''}: ${duration(run.remaining_ms / 60_000)} remaining`,
          );
      }
    }
  }
}

const time = (ms: number | null) => (ms === null ? 'unknown' : at(ms));
const pair = (before: Time, after: Time) =>
  `ETA ${time(before.eta)} → ${time(after.eta)}; live ${time(before.finish)} → ${time(after.finish)}; ` +
  `slow merge ${time(before.held)} → ${time(after.held)}`;
function standing(outlook: ThreadTime) {
  if (outlook.reason) return text(outlook.reason);
  if (outlook.conditional) return 'conditional prediction, subject to board answers or unmeasured capacity';
  if (outlook.slack_ms === null) return 'no window';
  const margin = duration(Math.abs(outlook.slack_ms) / 60_000);
  return `${outlook.standing}, ${margin} ${outlook.slack_ms < 0 ? 'late' : 'slack'}`;
}
