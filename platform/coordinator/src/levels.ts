// A company's levels (its company/levels.json, read by worker/hq/levels.ts levelsIn) as HQ uses them: its own line for
// each level, what hq plan says when a project is its product's only open one, and the marks hq plan gives work past
// its sizes.
import { REPO_DIR } from './config.ts';
import { levelsIn, type Split } from '../../worker/hq/levels.ts';

export const levelsOf = () => levelsIn(REPO_DIR);

// A thread's tasks to do, each marked when it's still to start and sized past split's task size, with their sum and
// whether that's past its thread size
export function splitMarks<T extends { status: string; started: string | null; size_ms: number | null }>(
  tasks: T[],
  split: Split,
) {
  const past = (ms: number, most: number | null) => most !== null && ms > most;
  const toDoMs = tasks.reduce((sum, j) => sum + (j.size_ms ?? 0), 0);
  return {
    tasks: tasks.map(j => ({
      ...j,
      split: j.status === 'queued' && j.started === null && past(j.size_ms ?? 0, split.task_ms),
    })),
    to_do_ms: toDoMs,
    split: past(toDoMs, split.thread_ms),
  };
}
