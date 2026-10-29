// The foundation changes not carried back yet, for the status report.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

// The foundation's own paths in a company's repo (AGENTS.md, "The platform is shared"), the review's foundation
// question's too (reviewlenses.ts)
export const FOUNDATION = [
  'platform',
  'infra',
  'shared',
  '.github',
  'docs',
  'CODE_STYLE.md',
  'package.json',
  'eslint.config.js',
  'tsconfig.json',
  '.prettierignore',
];
const TITLE_CHARACTERS = 120;
// A marked change, the way the foundation's route spells it (`company: job #<n>, not upstream yet`), or several jobs'
// (`company: jobs #<n> and #<m>`, `jobs #<n>, #<m> and #<k>`), maybe wrapped onto the next comment line anywhere after
// `company:`. One the foundation declined and the company keeps says `kept here`, and isn't coming.
const GAP = String.raw`(?:\s|//|#\s|\*|<!--)*`;
const JOBS = String.raw`#[0-9]+(?:${GAP}(?:,${GAP}(?:and${GAP})?|and${GAP})#[0-9]+)*`;
const MARKER = new RegExp(`company:${GAP}jobs?${GAP}(${JOBS})(,${GAP}kept${GAP}here)?`, 'g');
const run = promisify(execFile);

type Change = { job: number; pr?: number; files: string[]; title: string };

// The marked changes in the checkout at `repo` (main, as deployed), then the open pull requests that touch the
// foundation's paths, each with its job's title from HQ's database.
export async function coming(repo: string, db: DatabaseSync) {
  const titleOf = (job: number) => {
    const row = db.prepare('select title from jobs where id = ?').get(job) as { title: string } | undefined;
    return firstLine(row?.title ?? '');
  };
  const marked = [...(await markedFiles(repo))]
    .sort(([a], [b]) => a - b)
    .map(([job, files]): Change => ({ job, files: [...files].sort(), title: titleOf(job) }));
  const open = openPulls(db).map(p => ({ ...p, title: titleOf(p.job) }));
  return { marked, open };
}

// The report's section: one line per change, `#job · files · title` (an open pull request's number after its job)
export function section({ marked, open }: { marked: Change[]; open: Change[] }) {
  const line = (c: Change) =>
    [`#${c.job}`, ...(c.pr ? [`PR #${c.pr}`] : []), c.files.join(', '), c.title].filter(Boolean).join(' · ');
  return [
    `marked on main, not carried back yet: ${marked.length}`,
    ...marked.map(line),
    '',
    `in open pull requests: ${open.length}`,
    ...open.map(line),
  ].join('\n');
}

// job -> the files whose markers name it
async function markedFiles(repo: string) {
  const byJob = new Map<number, Set<string>>();
  for (const file of await filesSaying(repo, 'company:')) {
    const text = await readFile(`${repo}/${file}`, 'utf8');
    for (const [, jobs, kept] of text.matchAll(MARKER))
      if (!kept)
        for (const [, job] of jobs.matchAll(/#([0-9]+)/g))
          byJob.set(Number(job), (byJob.get(Number(job)) ?? new Set()).add(file));
  }
  return byJob;
}

// The checkout's tracked text files in the foundation's paths with `words` in them
async function filesSaying(repo: string, words: string) {
  // safe.directory: the server's checkout is root's, mounted read-only for the coordinator's own user
  const args = ['-c', `safe.directory=${repo}`, '-C', repo, 'grep', '-I', '-l', '-z', '-F', words, '--', ...FOUNDATION];
  try {
    return (await run('git', args, { maxBuffer: 16 * 2 ** 20, timeout: 30_000 })).stdout.split('\0').filter(Boolean);
  } catch (err) {
    // git grep exits 1 when no file has them
    if ((err as { code?: number }).code === 1) return [];
    throw err;
  }
}

// A pull request in review, stuck or with the board (jobs.ts OPEN_PRS), from a job's branch, with its foundation files
function openPulls(db: DatabaseSync) {
  const rows = db
    .prepare(
      "select number, branch, files from prs where status in ('open', 'stuck', 'board') and branch like 'job/%' order by number",
    )
    .all() as { number: number; branch: string; files: string }[];
  return rows
    .map(r => ({
      job: Number(r.branch.slice('job/'.length)),
      pr: r.number,
      files: (JSON.parse(r.files) as string[]).filter(inFoundation).sort(),
    }))
    .filter(p => p.files.length && Number.isInteger(p.job));
}

export const inFoundation = (file: string) => FOUNDATION.some(p => file === p || file.startsWith(`${p}/`));
const firstLine = (title: string) => {
  const line = title.split('\n')[0].trim();
  return line.length > TITLE_CHARACTERS ? `${line.slice(0, TITLE_CHARACTERS - 1)}…` : line;
};
