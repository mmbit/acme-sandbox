// A commit that reaches main outside a pull request HQ merged (a foundation carry, any direct commit) gets a push's gates
// and tests all the same: a check job of its own, which the worker runs with no agent (its carryChecks), and a red one
// becomes the foundation keeper's fix.
import { ceo, roles } from './company.ts';
import { db, remember, setting } from './db.ts';
import { STANDING } from './jobcodes.ts';
import { createJob, preview } from './jobs.ts';
import type { Check } from './review.ts';

// The newest commit on main HQ has heard of
const SEEN = 'carries.seen';
const SHA = /^[0-9a-f]{40}$/;
// How much of each check's report goes in the fix's brief: the keeper runs the checks again for the rest
const REPORT_CHARS = 8_000;
type Commit = { sha: string; parents: string[] };
const CHECKS = ['gates', 'tests'] as const;
type CheckName = (typeof CHECKS)[number];
// What the worker's finish of a check job says: the commit and main before it, and each check's outcome
export type Checked = { carry?: { sha: string; base: string } } & Partial<Record<CheckName, Check>>;

// Main's line along its first parents as the worker's mirror has it, newest first. Each commit since the newest one HQ
// heard of is checked unless HQ merged it, told by real state: it is the very merge commit GitHub answered HQ's merge of
// a reviewed head with, whatever its message or parents say. The first line HQ hears only marks where main is. A line
// that doesn't reach the commit HQ heard of moves nothing: HQ answers with that commit, and the worker sends what main
// took since in pages (each `after` the commit the one before ended on), or, with that commit gone from its history,
// the line as `lost`, which becomes the keeper's job of finding and checking what was never checked. A commit with a
// check job already is never queued twice: that job's outcomes settle it (ended).
export function mainMoved(given: { commits?: unknown; after?: unknown; lost?: unknown }) {
  const line = lineOf(given.commits);
  if (!line) return 400;
  const seen = setting(SEEN);
  const since =
    !seen || given.lost === seen ? 0 : given.after === seen ? line.length : line.findIndex(c => c.sha === seen);
  if (since === -1) return { checks: [], seen };
  const outside = line.slice(0, since).reverse();
  const checks = outside.filter(c => !mergedByHq(c.sha) && !hasChecks(c.sha)).map(c => queueChecks(c.sha));
  if (seen && given.lost === seen) checks.push(queueLost(seen, line[0].sha));
  remember(SEEN, line[0].sha);
  return { checks };
}

// A check job that ended: its outcomes, never that it ran, settle the commit. A red gate or test, or one without a verdict
// (it couldn't run, or the job failed before it did: the worker ends a check job failed then), becomes one job for the
// keeper, with both commits and the reports: fixing what's red, running by hand what never ran. Both green say nothing.
export function ended(job: number, finish: Checked) {
  const row = db.prepare("select carry from jobs where id = ? and status in ('done', 'failed')").get(job) as
    { carry: string | null } | undefined;
  if (!row?.carry) return;
  const red = CHECKS.filter(name => finish[name]?.passed === false);
  const unrun = CHECKS.filter(name => typeof finish[name]?.passed !== 'boolean');
  if (!red.length && !unrun.length) return;
  const sha = row.carry;
  const base = finish.carry?.base ?? `${sha}^1`;
  const reports = [...red, ...unrun]
    .map(
      name =>
        `## The ${name}\n\n${preview(finish[name]?.report ?? 'It never ran: the job ended first.', REPORT_CHARS)}`,
    )
    .join('\n\n');
  const said = [...red.map(name => `${name} red`), ...unrun.map(name => `${name} not run`)].join(', ');
  createJob({
    agent: keeper(),
    word: STANDING.carryFix,
    title: `The checks on ${sha.slice(0, 9)}, a commit main took outside review: ${said}`,
    prompt: fixBrief(sha, base, said, reports),
  });
}

const lineOf = (commits: unknown) => {
  if (!Array.isArray(commits) || !commits.length) return undefined;
  const line = commits as Commit[];
  const valid = line.every(
    c => SHA.test(String(c?.sha)) && Array.isArray(c.parents) && c.parents.every(p => SHA.test(p)),
  );
  return valid ? line : undefined;
};

const mergedByHq = (sha: string) => !!db.prepare('select 1 from prs where merged_as = ?').get(sha);

const hasChecks = (sha: string) => !!db.prepare('select 1 from jobs where carry = ?').get(sha);

// One check job, the keeper's, which the worker runs with no agent
function queueChecks(sha: string) {
  const { id } = createJob({
    agent: keeper(),
    word: STANDING.carryChecks,
    title: `The gates and tests on ${sha.slice(0, 9)}, a commit main took outside review`,
    prompt:
      `Main took ${sha} outside a pull request HQ merged. The worker runs the gates and the tests every push gets on ` +
      `it, against main before it (${sha}^1), with no agent, and a red one queues the keeper's fix. An agent running ` +
      `this job only runs the same at that commit (\`node shared/gates/gates.ts --base ${sha}^1\`, then tests.ts) and ` +
      'reports what they say.',
    carry: sha,
  });
  return id;
}

// The keeper's job for main's history no longer reaching the commit HQ last heard of: what main took in between was
// never checked
function queueLost(seen: string, tip: string) {
  const { id } = createJob({
    agent: keeper(),
    word: STANDING.carryFix,
    title: `Check what main took after ${seen.slice(0, 9)}, which its history no longer has`,
    prompt:
      `HQ last heard of main at ${seen}, and main's history (now at ${tip}) no longer has that commit: it was replaced ` +
      'outside a pull request. What main took in between never had the gates and tests every push gets. Find the last ' +
      "commit main's history shares with what HQ heard of (GitHub's activity log for main shows the force push), run " +
      '`node shared/gates/gates.ts --base <that commit>` and `node shared/gates/tests.ts --base <that commit>` on main, ' +
      'and fix what comes back red in a pull request of your own. With nothing red, end saying so.',
  });
  return id;
}

const fixBrief = (sha: string, base: string, said: string, reports: string) =>
  `Main took ${sha} outside a pull request (a foundation carry or another direct commit), and the gates and tests ` +
  `every push gets, against main before it (${base}), didn't pass there: ${said}.\n\n` +
  'Every company on the foundation builds on the same code, and what reaches main this way gets the same automated ' +
  "guards as any push, so no company's work breaks another's. Run what didn't run yourself, then fix the cause of " +
  "anything red in a pull request of your own: our code where the commit's change is right, the foundation's (marked " +
  "`company: job #<n>, not upstream yet`) where it's wrong. Main may have fixed it since: check main first, and with " +
  'nothing left, end saying so.\n\n' +
  `To run them as the worker did: \`git checkout --detach ${sha}\`, then \`node shared/gates/gates.ts --base ${base}\` ` +
  `and \`node shared/gates/tests.ts --base ${base}\`.\n\n${reports}`;

// The foundation keeper (org.yaml's roles.foundation), else the CEO
const keeper = () => roles().foundation ?? ceo();
