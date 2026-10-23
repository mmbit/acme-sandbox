// The test suites of the areas a change touches, and only that: what the tests (tests.ts) would run, found without
// running any of it. Run on its own, it says whether a change has any:
//   node shared/gates/suites.ts [--base <ref>]
// exits 0 with the line the tests report for a change that has none, or 1 listing the runs it would make. The worker
// asks it first, so a change with no tests in its areas (notes, profiles, briefs) never waits for a turn at the tests
// behind other changes' suites (worker.ts testsCheck).
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { areaOf, git, gitFiles, plural } from './repo.ts';

const TEST_MS = 60_000; // one node test's: one that hangs fails in a minute, and the rest of its file still runs

type Suite = {
  files: RegExp;
  // `serial`: one file at a time, for the second runs of what failed (some tests time out on a busy machine)
  command: (names: string[], serial?: boolean) => string[];
  // where it runs from, for a test file in the repo at `top`
  cwd: (top: string, file: string) => string;
};

// Every area's test command, by the test file's name. node:test files run together from the nearest folder with a
// package.json (the root if none), as `cd platform/coordinator && node --test src/x.test.ts` does, a file per core at
// once, each ending with its last test (what a test that timed out left running can't hold it open). A Python or shell
// test runs on its own from its folder. Browser page checks (*-check.mjs, check.mjs) start servers and a browser and
// are judged by eye: they stay the reviewers', where a change needs them, and the report lists them (PAGE_CHECK).
export const SUITES: Record<'node' | 'python' | 'shell', Suite> = {
  node: {
    files: /\.test\.(ts|js|mjs)$/,
    command: (names, serial) => [
      'node',
      '--test',
      `--test-reporter=${join(import.meta.dirname, 'timings.ts')}`,
      `--test-timeout=${TEST_MS}`,
      '--test-force-exit',
      `--test-concurrency=${serial ? 1 : cores()}`,
      ...names,
    ],
    cwd: (top, file) => packageFolder(top, dirname(file)),
  },
  python: { files: /(^|\/)test_[^/]*\.py$/, command: names => ['python3', ...names], cwd: (_, file) => dirname(file) },
  shell: { files: /(^|\/)test_[^/]*\.sh$/, command: names => ['bash', ...names], cwd: (_, file) => dirname(file) },
};
const PAGE_CHECK = /(^|[/-])check\.mjs$/;

export type Run = { area: string; kind: keyof typeof SUITES; cwd: string; files: string[] };

// What a change in the repo at `root` touches against `baseRef` (committed or not): its base commit, its areas, the
// runs of their suites, and the line on their page checks, which the tests leave to the reviewers. `all`: every area, as
// the nightly run on main takes them (shared/routines/tests.md). `commit`: the change as that commit has it, and nothing
// of the files as they are (a push's tests, tests.ts --commit).
export function changeAt(root: string, baseRef: string, all = false, commit?: string) {
  const base = git(root, 'merge-base', commit ?? 'HEAD', baseRef).trim();
  const listed = (...paths: string[]) =>
    commit
      ? gitFiles(root, 'ls-tree', '-r', '--name-only', commit, '--', ...paths)
      : gitFiles(root, 'ls-files', '-co', '--exclude-standard', '--', ...paths);
  const changed = all
    ? listed()
    : commit
      ? gitFiles(root, 'diff', '--name-only', '--no-renames', base, commit)
      : [
          ...gitFiles(root, 'diff', '--name-only', '--no-renames', base),
          ...gitFiles(root, 'ls-files', '--others', '--exclude-standard'),
        ];
  const areas = [...new Set(changed.map(areaOf))].filter(a => a !== '.').sort();
  const files = areas.flatMap(area => listed(area));
  const checks = files.filter(f => PAGE_CHECK.test(f));
  const pages = checks.length
    ? `\nPage checks in these areas, not run here (a reviewer's, where the change needs one): ${checks.join(', ')}`
    : '';
  return { base, areas, runs: runsOf(root, files), pages };
}

// The report of a change with no suites to run.
export const noTests = ({ areas, pages }: { areas: string[]; pages: string }) =>
  `Tests: none in what this change touches (${areas.join(', ') || 'no area'})${pages}`;

// The runs for a set of files: each suite's files together, per folder it runs from.
function runsOf(root: string, files: string[]): Run[] {
  const runs = new Map<string, Run>();
  for (const file of files) {
    const kind = (Object.keys(SUITES) as Run['kind'][]).find(k => SUITES[k].files.test(file));
    if (!kind || PAGE_CHECK.test(file)) continue;
    const cwd = SUITES[kind].cwd(root, file);
    const id = `${kind} ${areaOf(file)} ${cwd} ${kind === 'node' ? '' : file}`;
    if (!runs.has(id)) runs.set(id, { area: areaOf(file), kind, cwd, files: [] });
    runs.get(id)!.files.push(file);
  }
  return [...runs.values()];
}

// The cores the tests have: a container's CPU limit where it has one (a lent machine's helper), else all of them
function cores() {
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ');
    if (quota !== 'max')
      return Math.max(1, Math.min(availableParallelism(), Math.floor(Number(quota) / Number(period))));
  } catch {
    /* no cgroup v2 here */
  }
  return availableParallelism();
}

// The nearest folder at or above `dir` with a package.json, or the root.
function packageFolder(top: string, dir: string): string {
  if (dir === '.' || existsSync(join(top, dir, 'package.json'))) return dir;
  return packageFolder(top, dirname(dir));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const change = changeAt(root, args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main');
  if (!change.runs.length) console.log(noTests(change));
  for (const run of change.runs)
    console.log(`${run.area}: ${run.kind} in ${run.cwd}, ${plural(run.files.length, 'file')}`);
  process.exitCode = change.runs.length ? 1 : 0;
}
