// A review fix task's title, and a fix round's, as the consolidator or the accepter wrote them.
import { oneLine } from './agreements.ts';

const TITLE_MAX = 140;
export const BAD_TITLE = `a task's title is one line of up to ${TITLE_MAX} characters`;

// A task's title as the consolidator or the accepter wrote it (model output: anything but a line is none)
export const taskTitle = (given: unknown) => {
  const line = typeof given === 'string' ? oneLine(given) : '';
  return line && line.length <= TITLE_MAX ? line : undefined;
};
// The tasks a fix round without thread order goes under (review.ts), as the consolidator named them (model output):
// each blocking finding's, and its touch-ups' check when it made touch-ups
type Ruling = { blocking?: unknown[]; touchups_task?: unknown };
const blockingOf = (v: Ruling) => (Array.isArray(v.blocking) ? (v.blocking as { task?: unknown }[]) : []);
const roundTasks = (v: Ruling, touchedUp: boolean) => [
  ...blockingOf(v).map(e => e?.task),
  ...(touchedUp ? [v.touchups_task] : []),
];
// Why those tasks can't title the round, so its ruling can't be read (review.ts misjudged): one isn't a title
export function untitledRound(v: Ruling, touchedUp: boolean) {
  const bad = roundTasks(v, touchedUp).findIndex(task => !taskTitle(task));
  if (bad < 0) return undefined;
  return `${bad < blockingOf(v).length ? `blocking finding ${bad + 1}'s "task"` : '"touchups_task"'} isn't one: ${BAD_TITLE}`;
}
// Every task the ruling names, in full, or undefined when it names none (no blocker or touch-up)
export const roundTitle = (v: Ruling, touchedUp: boolean) =>
  [...new Set(roundTasks(v, touchedUp).map(task => oneLine(task as string)))].join('; ') || undefined;
