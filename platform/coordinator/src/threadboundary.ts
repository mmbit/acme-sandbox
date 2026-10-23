// The branch boundaries created by tasks waiting for merges within their own thread.
import { outstandingWaitsByJob } from './jobs.ts';

export function mergeBoundaries(tasks: { id: number }[], waits = outstandingWaitsByJob(tasks.map(task => task.id))) {
  const positions = new Map(tasks.map((task, index) => [task.id, index]));
  const boundaries = new Map<number, number>();
  tasks.forEach((task, index) => {
    const boundary = tasks
      .slice(0, index + 1)
      .findLast(prior => waits.get(prior.id)?.some(wait => (positions.get(wait.id) ?? Infinity) <= index));
    if (boundary) boundaries.set(task.id, boundary.id);
  });
  return boundaries;
}
