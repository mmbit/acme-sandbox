// hq estimate --calibration's threads as both its readers take them (threadtime.ts their time, threadwaits.ts what their
// waiting was): the merges, the jobs and each thread's group of them, a branch's first merge after a time, and a
// thread's span.

export type Merge = { number: number; branch: string; merged: number };
export type Job = {
  id: number;
  kind: string;
  agent: string;
  engine: string;
  pr: number | null;
  round: number | null;
  created: number;
  after: number | null;
  thread: string | null;
  branch: string;
  // (its place in its thread and its end, for threadwaits.ts)
  seq: number;
  finished: number | null;
};
export type Group = { key: string; prs: Merge[]; tasks: Job[]; work: Job[]; reviews: Job[] };

export const firstMergeAfter = (merges: Map<string, Merge[]>, branch: string, at: number) =>
  merges.get(branch)?.find(m => m.merged >= at);

// A thread's span: its first task's creation to its last merge
export const spanOf = (g: Group) => ({
  start: Math.min(...g.tasks.map(t => t.created)),
  end: Math.max(...g.prs.map(p => p.merged)),
});
