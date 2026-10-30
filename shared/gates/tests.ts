// The tests of the areas a change touches, run by the worker on every push beside the gates: a test the change breaks
// goes back to its author before any review, and what ran goes to the reviewers, who read the code instead of running
// it again. npm run tests [-- --base <ref>]   (CODE_STYLE.md, "Tests"). --all: every area's, as the nightly run on main
// takes them (shared/routines/tests.md). --helper: on a lent machine instead (onHelper, lent.ts), as the worker sends a
// push's tests while one has a helper of the `tests` kind. Here every suite runs to its end: they're our own code, so a
// slow one is fixed where it is, and its time is on its line of the report (describeRun). On the helper they stop just before its limit, and fail as too slow for it (reportStopped).
//
// An area is a folder as the refactoring passes take them (repo.ts areaOf), and its suites are its test files, each run
// the way its authors run it (SUITES). A test that fails counts only when it passes at the base: main's own
// failures (a test that needs the network, say) don't hold a change up, and the report names them.
//
// The suites run in a checkout of their own, made fresh from the files as they are (committed or not) and from the base:
// nothing installed in the repo before, by this runner or by hand, reaches them. Each package there with dependencies of
// its own (a kit's sharp) gets them from its lock, at the change and at the base: the worker's image holds only the
// tools' packages, which are linked in where they were installed from the very same manifest and lock and hold no folder
// of the repo. An area whose package can't install, or a failure that can't be compared with the base because one there
// couldn't, leaves the run incomplete, never passed. The gates' type check installs nothing, so a kit loads its own
// packages with createRequire.
//
// --commit <sha>: the change as that commit has it, checked out on its own, and nothing of the files as they are: the
// worker's, which runs a push's tests in a clone of its mirror at the pushed commit and keeps the result by it.
// --outcomes <file>: the tests that passed go there too, for the worker to count on the day as it keeps the push's
// result in HQ (the coordinator's testresults.ts).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { compareBase } from './comparison.ts';
import { HqUnreachable, NO_ROOM_EXIT, NoRoom, onLent, UNREACHED_EXIT } from './lent.ts';
import { areaOf, git, gitFiles, plural, TOOLS_HOME, workingTree } from './repo.ts';
import { helperBundle } from './bundle.ts';
import { changeAt, noTests, SUITES, type Run } from './suites.ts';
import type { FileEnd } from './timings.ts';

const REPORT_LINES = 25; // of each failure's own output
const INSTALL_LINES = 6; // of npm's words when it fails (its usage follows)
const NPM_CI = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']; // without install scripts, as the tools'
// A push's tests on a lent machine (onHelper): the run's time on the helper (HQ's runs.ts takes a run only with one, and
// the helper, helper.mjs pinned by its hash on the board's desktop, ends it then),
// and the file of the tests that passed, which the run brings back
const HELPER_MINUTES = Number(process.env.TESTS_HELPER_MINUTES ?? 30); // (TESTS_HELPER_MINUTES: this file's tests' shorter one)
// There, they stop themselves this long before the limit's end (lent.ts LENT_UNTIL) to say which files were still
// running: tests too slow for it fail as such, back to their author within the limit, and never run again here, where
// nothing would stop them. The margin covers stopping the suites, removing their checkout and writing the attempt
// before the command ends (the helper packs the files it brings back after that, outside the limit).
const STOP_MARGIN_MS = 30_000;
const stopAt = process.env.LENT_UNTIL ? Number(process.env.LENT_UNTIL) * 1000 - STOP_MARGIN_MS : undefined;
const OUTCOMES_FILE = 'tests-outcomes.json';
const COMPARISON_INPUT = 'base-comparison.json';
const COMPARISON_OUTPUT = 'base-outcomes.json';
// Browser test areas include the HQ-load entry points that import the coordinator's check.
const BROWSER_AREAS = new Set([
  'platform/coordinator',
  'platform/hq',
  'shared/review',
  'shared/browser',
  'shared/chromium',
  'shared/watchalong',
]);
const bundleFor = (runs: Run[]) =>
  helperBundle({
    tools: runs.some(run => run.kind !== 'node'),
    browsers: runs.some(run => BROWSER_AREAS.has(run.area)),
  });

