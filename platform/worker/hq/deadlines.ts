// What a change to the queue did (the coordinator's moves.ts), as hq job, hq cancel, hq estimate set and hq when say
// it: each agreed deadline's facts first (the coordinator's deadlines.ts), then the other threads it moved, in one
// line, as the agent's to plan with: "Other threads it moves, for your planning only: The shop's checkout by +1 h 40
// min, to Sat 17 Oct, 23:10 UTC", or "It moves no other thread." The board hears of a deadline when its finish passes
// it or it asks; a tight or shrinking margin is the agent's to plan with (its briefing).
import { at, duration } from './estimate.ts';
import { plural } from './output.ts';

type Eta = { at: number } | 'stalled' | 'none';
export type Move = { thread: string; project: string; name: string; from: Eta; to: Eta };
export type Deadline = {
  thread: string;
  project: string;
  name: string;
  deadline: number;
  aim: number | null;
  by: string | null;
  finish: number | null;
  slack_ms: number | null;
  before?: number | null;
  trend: { hours: number; slack_ms: number | null }[];
};
const MOVES_SHOWN = 6;
export function changeLines(
  { moves, deadlines: agreed }: { moves: Move[]; deadlines: Deadline[] },
  it = 'this change',
) {
  const others = moves.filter(m => !agreed.some(d => d.thread === m.thread));
  return [
    ...deadlineLines(agreed, it),
    others.length
      ? `Other threads it moves, for your planning only: ${movesWords(others)}.`
      : 'It moves no other thread.',
  ];
}
// (said once after the facts: the call's and the intercom's briefings say how to judge them)
const JUDGED =
  'The board hears of an agreed deadline when its finish passes it or the board asks; a tight or shrinking margin is ' +
  "yours to plan with, and other threads' shifts are not news for the board unless it asks.";
function movesWords(moves: Move[]) {
  const named = moves.slice(0, MOVES_SHOWN).map(moveWords).join(', ');
  return named + (moves.length > MOVES_SHOWN ? ` and ${plural(moves.length - MOVES_SHOWN, 'more thread')}` : '');
}

// Each agreed deadline: who gave it, the finish against it, what `it` did to that, and the slack hours ago; then who
// judges them.
export function deadlineLines(deadlines: Deadline[], it: string) {
  if (!deadlines.length) return ['No thread has an agreed deadline.'];
  return ['Agreed deadlines (thread windows):', ...deadlines.map(d => deadlineLine(d, it)), JUDGED];
}
function deadlineLine(d: Deadline, it: string) {
  const aim = d.aim !== null && d.aim !== d.deadline ? `, aim ${at(d.aim)}` : '';
  const by = d.by ? ` (given by ${d.by})` : '';
  const done = d.finish === null ? 'no finish in sight' : `done about ${at(d.finish)}, ${slackWords(d.slack_ms)}`;
  const trend = d.trend.map(t => `${t.hours === 24 ? 'a day' : `${t.hours} h`} ago ${slackWords(t.slack_ms)}`);
  const then = trend.length ? ` Then: ${trend.join('; ')}.` : '';
  return `- ${threadWords(d)}: deadline ${at(d.deadline)}${aim}${by}; ${done}${changeWords(d, it)}.${then}`;
}
const slackWords = (ms: number | null) =>
  ms === null ? 'no finish in sight' : ms < 0 ? `${minutes(-ms)} past it` : `${minutes(ms)} of slack`;
const minutes = (ms: number) => duration(Math.round(ms / 60_000));
function changeWords({ before, finish }: Deadline, it: string) {
  if (before === undefined) return '';
  if (before === null) return finish === null ? '' : ` (none in sight without ${it})`;
  if (finish === null) return ` (${it} takes it out of sight)`;
  const moved = Math.round((finish - before) / 60_000);
  if (!moved) return ` (${it} leaves it)`;
  return ` (${it} ${moved > 0 ? 'takes' : 'gives back'} ${duration(Math.abs(moved))})`;
}
// A thread as the board reads it, "The shop's checkout"; and what a move did to it.
export const threadWords = ({ project, name }: { project: string; name: string }) =>
  `${project}${project.endsWith('s') ? "'" : "'s"} ${name}`;
export function moveWords({ project, name, from, to }: Move) {
  const thread = threadWords({ project, name });
  if (to === 'none') return `${thread} off the queue (no open work left)`;
  if (to === 'stalled') return `${thread} to no merge in sight`;
  if (typeof from !== 'object') return `${thread} to ${at(to.at)}`;
  const minutes = Math.round((to.at - from.at) / 60_000);
  return `${thread} by ${minutes < 0 ? '-' : '+'}${duration(Math.abs(minutes))}, to ${at(to.at)}`;
}
