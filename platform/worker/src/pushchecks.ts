// A push's checks outlive the worker's own process, as the run's CLI does (detached.ts), so a reload neither waits for
// them nor runs them again. Each check is launched with its output to files in /work/runs, and the run's record says
// which are launched and when. The next process waits for the ones still running and reads each outcome from its
// marker and files. A check the record shows launched but that nobody saw end (the container stopped) is run again, and
// one still waiting for its turn starts in the new process's turn.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { alive, dropLaunch, endOf, howEnded, type CheckRun, type Checks, type Launched } from './detached.ts';
import { whole } from './outcome.ts';
import { redact } from './safety.ts';

// passed: exit 0; failed: exit 1, a finding; null: it couldn't run (any other end: no tools, a crash).
export type CheckOutcome = { passed: boolean | null; report: string };
// name: its key in the record; launch: starts it (detached.ts launch); turn: waits for a place to run it, if it must
// (one an earlier process launched takes its place too, so the checks still running count against the limit).
// A check here runs to its end: it's our own code, so a slow one is fixed where it is, its time in the log (outcomeOf).
// lent: a launch first that sends it to a lent machine's helper, with a time limit of its own: a pass or a failure
// there is the check's, and any other end (not taken, lost, its limit) launches it here.
export type CheckSpec<Name extends string = string> = {
  name: Name;
  launch: () => Launched;
  turn?: (f: () => Promise<CheckOutcome>) => Promise<CheckOutcome>;
  lent?: { ms: number; launch: () => Launched };
};
// keep: writes the run's record with these checks in it; watch and unwatch: the shares' view of a running check
// (worker.ts checking); said: its outcome in the worker's log.
export type CheckOptions<Name extends string = string> = {
  runs: string;
  keep: (checks: Checks) => void;
  watch: (pid: number, stopped: string[]) => void;
  unwatch: (pid: number) => void;
  said: (name: Name, words: string) => void;
  wait?: (ms: number) => Promise<unknown>;
};

// The runs in their push's checks, by job, with how to write each one's record: a reload writes them and goes.
export const inChecks = new Map<number, () => void>();

// Every check of a run, its record written first, so a reload from here on finds them all. Its finish report: the body
// with each check's outcome under its name.
export async function runChecks<Name extends string>(
  job: number,
  checks: Checks,
  specs: CheckSpec<Name>[],
  o: CheckOptions<Name>,
) {
  const keep = () => o.keep(checks);
  inChecks.set(job, keep);
  keep();
  try {
    const outcomes = await Promise.all(
      specs.map(spec => {
        const one = () => runCheck((checks.runs[spec.name] ??= { stopped: [] }), spec, keep, o);
        return spec.turn ? spec.turn(one) : one();
      }),
    );
    return { ...checks.body, ...Object.fromEntries(specs.map((spec, i) => [spec.name, outcomes[i]])) };
  } finally {
    inChecks.delete(job);
  }
}

const STOP_SIGNAL = 'SIGTERM';
const LOOK_MS = 500;

// One check: taken on where the record has it running or ended, else launched now.
async function runCheck<Name extends string>(
  check: CheckRun,
  spec: CheckSpec<Name>,
  keep: () => void,
  o: CheckOptions<Name>,
): Promise<CheckOutcome> {
  const wait = o.wait ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  // (running, or its end seen: an orphan's end is written into its marker as supervise.py reaps it)
  const tracked = (l: Launched) => alive(l.pid, l.start) || endOf(o.runs, l, wait).then(code => code !== undefined);
  if (check.launched && !(await tracked(check.launched))) {
    o.said(spec.name, 'cut before its end was seen, so it runs again');
    dropLaunch(o.runs, check.launched);
    check.launched = undefined;
  }
  // (a lent launch's limit and that it's the lent one go in the record, so a reload keeps them whatever the spec says now)
  const start = (launch: () => Launched, lent?: { ms: number }) => {
    Object.assign(check, { launched: launch(), began: Date.now(), ms: lent?.ms, lent: !!lent, stopped: [] });
    keep();
  };
  if (!check.launched) {
    if (spec.lent) start(spec.lent.launch, spec.lent);
    else start(spec.launch);
  }
  for (;;) {
    const ended = await watchLaunch(spec.name, check, o, wait, tracked);
    if (!check.lent || ended.passed !== null) return ended;
    o.said(spec.name, 'had no verdict from the lent machine, so it runs here');
    dropLaunch(o.runs, check.launched!);
    start(spec.launch);
  }
}

