// Consolidator starts from the shared play and weekly room relative to time until reset.
import { db } from './db.ts';
import { reviewSettings } from './company.ts';
import { findAgent } from './jobs.ts';
import * as latency from './latency.ts';
import { preparedInParts, type prepared } from './predictions.ts';
import { startPlan } from './eta.ts';
import { threadOfBranch } from './panel.ts';
import type { ProspectiveRun } from './reviewplan.ts';

const WEEK_MS = 7 * 24 * 3_600_000;

export function brief(pr: number, candidates: string[]) {
  const ruling = choices(pr, candidates, 'ruling');
  const selected = choose(ruling);
  const preferred = reviewSettings().consolidatorEngine;
  const eligible = ruling.filter(choice => !preferred || choice.engine === selected.engine).map(choice => choice.agent);
  return `Projected ruling starts (epoch milliseconds, ready means the run can start now): ${JSON.stringify(ruling.map(({ agent, engine, start, ready }) => ({ agent, engine, start, ready })))}.
HQ's projected ruling engine: ${selected.engine}. ${preferred ? 'Eligible candidates on it' : 'Eligible suggestions'}: ${JSON.stringify(eligible)}.
You may suggest one of these agents. HQ checks starts again when it queues the ruling.`;
}

// Immediate starts share one admission point. Otherwise the preferred engine must start at least as soon.
// Stable sorting preserves the suggested agent within the chosen engine.
export function choose(choices: Choice[]) {
  const preferred = reviewSettings().consolidatorEngine;
  return choices.toSorted((a, b) => {
    const favored = Number(b.engine === preferred) - Number(a.engine === preferred);
    if (a.ready && b.ready && preferred) return favored;
    const sooner = (a.start ?? Infinity) - (b.start ?? Infinity);
    const roomier = a.weekLeft === null || b.weekLeft === null ? 0 : b.weekLeft - a.weekLeft;
    return sooner || (preferred ? favored : roomier);
  })[0];
}

export type Choice = { agent: string; engine: string } & Room;
type Room = ReturnType<typeof engineRoom>;
// The projections a push's hand-off plays ahead (playAhead): each stage's choices for its pull request's candidates.
export type Projections = { pr: number; candidates: string[]; stages: Map<string, Choice[]> };

export function choices(pr: number, candidates: string[], stage: string, now = Date.now()): Choice[] {
  const ahead =
    handed?.pr === pr && handed.candidates.join() === candidates.join() ? handed.stages.get(stage) : undefined;
  if (ahead) return [...ahead];
  const rooms = new Map(
    [...firstOnEngines(candidates)].map(([engine, agent]) => [
      engine,
      engineRoom(...latency.whole(prospect(pr, agent, engine, stage, now))),
    ]),
  );
  return chosen(candidates, rooms);
}

// Each engine among the candidates with the first of them on it: its projection is that agent's run.
function firstOnEngines(candidates: string[]) {
  const first = new Map<string, string>();
  for (const agent of candidates) {
    const engine = findAgent(agent)!.engine;
    if (!first.has(engine)) first.set(engine, agent);
  }
  return first;
}
const chosen = (candidates: string[], rooms: Map<string, Room>): Choice[] =>
  candidates.map(agent => {
    const engine = findAgent(agent)!.engine;
    return { agent, engine, ...rooms.get(engine)! };
  });

// The queue as it is now with a run of `agent`'s on `engine` for the pull request's round, ready to play (engineRoom):
// a read of the whole queue, in parts (predictions.ts preparedInParts). Reading it holds HQ's thread for most of a
// projection's time.
function* prospect(pr: number, agent: string, engine: string, stage: string, now: number) {
  const { branch, round } = db.prepare('select branch, round from prs where number = ?').get(pr) as {
    branch: string;
    round: number;
  };
  const { id } = db.prepare('select coalesce(max(id), 0) + 1 id from jobs').get() as { id: number };
  const run: ProspectiveRun = {
    id,
    pr,
    round,
    branch,
    thread: threadOfBranch(branch),
    stage,
    agent,
    engine,
    kind: 'consolidate',
    status: 'queued',
  };
  return [yield* preparedInParts(now, [], ['usual'], run), id, engine] as const;
}

// A push's hand-off asks choices() of every engine for two stages, its triage's runner and its ruling's (review.ts
// queueTriage), all in its one synchronous step. So it plays them ahead: each part of each queue read and each play
// takes a turn of HQ's thread of its own (latency.ts turns), all at the same time `now`, so the engines' starts compare.
// The hand-off keeps what it played and hands it to choices() only for the time of its own queueTriage (withProjections).
export async function playAhead(pr: number, candidates: string[], stages: string[]): Promise<Projections> {
  const turn = latency.turns(`PR #${pr}'s triage projections`),
    now = Date.now(),
    played = new Map<string, Choice[]>();
  await turn('the hand-off');
  for (const stage of stages) {
    const rooms = new Map<string, Room>();
    for (const [engine, agent] of firstOnEngines(candidates)) {
      const what = `the ${stage} on ${engine}`;
      const read = await latency.inTurns(prospect(pr, agent, engine, stage, now), part => turn(`${what}: ${part}`));
      rooms.set(engine, engineRoom(...read));
      await turn(`${what}: its play`);
    }
    played.set(stage, chosen(candidates, rooms));
  }
  return { pr, candidates, stages: played };
}
let handed: Projections | undefined;
export function withProjections<T>(projections: Projections, run: () => T) {
  const was = handed;
  handed = projections;
  try {
    return run();
  } finally {
    handed = was;
  }
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
    ready: start !== null && start <= queue.now,
    // A ratio of one leaves the same fraction of allowance as time in the week. Unknown readings cast no vote.
    weekLeft: weeks ? left / weeks : null,
  };
}