type Failure = { key: string; file: string; text: string };
type FailureTargets = Map<Run, { failures: Pick<Failure, 'key' | 'file'>[] }>;
type FileTime = { file: string; seconds: number };
type Outcome = {
  passed: number;
  failures: Failure[];
  seconds: number;
  files: FileTime[];
  signal: NodeJS.Signals | null;
  stopped?: Stopped;
};
// A suite stopped before the limit: its files still running, with their time so far, and those not started
type Stopped = { running: FileTime[]; waiting: string[] };

const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const baseRef = option('--base') ?? 'origin/main';
const all = args.includes('--all');
const atCommit = option('--commit');

try {
  process.exitCode = option('--comparison')
    ? await compareRequest()
    : ((args.includes('--helper') ? await onHelper() : undefined) ?? (await checkChange()));
} catch (err) {
  // tests that couldn't run say so: the worker reports them as not run, never as passed. Those that lost HQ, the worker
  // runs again once it answers, and those with no room here to bundle them, once there's room.
  const unreached = err instanceof HqUnreachable;
  console.log(`The tests could not ${unreached ? 'reach HQ' : 'run'}: ${(err as Error).message}`);
  process.exitCode = unreached ? UNREACHED_EXIT : err instanceof NoRoom ? NO_ROOM_EXIT : 2;
}

async function checkChange() {
  const change = changeAt(root, baseRef, all, atCommit);
  if (!change.runs.length) {
    console.log(noTests(change));
    tellPassed(0);
    return 0;
  }
  const attempt = await inCheckout(atCommit ?? 'HEAD', changeTree(), here => testChange(here, change.runs));
  if (option('--attempt')) {
    writeFileSync(
      option('--attempt')!,
      JSON.stringify({ ...attempt, outcomes: [...attempt.outcomes], notInstalled: [...attempt.notInstalled] }),
    );
    return 0;
  }
  return finishAttempt(attempt, change);
}

// --outcomes: the tests that passed, for the worker
function tellPassed(passed: number) {
  const file = option('--outcomes');
  if (file) writeFileSync(file, JSON.stringify({ passed }));
}

// --helper: the same tests on a lent machine's helper (lent.ts), against the same base, with the tools a Python or
// shell suite needs. Its report, exit code and tests passed are this one's, and so is a run stopped at the helper's
// limit: too slow, a failure (reportStopped).
async function onHelper(): Promise<number | undefined> {
  const change = changeAt(root, baseRef, all, atCommit);
  if (!change.runs.length) return undefined;
  const tree = changeTree();
  const ran = await onLent(root, {
    what: 'Tests',
    base: change.base,
    tree,
    script: 'tests.ts',
    args: [...(all ? ['--all'] : []), '--attempt', `../${OUTCOMES_FILE}`],
    minutes: HELPER_MINUTES,
    bring: [OUTCOMES_FILE],
    ...bundleFor(change.runs),
    limitIsResult: true,
    // (while a helper of the kind is there, they wait for it, its helpers busy with other pushes' tests or not: run here
    // instead they'd take the worker's memory, and a worker short of it stops them)
    waitWhilePresent: true,
  });
  if (!ran) return undefined;
  if (ran.timedOut) {
    console.log(`${tooSlow(ran.machine)}, before they could say which files were still running.\n`);
    console.log(tail(ran.output));
    tellPassed(0);
    return 1;
  }
  const stored = JSON.parse(ran.brought.get(OUTCOMES_FILE)!);
  const attempt: Attempt = {
    ...stored,
    outcomes: new Map(stored.outcomes),
    notInstalled: new Map(stored.notInstalled),
  };
  if (ran.output.trim()) console.log(ran.output.trim());
  const exitCode = attempt.notReached
    ? reportStopped(attempt, attempt.notReached, ran.machine)
    : await finishAttempt(attempt, change, { machine: ran.machine, tree });
  console.log(`(on ${ran.machine})`);
  return exitCode;
}

type Tested = {
  outcomes: Map<Run, Outcome>;
  classes: Classes;
  notRunnable: Run[];
  notInstalled: Map<string, string>;
  setupSeconds: number;
  comparisonSeconds: number;
};

// The helper returns suite outcomes and push reruns. Base comparisons stay with the parent and its HQ ticket.
type Attempt = Omit<Tested, 'classes'> & { failingAgain: string[]; notReached?: Run[] };
type HelperComparison = { machine: string; tree: string };

