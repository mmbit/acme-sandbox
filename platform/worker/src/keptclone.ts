// A run with no session of its own starts clean, but for a new session in its job's kept clone: the run after a hand-up
// (lighter.ts handedUpLines, the coordinator's jobs.ts handUp) and the one after HQ ended its dead session (the
// coordinator's idleruns.ts restartedWords). Each goes on from the clone's files and commits as the last session left
// them, told why in its briefing.
import { handedUpLines } from './lighter.ts';
import { remove } from './slots.ts';

type Fresh = { session?: string | null; handedUp?: { from: string; note: string }; restarted?: string };

// A run's home and clone made clean before it starts, unless it goes on in its own session or its kept clone
export function clearFresh(job: Fresh, dir: string, home: string) {
  if (job.session) return;
  remove(home);
  if (!job.handedUp && !job.restarted) remove(dir);
}

// Why a new session starts in its kept clone, for its briefing
export const keptCloneLines = (job: Fresh, reviewing: boolean) =>
  (job.handedUp && !reviewing ? `\n\n${handedUpLines(job.handedUp)}` : '') +
  (job.restarted ? `\n\n${job.restarted}` : '');
