// What a change to the queue did (the coordinator's moves.ts), as hq job, hq cancel, hq estimate set and hq when say
// it: each agreed deadline's facts first (the coordinator's deadlines.ts), then the other threads it moved, in one
// line, as the agent's to plan with: "Other threads it moves, for your planning only: The shop's checkout by +1 h 40
// min, to Sat 17 Oct, 23:10 UTC", or "It moves no other thread." A finish past a deadline is the agent's to bring
// back first, on a call with what to check (lateLines); a tight or shrinking margin is the agent's to plan with (its
// briefing).
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
      ? `Other deliverables it moves, for your planning only: ${movesWords(others)}.`
      : 'It moves no other deliverable.',
  ];
}
// Said once after the facts. A forecast changes the outlook, not the agreed deadline.
const JUDGED =
  'A planned finish past an agreed deadline is a slip to judge: find why and what would bring the finish back. ' +
  'The board hears of it when nothing does or it ' +
  "asks. A tight or shrinking margin is yours to plan with, and other deliverables' shifts are not news for the board " +
  'unless it asks.';
function movesWords(moves: Move[]) {
  const named = moves.slice(0, MOVES_SHOWN).map(moveWords).join(', ');
  return named + (moves.length > MOVES_SHOWN ? ` and ${plural(moves.length - MOVES_SHOWN, 'more deliverable')}` : '');
}

// Each agreed deadline: who gave it, the finish against it, what `it` did to that, and the slack hours ago; then who
// judges them, and on a call what to do about those it misses, with what else is `late` (hq when's --by).
export function deadlineLines(deadlines: Deadline[], it: string, late: string[] = []) {
  const flag = lateLines([
    ...late,
    ...missWords(deadlines.filter(d => d.finish === null || d.finish > d.deadline).map(threadWords)),
  ]);
  if (!deadlines.length) return ['No deliverable has an agreed deadline.', ...flag];
  return ['Agreed deadlines (deliverable windows):', ...deadlines.map(d => deadlineLine(d, it)), JUDGED, ...flag];
}
// ["The shop's checkout misses its deadline"], or none.
export const missWords = (threads: string[]) =>
  threads.length
    ? [`${threads.join(', ')} ${threads.length > 1 ? 'miss their deadlines' : 'misses its deadline'}`]
    : [];

// On a call (the voice line sets HQ_CALL), a finish past the board's time or a window's deadline comes with what to do
// about it, at the moment it matters. An instruction for the agent's judgment, never a refusal: the board may name two
// times or a soft preference.
export function lateLines(late: string[]) {
  if (!process.env.HQ_CALL || !late.length) return [];
  return [
    '',
    `RED FLAG, not news for the board: ${late.join('; ')}. Before you say a time, judge whether this one makes sense, and check the likely causes:`,
    '- the size: compare clean past jobs (estimate); work sized wrong plays wrong;',
    '- the plan: what it waits on, and whether that should hold it at all (a fault in the scheduler is worth naming);',
    '- other work ahead of it, slowing it: its window puts it first, and the scheduler makes room by itself (never pause that work for it);',
    "- the window: none set, or one later than the board's time (manage's window), then play it again.",
    'If one moves it forward, do that now, on the call, and check again. If none does, tell the board plainly what you ' +
      "looked at and that the time can't be made, and ask whether that's acceptable or whether to look further after the call. " +
      "If the board has already heard of this miss (this call, an earlier one or the intercom) and it hasn't moved, it isn't " +
      "news: don't raise it again.",
  ];
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