async function finishAttempt(attempt: Attempt, change: ReturnType<typeof changeAt>, helper?: HelperComparison) {
  const started = Date.now();
  const classes = await classify(change.base, attempt.outcomes, new Set(attempt.failingAgain), helper);
  const comparisonSeconds = attempt.comparisonSeconds + (Date.now() - started) / 1000;
  tellPassed([...attempt.outcomes.values()].reduce((sum, outcome) => sum + outcome.passed, 0));
  return report({ ...attempt, classes, comparisonSeconds }, change.areas, change.pages);
}

// The runs in the checkout at `here`, but those of an area whose package couldn't install there, and how they went.
async function testChange(here: string, runs: Run[]): Promise<Attempt> {
  const setupStarted = Date.now();
  const notInstalled = installPackages(here);
  const setupSeconds = (Date.now() - setupStarted) / 1000;
  const uninstalledAreas = new Set([...notInstalled.keys()].map(pkg => areaOf(`${pkg}/`)));
  const runnable = runs.filter(run => !uninstalledAreas.has(run.area));
  const notRunnable = runs.filter(run => uninstalledAreas.has(run.area));
  const outcomes = new Map<Run, Outcome>();
  // (notReached: the runs a stop at the helper's limit left out)
  const attemptOf = (failingAgain: string[], comparisonSeconds: number, notReached?: Run[]): Attempt => ({
    outcomes,
    failingAgain,
    notReached,
    notRunnable,
    notInstalled,
    setupSeconds,
    comparisonSeconds,
  });
  for (const [i, run] of runnable.entries()) {
    outcomes.set(run, await runSuite(here, run));
    if (outcomes.get(run)!.stopped) return attemptOf([], 0, runnable.slice(i + 1));
  }
  const comparisonStarted = Date.now();
  const failing = [...outcomes].filter(([, outcome]) => outcome.failures.length).map(([run]) => run);
  // A whole-run failure can hide named failures until its rerun completes.
  const reran = await failingIn(here, failing, outcomes);
  const reranStopped = [...reran.reruns].find(([, again]) => again.stopped);
  if (reranStopped) {
    outcomes.set(reranStopped[0], { ...outcomes.get(reranStopped[0])!, stopped: reranStopped[1].stopped });
    return attemptOf([], 0, []);
  }
  for (const [run, again] of reran.reruns) {
    const first = outcomes.get(run)!;
    if (!first.failures.some(f => !f.file)) continue;
    const knownKeys = new Set(first.failures.map(f => f.key));
    const rerunFailures = again.failures.filter(f => !knownKeys.has(f.key));
    outcomes.set(run, { ...first, failures: [...first.failures, ...rerunFailures] });
  }
  return attemptOf([...reran.failed], (Date.now() - comparisonStarted) / 1000);
}

// Prints the report and returns the exit code: 1 for a test the change breaks, 2 for what couldn't run or be compared
// (the worker reports it as not run, with this report), 0 for a pass.
function report(tested: Tested, areas: string[], pages: string) {
  const { outcomes, classes, notRunnable, notInstalled, setupSeconds, comparisonSeconds } = tested;
  const lines = [...outcomes].map(([run, outcome]) => describeRun(run, outcome, classes));
  const named = (some: Failure[]) => some.map(f => f.key).join('; ');
  if (classes.flaky.length) lines.push(`Flaky: ${named(classes.flaky)}`);
  if (classes.failingOnMain.length) lines.push(`Failing on main too: ${named(classes.failingOnMain)}`);
  if (classes.notCompared.length)
    lines.push(`Failing, not compared with ${baseRef} (its packages couldn't install): ${named(classes.notCompared)}`);
  lines.push(...installLines(notRunnable, notInstalled));
  for (const [pkg, why] of classes.notInstalledAtBase) lines.push(`npm ci failed in ${pkg} at ${baseRef}:\n  ${why}`);
  const total = [...outcomes.values()].reduce((s, o) => s + o.seconds, 0);
  lines.push(
    `Time: dependencies ${duration(setupSeconds)}, suites ${duration(total)}, failure comparison ${duration(comparisonSeconds)}`,
  );
  const slowest = [...outcomes.values()]
    .flatMap(o => o.files)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5);
  if (slowest.length) lines.push(`Slowest files: ${slowest.map(f => `${f.file} (${duration(f.seconds)})`).join(', ')}`);
  const installs = notRunnable.length || classes.notCompared.length;
  if (!classes.newFailures.length && installs) {
    console.log("Tests incomplete: some couldn't run or be compared, as packages couldn't install");
    console.log(lines.join('\n') + pages);
    return 2;
  }
  if (!classes.newFailures.length) {
    console.log(`Tests passed: ${plural(areas.length, 'area')} against ${baseRef}, ${duration(total)}`);
    console.log(lines.join('\n') + pages);
    return 0;
  }
  console.log(`Tests failed: ${plural(classes.newFailures.length, 'test')} that pass on ${baseRef} fail here, twice\n`);
  console.log(lines.join('\n'));
  for (const f of classes.newFailures) console.log(`\n${f.text}`);
  console.log(`\nFix each one and run \`npm run tests\` again.${pages}`);
  return 1;
}