// A launch watched to its end; a lent one stopped at its `ms` from its start.
async function watchLaunch<Name extends string>(
  name: Name,
  check: CheckRun,
  o: CheckOptions<Name>,
  wait: (ms: number) => Promise<unknown>,
  tracked: (l: Launched) => Promise<boolean> | boolean,
): Promise<CheckOutcome> {
  const l = check.launched!;
  if (!l.start) {
    o.said(name, 'could not start');
    return { passed: null, report: 'It could not start.' };
  }
  o.watch(l.pid, check.stopped);
  const limit =
    check.ms === undefined
      ? undefined
      : setTimeout(
          () => {
            if (alive(l.pid, l.start)) process.kill(l.pid, STOP_SIGNAL);
          },
          Math.max(0, check.began! + check.ms - Date.now()),
        );
  try {
    for (;;) {
      const how = howEnded(o.runs, l);
      if (how) return outcomeOf(name, check, how, o);
      if (!(await tracked(l))) {
        o.said(name, 'could not run (its end was never seen)');
        return { passed: null, report: 'Its end was never seen.' };
      }
      await wait(LOOK_MS);
    }
  } finally {
    clearTimeout(limit);
    o.unwatch(l.pid);
  }
}

// What a check said: its stdout, else its stderr, redacted. One the shares stopped part of couldn't complete,
// whatever it then said.
function outcomeOf<Name extends string>(
  name: Name,
  check: CheckRun,
  how: { exit?: number; signal?: string },
  o: CheckOptions<Name>,
) {
  const l = check.launched!,
    stopped = check.stopped;
  const told =
    readHead(l.out).trim() || readHead(l.err).trim() || (how.signal ? `stopped (${how.signal})` : `exit ${how.exit}`);
  const output = whole(redact(told), 30_000);
  const report = stopped.length ? `Could not complete: ${stopped.join('; ')}.\n\n${output}` : output;
  let passed: boolean | null = null;
  if (!stopped.length && how.exit === 0) passed = true;
  else if (!stopped.length && how.exit === 1) passed = false;
  const words = stopped.length
    ? `could not complete (${stopped[0]})`
    : passed === null
      ? 'could not run'
      : passed
        ? 'passed'
        : 'failed';
  o.said(name, `${words} in ${Math.round((Date.now() - check.began!) / 1000)} s`);
  return { passed, report };
}

const HEAD_BYTES = 16 << 20;
// A file's first 16 MB
function readHead(file: string) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(fstatSync(fd).size, HEAD_BYTES));
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// ---- the tests, once on the same code

// A push's tests run once on the same code (the coordinator's testresults.ts), claimed in HQ by the code they test before
// they run: a result kept already is the push's report, with nothing run; a claim another push holds is waited for; and
// the push's own run is kept, or its claim given up when it couldn't run (done). A claim that didn't reach HQ (later:
// HQ restarting, past the worker's own tries) is made once more a little later; one HQ refused, or the second, leaves the
// tests not run. A result HQ didn't take leaves the push's outcome as the run gave it, its report saying so: the next
// push of that code runs them again.
export type TestsClaim = { kept?: { passed: boolean; report: string; job: number }; yours?: boolean; running?: number };
// tests: how many passed (tests.ts --outcomes), 0 where none ran
export type TestsOutcome = CheckOutcome & { tests: number };
export type TestsOnce = {
  claim: () => Promise<TestsClaim>;
  done: (outcome: TestsOutcome) => Promise<unknown>;
  wait: () => Promise<unknown>;
  later: () => Promise<unknown>;
  said: (words: string) => void;
};
export async function testsOnce(run: () => Promise<TestsOutcome>, o: TestsOnce): Promise<CheckOutcome> {
  const takeClaim = async (): Promise<CheckOutcome | undefined> => {
    for (let claim = await o.claim(); !claim.yours; claim = await o.claim()) {
      if (claim.kept) {
        const from = `kept from job #${claim.kept.job}'s push of the same code, not run again`;
        o.said(from);
        return { passed: claim.kept.passed, report: `Tests ${from}:\n${claim.kept.report}` };
      }
      await o.wait();
    }
  };
  let keptReport: CheckOutcome | undefined;
  try {
    keptReport = await takeClaim().catch(async (err: unknown) => {
      if (!(err instanceof TypeError)) throw err; // (HQ answered: no claim made again changes that)
      o.said(`claim didn't reach HQ (${(err as Error).message}), made again a little later`);
      await o.later();
      return takeClaim();
    });
  } catch (err) {
    return { passed: null, report: `The tests' claim in HQ couldn't be made: ${(err as Error).message}` };
  }
  if (keptReport) return keptReport;
  const { tests, ...outcome } = await run();
  try {
    await o.done({ ...outcome, tests });
    return outcome;
  } catch (err) {
    // (an incomplete run's claim not given up frees once its job ends)
    if (outcome.passed === null) return outcome;
    const unkept = `HQ didn't keep the result (${(err as Error).message}), so the next push of this code runs them again.`;
    return { ...outcome, report: `${unkept}\n\n${outcome.report}` };
  }
}
