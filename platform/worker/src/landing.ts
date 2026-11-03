// A landing run's ends short of its pull request (worker.ts land): GitHub out of reach is the worker's own snag, so the
// job goes back in the queue with what landing it takes (jobs.ts finish); anything else git or GitHub said fails it
import { FetchUnreachedError, PushUnreachedError } from './git.ts';

export type Landing = { summary: string; result: string };
type Run<P> = Landing & {
  job: number;
  session?: string;
  branch: string;
  sha?: string;
  profile?: P;
  failure: (report: string, why: string) => string;
  log: (line: string) => void;
};

export function snagged<P>(run: Run<P>, why: string) {
  const { session, branch, sha, profile, summary, result } = run;
  run.log(`job #${run.job}: ${why}, so it goes back in the queue to land`);
  return {
    status: 'snagged',
    session,
    branch,
    sha,
    profile,
    result: run.failure(result, why),
    landing: { summary, result },
  };
}

// Its push threw (worker.ts pushRun), named by the step that failed: a fix round fetches main before it pushes
// (git.ts pushUpdated).
export function pushThrew<P>(run: Run<P>, err: unknown) {
  const said = String((err as Error).message ?? err);
  if (err instanceof FetchUnreachedError) return snagged(run, `main couldn't be fetched before the push: ${said}`);
  const why = `the push failed: ${said}`;
  if (err instanceof PushUnreachedError) return snagged(run, why);
  return {
    status: 'failed',
    session: run.session,
    branch: run.branch,
    profile: run.profile,
    result: run.failure(run.result, why),
  };
}