// The tests too slow for the helper's limit: they fail as such, naming the files still running with their time so far,
// those not started and the areas not reached, the slowest that ended, and what's known already: the failures so far
// (not compared with the base, which the stop left out) and the packages that couldn't install.
function reportStopped(attempt: Attempt, notReached: Run[], machine: string) {
  const ran = [...attempt.outcomes.values()];
  const failures = ran.flatMap(o => o.failures);
  const running = ran.flatMap(o => o.stopped?.running ?? []).sort((a, b) => b.seconds - a.seconds);
  const waiting = ran.flatMap(o => o.stopped?.waiting ?? []);
  const timed = (files: FileTime[]) => files.map(f => `${f.file} (${duration(f.seconds)})`).join(', ');
  const lines = [`${tooSlow(machine)}.`, `Still running, with their time so far: ${timed(running) || 'none'}`];
  if (waiting.length) lines.push(`Not started: ${waiting.join(', ')}`);
  if (notReached.length) lines.push(`Not reached: ${[...new Set(notReached.map(run => run.area))].join(', ')}`);
  const slowest = ran
    .flatMap(o => o.files)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5);
  if (slowest.length) lines.push(`Slowest that ended: ${timed(slowest)}`);
  if (failures.length)
    lines.push(`Failing so far, not compared with ${baseRef}: ${failures.map(f => f.key).join('; ')}`);
  lines.push(...installLines(attempt.notRunnable, attempt.notInstalled));
  for (const f of failures) lines.push(`\n${f.text}`);
  lines.push('\nMake them fast enough for the limit and push again.');
  console.log(lines.join('\n'));
  tellPassed(ran.reduce((sum, outcome) => sum + outcome.passed, 0));
  return 1;
}

// The report's lines on the runs whose package couldn't install, and npm's words for each package
function installLines(notRunnable: Run[], notInstalled: Map<string, string>) {
  const listed = notRunnable.map(run => `${run.cwd} (${plural(run.files.length, 'file')})`).join(', ');
  return [
    ...(notRunnable.length ? [`Not run, as their package couldn't install: ${listed}`] : []),
    ...[...notInstalled].map(([pkg, why]) => `npm ci failed in ${pkg}:\n  ${why}`),
  ];
}

function tooSlow(machine: string) {
  return `Tests failed: too slow for the helper's ${HELPER_MINUTES}-minute limit on ${machine}, which stopped them (they don't run again here)`;
}

type Classes = {
  newFailures: Failure[];
  failingOnMain: Failure[];
  notCompared: Failure[];
  flaky: Failure[];
  notInstalledAtBase: Map<string, string>;
};

// A failure counts when it fails again on a second run and passes at the base: one that passes the second time is named
// as flaky, for its owner to fix, and one that fails on main too is named as well; neither holds the change up. When a
// package couldn't install at the base, a test there may fail, or never load, for that alone (it can import the package
// from another area): only a failure that passed there counts (its files passed whole, or the base doesn't have them),
// and the rest are named as not compared.
async function classify(
  base: string,
  outcomes: Map<Run, Outcome>,
  failingAgain: Set<string>,
  helper?: HelperComparison,
): Promise<Classes> {
  const failingRuns = [...outcomes].filter(([, o]) => o.failures.length).map(([run]) => run);
  const allFailures = [...outcomes.values()].flatMap(o => o.failures);
  const failures = allFailures.filter(f => failingAgain.has(f.key));
  const failureKeys = failures.map(f => f.key);
  const atBase = failingAgain.size
    ? await compareBase(base, helper ? `helper:${helper.machine}` : 'worker', failureKeys, among =>
        helper
          ? failingOnHelper(base, failingRuns, outcomes, among, helper)
          : failingAtBase(base, failingRuns, outcomes, among),
      )
    : { failed: new Set<string>(), passed: new Set<string>(), notInstalled: new Map<string, string>() };
  const compared = !atBase.notInstalled.size;
  const passesAtBase = (f: Failure) => (compared ? !atBase.failed.has(f.key) : atBase.passed.has(f.key));
  return {
    newFailures: failures.filter(passesAtBase),
    failingOnMain: failures.filter(f => atBase.failed.has(f.key)),
    notCompared: compared ? [] : failures.filter(f => !passesAtBase(f) && !atBase.failed.has(f.key)),
    flaky: allFailures.filter(f => !failingAgain.has(f.key)),
    notInstalledAtBase: atBase.notInstalled,
  };
}

// A run's line in the report: its area, where it ran and what, and how its tests went.
function describeRun(run: Run, outcome: Outcome, classes: Classes) {
  const here = (some: Failure[]) => some.filter(f => outcome.failures.includes(f)).length;
  const newHere = here(classes.newFailures);
  const onMainHere = here(classes.failingOnMain);
  const notComparedHere = here(classes.notCompared);
  const flakyHere = here(classes.flaky);
  const counts = [`${outcome.passed} passed`];
  if (newHere) counts.push(`${newHere} failing`);
  if (onMainHere) counts.push(`${onMainHere} failing on main too`);
  if (notComparedHere) counts.push(`${notComparedHere} failing, not compared with main`);
  if (flakyHere) counts.push(`${flakyHere} flaky (passed on a second run)`);
  const scope = run.cwd === '.' ? '' : `in ${run.cwd}: `;
  const what =
    run.kind === 'node'
      ? `node --test, ${plural(run.files.length, 'file')}`
      : SUITES[run.kind].command(run.files.map(f => relative(run.cwd, f))).join(' ');
  return `- ${run.area} (${scope}${what}): ${counts.join(', ')}, ${duration(outcome.seconds)}`;
}

// Of the failures `among`, the ones that fail at the base too, in a checkout of it with its own packages, and the base's
// packages that couldn't install there.
async function failingAtBase(base: string, failing: Run[], outcomes: FailureTargets, among: Set<string>) {
  return inCheckout(base, base, async dir => {
    const notInstalled = installPackages(dir);
    const { failed, passed, interrupted } = await failingIn(dir, failing, outcomes, among);
    if (interrupted.length) throw new Error(`Base suites stopped by signal: ${interrupted.join(', ')}`);
    return { failed: notInstalled.size ? new Set<string>() : failed, passed, notInstalled };
  });
}

// Base misses use the same helper environment as the push. A lost or different helper supplies no comparison.
async function failingOnHelper(
  base: string,
  failing: Run[],
  outcomes: FailureTargets,
  among: Set<string>,
  helper: HelperComparison,
) {
  const targets = failing.map(run => [
    run,
    { failures: outcomes.get(run)!.failures.map(({ key, file }) => ({ key, file })) },
  ]);
  const request = JSON.stringify({ outcomes: targets, tests: [...among] });
  const ran = await onLent(root, {
    what: 'Base comparison',
    base,
    tree: helper.tree,
    script: 'tests.ts',
    args: ['--comparison', `../${COMPARISON_INPUT}`, '--outcomes', `../${COMPARISON_OUTPUT}`],
    minutes: HELPER_MINUTES,
    bring: [COMPARISON_OUTPUT],
    ...bundleFor(failing),
    inputs: { [COMPARISON_INPUT]: request },
    // (it can only run on the push's helper, so it waits while that helper is busy with other pushes' tests, as they do)
    waitWhilePresent: true,
    fallback: false,
  });
  if (!ran) throw new Error(`The base could not be compared on ${helper.machine}`);
  if (ran.machine !== helper.machine)
    throw new Error(`The base ran on ${ran.machine}, but the push ran on ${helper.machine}`);
  const stored = JSON.parse(ran.brought.get(COMPARISON_OUTPUT)!);
  return {
    failed: new Set<string>(stored.failed),
    passed: new Set<string>(stored.passed),
    notInstalled: new Map<string, string>(stored.notInstalled),
  };
}

async function compareRequest() {
  const request = JSON.parse(readFileSync(option('--comparison')!, 'utf8'));
  const outcomes: FailureTargets = new Map(request.outcomes);
  const base = git(root, 'merge-base', 'HEAD', baseRef).trim();
  const compared = await failingAtBase(base, [...outcomes.keys()], outcomes, new Set(request.tests));
  writeFileSync(
    option('--outcomes')!,
    JSON.stringify({
      failed: [...compared.failed],
      passed: [...compared.passed],
      notInstalled: [...compared.notInstalled],
    }),
  );
  return 0;
}

// The change's tree: --commit's, or the files as they are
function changeTree() {
  return atCommit ? git(root, 'rev-parse', `${atCommit}^{tree}`).trim() : workingTree(root);
}

// A checkout of `tree` beside the repo, at `commit` (what its HEAD says), for `use` to run in, removed after. Its path is
// the real one, as node:test reports a failing test's file by it (a TMPDIR can be a symlink).
async function inCheckout<T>(commit: string, tree: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tests-checkout-')));
  try {
    git(root, 'worktree', 'add', '-q', '--detach', '--no-checkout', dir, commit);
    git(dir, 'read-tree', '-u', '--reset', tree);
    return await use(dir);
  } finally {
    git(root, 'worktree', 'remove', '--force', dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Gives each package in the fresh checkout at `top` its node_modules. The tools' copy is linked in where it was installed
// from the same manifest and lock, or where neither has dependencies of its own (the gates' tools are devDependencies),
// and only if its lock links no folder of the repo: that would load the image's copy of the folder, not the checkout's.
// Any other package with dependencies installs them from its lock. Returns the packages that couldn't, each with npm's
// first lines.
function installPackages(top: string) {
  const notInstalled = new Map<string, string>();
  for (const pkg of gitFiles(top, 'ls-files', 'package.json', '*/package.json').map(dirname)) {
    const tools = join(TOOLS_HOME, pkg);
    const runtime = hasDependencies(join(top, pkg));
    const sameFiles = ['package.json', 'package-lock.json'].every(file =>
      sameFile(join(tools, file), join(top, pkg, file)),
    );
    const toolsFit =
      existsSync(join(tools, 'node_modules')) &&
      !linksFolders(tools) &&
      (runtime ? sameFiles : !hasDependencies(tools));
    if (toolsFit) symlinkSync(join(tools, 'node_modules'), join(top, pkg, 'node_modules'));
    if (toolsFit || !runtime) continue;
    // (npm's own network timeouts end one that waits on the registry)
    const install = spawnSync('npm', NPM_CI, { cwd: join(top, pkg), encoding: 'utf8' });
    if (install.status === 0) continue;
    rmSync(join(top, pkg, 'node_modules'), { recursive: true, force: true });
    const said = (install.stderr ?? '').trim().split('\n').slice(0, INSTALL_LINES).join('\n  ');
    notInstalled.set(
      pkg,
      said || install.error?.message || `npm ci ended with ${install.signal ?? `exit ${install.status}`}`,
    );
  }
  return notInstalled;
}

function hasDependencies(pkg: string) {
  const manifest = join(pkg, 'package.json');
  return existsSync(manifest) && Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}).length > 0;
}

// Whether the package's installation may hold a folder of the repo rather than a published package: a `file:` or
// workspace dependency, at any depth, which its lock records as a link, a `file:` source or a path outside node_modules.
// Without a lock that lists its packages (npm 7's and later), nothing says it doesn't.
function linksFolders(pkg: string) {
  const lock = join(pkg, 'package-lock.json');
  const packages: Record<string, { link?: boolean; resolved?: string }> | undefined = existsSync(lock)
    ? JSON.parse(readFileSync(lock, 'utf8')).packages
    : undefined;
  if (!packages) return true;
  return Object.entries(packages).some(
    ([path, entry]) =>
      (path && !/(^|\/)node_modules\//.test(path)) || entry.link || entry.resolved?.startsWith('file:'),
  );
}

function sameFile(a: string, b: string) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

// The failures that fail again when the files they're in run once more, one at a time, in the repo at `top` (only those
// `among` them), and the ones that pass there: their files all passed that time, or `top` doesn't have them.
async function failingIn(top: string, failing: Run[], outcomes: FailureTargets, among?: Set<string>) {
  const failedAgain = new Set<string>();
  const reruns = new Map<Run, Outcome>();
  const interrupted: string[] = [];
  const passed = new Set<string>();
  for (const run of failing) {
    const failures = outcomes.get(run)!.failures.filter(f => !among || among.has(f.key));
    for (const f of failures) if (f.file && !existsSync(join(top, f.file))) passed.add(f.key);
    const failed = new Set(failures.map(f => f.file));
    // a failure in no file (a whole run that failed without naming a test) runs the whole run again
    const files = run.files.filter(f => (failed.has(f) || failed.has('')) && existsSync(join(top, f)));
    if (!files.length) continue;
    const again = await runSuite(top, { ...run, files }, true);
    reruns.set(run, again);
    for (const f of again.failures) failedAgain.add(f.key);
    if (again.signal) {
      interrupted.push(`${run.area}: ${again.signal}`);
      for (const f of failures) if (!f.file || files.includes(f.file)) failedAgain.add(f.key);
    }
    if (!again.failures.length) for (const f of failures) if (!f.file || files.includes(f.file)) passed.add(f.key);
  }
  return { failed: failedAgain, passed, interrupted, reruns };
}

async function runSuite(top: string, run: Run, serial = false): Promise<Outcome> {
  const names = run.files.map(f => relative(run.cwd, f));
  const started = Date.now();
  const { output, code, signal, stoppedAt } = await spawnNiced(
    SUITES[run.kind].command(names, serial),
    join(top, run.cwd),
  );
  const seconds = (Date.now() - started) / 1000;
  const ends = [...output.matchAll(/^# file-end (.+)$/gm)].map(match => {
    const end = JSON.parse(match[1]) as FileEnd;
    return { ...end, file: relative(top, end.file) };
  });
  const files = ends.map(({ file, seconds }) => ({ file, seconds }));
  if (stoppedAt !== undefined) return stoppedOutcome(top, run, { output, ends, files, stoppedAt, seconds, signal });
  const failures =
    run.kind === 'node'
      ? signal
        ? []
        : tapFailures(output, join(top, run.cwd), run)
      : scriptFailures(output, run, code, signal);
  // a node run that fails without naming a failing test (it never got to the tests) fails as a whole; keyed by the run,
  // as areas without a package.json all run from the root
  if (code !== 0 && !failures.length)
    failures.push({
      key: `${run.area} ${run.kind} ${run.cwd} failed`,
      file: '',
      text: `${run.area}: ${signal ?? `exit ${code}`}\n  ${tail(output)}`,
    });
  return { passed: passedCount(output, failures.length), failures, seconds, files, signal };
}

type StoppedRun = {
  output: string;
  ends: FileEnd[];
  files: FileTime[];
  stoppedAt: number;
  seconds: number;
  signal: NodeJS.Signals | null;
};

// A suite stopped at the helper's limit: the files that ended, as timings.ts heard them end (TAP's lines for them may
// still be held back behind a slow file), and those still running or not started.
function stoppedOutcome(top: string, run: Run, stopped: StoppedRun): Outcome {
  const { output, ends, files, stoppedAt, seconds, signal } = stopped;
  const ended = new Set(files.map(f => f.file));
  const running = [...output.matchAll(/^# file-start (.+)$/gm)]
    .map(match => JSON.parse(match[1]) as { file: string; at: number })
    .map(start => ({ file: relative(top, start.file), seconds: (stoppedAt - start.at) / 1000 }))
    .filter(f => !ended.has(f.file));
  const begun = new Set([...ended, ...running.map(f => f.file)]);
  const waiting = run.kind === 'node' ? run.files.filter(f => !begun.has(f)) : [];
  if (run.kind !== 'node') running.push(...run.files.map(file => ({ file, seconds })));
  const passed = ends.reduce((sum, end) => sum + end.passed, 0);
  const failures = ends.flatMap(end =>
    end.failures.map(f => ({
      key: [end.file, ...f.test].join(' › '),
      file: end.file,
      // (a file's own failure names no test)
      text: [[end.file, ...f.test.slice(-1)].join(': '), ...f.message.split('\n').slice(0, REPORT_LINES)].join('\n  '),
    })),
  );
  return { passed, failures, seconds, files, signal, stopped: { running, waiting } };
}

// A run at a lower priority: the machine's other work (a live call's voice, say) goes first. One that can't start
// rejects: the tests couldn't run.
// On a helper, one still running at stopAt ends there, every process it started with it (stoppedAt).
function spawnNiced(
  argv: string[],
  cwd: string,
): Promise<{ output: string; code: number | null; signal: NodeJS.Signals | null; stoppedAt?: number }> {
  return new Promise((resolve, reject) => {
    // (a node:test run inside another, as this file's own tests are, would otherwise report to the outer one)
    // The ticket belongs to this runner. Nested fixture runners compare their own bases. The helper's limit is this
    // runner's, not its suites'.
    const env = { ...process.env, NODE_TEST_CONTEXT: undefined, TESTS_COMPARISON: undefined, LENT_UNTIL: undefined };
    const child = spawn('nice', ['-n', '10', ...argv], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: stopAt !== undefined,
    });
    const chunks: Buffer[] = [];
    let stoppedAt: number | undefined;
    const stop =
      stopAt === undefined
        ? undefined
        : setTimeout(
            () => {
              stoppedAt = Date.now();
              try {
                process.kill(-child.pid!, 'SIGKILL');
              } catch {
                // (it ended meanwhile)
              }
            },
            Math.max(0, stopAt - Date.now()),
          );
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.on('data', c => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(stop);
      resolve({ output: Buffer.concat(chunks).toString('utf8'), code, signal, stoppedAt });
    });
  });
}

// node:test's TAP: each failing test, keyed by its file and its name under the tests it's in (two tests can each have a
// subtest of the same name), with its diagnostics. A test that failed only because its subtests did is left out: the
// subtests say it.
function tapFailures(output: string, cwd: string, run: Run): Failure[] {
  const lines = output.split('\n');
  const failures: Failure[] = [];
  const open: string[] = []; // the tests open at each depth of TAP's four-space indent
  lines.forEach((line, i) => {
    const subtest = line.match(/^( *)# Subtest: (.*)$/);
    if (subtest) open.splice(subtest[1].length / 4, Infinity, subtest[2]);
    const failed = line.match(/^( *)not ok \d+ - (.*)$/);
    if (!failed) return;
    const [, indent, name] = failed;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s*\.\.\.$/.test(lines[j]); j++) block.push(lines[j].trim());
    if (block.includes("failureType: 'subtestsFailed'")) return;
    const location = block.map(l => l.match(/^location: '(.*):\d+:\d+'$/)?.[1]).find(Boolean);
    const file = location ? join(run.cwd, relative(cwd, location)) : '';
    failures.push({
      key: [file, ...open.slice(0, indent.length / 4), name].join(' › '),
      file,
      text: [`${file || run.area}: ${name}`, ...block.slice(1, REPORT_LINES)].join('\n  '),
    });
  });
  return failures;
}

// A script's failures: the tests unittest names (FAIL: or ERROR:), or the script itself when it names none.
function scriptFailures(output: string, run: Run, code: number | null, signal: NodeJS.Signals | null): Failure[] {
  if (code === 0) return [];
  const file = run.files[0];
  const names = [...output.matchAll(/^(?:FAIL|ERROR): (.+)$/gm)].map(m => m[1]);
  const text = `${file}: ${signal ?? `exit ${code}`}\n  ${tail(output)}`;
  if (!names.length) return [{ key: file, file, text }];
  return names.map((name, i) => ({ key: `${file} › ${name}`, file, text: i ? `${file}: ${name}` : text }));
}

// node:test's summary, unittest's count less what failed, or the scripts' own ok lines
function passedCount(output: string, failed: number) {
  const node = output.match(/^# pass (\d+)$/m);
  if (node) return Number(node[1]);
  const unittest = output.match(/^Ran (\d+) tests? in /m);
  return unittest ? Number(unittest[1]) - failed : (output.match(/^ok\b/gm) ?? []).length;
}

// (functions, not arrow consts: the run at the top calls them before this point of the module is reached)
function tail(output: string) {
  return output.trimEnd().split('\n').slice(-REPORT_LINES).join('\n  ');
}

function duration(seconds: number) {
  return seconds < 10
    ? `${Math.round(seconds * 10) / 10} s`
    : seconds < 60
      ? `${Math.round(seconds)} s`
      : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
