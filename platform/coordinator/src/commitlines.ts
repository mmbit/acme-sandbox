// HQ's lines changed, each day's: the code and docs our agents' commits on main changed (countedlines.ts), each commit
// once, on the day its author made it, and never again through a merge (git log --no-merges), so a staged merge or a
// branch merged twice adds nothing. Read from the server's checkout: all of main's history the first time (and again
// when the rule, our agents' email domain or the generated marks change), so the past reads the same way, then each
// minute the commits since.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  CODE_OR_DOCS,
  MARKS,
  countedLines,
  markedPaths,
  numstatRow,
  type FileLines,
} from '../../worker/src/countedlines.ts';
import { infra } from './company.ts';
import { db, remember, setting } from './db.ts';

const execFileAsync = promisify(execFile);

db.exec(
  'create table if not exists commit_lines (sha text primary key, at text not null, agent text not null, lines integer not null)',
);
// work.ts reads a fortnight's commits, never all of main's
db.exec('create index if not exists commit_lines_at on commit_lines (at, lines)');
// what's counted so far: main's commit, and what it was counted by (countBasis: a change counts history again)
const COUNTED_KEY = 'commitLines.head',
  RULE = '1';
const ATTR_BATCH = 500; // paths per check-attr

let reading: Promise<void> | null = null;
export const refresh = () =>
  (reading ??= read()
    .catch(err => console.error('Could not count the lines on main:', (err as Error).message.split('\n')[0]))
    .finally(() => (reading = null)));

async function read() {
  const repo = process.env.REPO_DIR!;
  if (!existsSync(`${repo}/.git`)) return; // (a checkout without git, as a test company's: nothing to count)
  const git = (...args: string[]) => readGitOutput(repo, ...args);
  const head = (await git('rev-parse', 'HEAD')).trim();
  const domain = String(infra().AGENT_EMAIL_DOMAIN ?? '').toLowerCase();
  const basis = await countBasis(repo, git, domain);
  const [counted, countedBasis] = (setting(COUNTED_KEY) ?? '').split(' ');
  if (counted === head && countedBasis === basis) return;
  const isAncestor =
    !!counted &&
    (await git('merge-base', '--is-ancestor', counted, head).then(
      () => true,
      () => false,
    ));
  const recount = countedBasis !== basis || !isAncestor;
  const since = recount ? head : `${counted}..${head}`;
  const commits = (await git('log', '--no-merges', '--numstat', '--format=%x01%H %aI %ae', since))
    .split('\x01')
    .slice(1)
    .map(chunk => {
      const [header, ...rows] = chunk.split('\n');
      const [sha, at, email] = header.split(' ');
      const files = rows.map(numstatRow).filter((f): f is FileLines => !!f);
      return { sha, at, email: email.toLowerCase(), files };
    })
    .filter(c => !domain || c.email.endsWith(`@${domain}`));
  const paths = [...new Set(commits.flatMap(c => c.files.map(f => f.path)))].filter(path => CODE_OR_DOCS.test(path));
  const marked = new Set<string>();
  for (let i = 0; i < paths.length; i += ATTR_BATCH)
    for (const path of markedPaths(await git('check-attr', '-z', ...MARKS, '--', ...paths.slice(i, i + ATTR_BATCH))))
      marked.add(path);
  const insert = db.prepare('insert or replace into commit_lines (sha, at, agent, lines) values (?, ?, ?, ?)');
  db.exec('begin');
  try {
    if (recount) db.exec('delete from commit_lines');
    for (const c of commits)
      insert.run(c.sha, new Date(c.at).toISOString(), c.email.split('@')[0], countedLines(c.files, marked).lines);
    remember(COUNTED_KEY, `${head} ${basis}`);
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

// What a commit's count depends on besides the commit: the RULE, whose commits are ours (the agents' email domain) and
// which files are marked generated or vendored (the checkout and the user's attributes file).
async function countBasis(repo: string, git: (...args: string[]) => Promise<string>, domain: string) {
  const hash = createHash('sha256').update(`${RULE}\0${domain}\0`);
  const attributeFiles = (await git('ls-files', '-z', '--', ':(glob)**/.gitattributes')).split('\0').filter(Boolean);
  const defaultAttributesFile = `${process.env.XDG_CONFIG_HOME || `${homedir()}/.config`}/git/attributes`;
  const configuredAttributesFile = (
    await git('config', '--null', '--path', '--default', defaultAttributesFile, '--get', 'core.attributesFile')
  ).split('\0')[0];
  if (configuredAttributesFile) attributeFiles.push(configuredAttributesFile);
  for (const path of [...attributeFiles, '.git/info/attributes'])
    if (existsSync(resolve(repo, path)))
      hash
        .update(`${path}\0`)
        .update(readFileSync(resolve(repo, path)))
        .update('\0');
  return hash.digest('hex').slice(0, 16);
}

// safe.directory: the checkout is root's on the server, mounted read-only (as owed.ts reads it)
async function readGitOutput(repo: string, ...args: string[]) {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', `safe.directory=${repo}`, '-c', 'core.quotePath=false', '-C', repo, ...args],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  return stdout;
}

// Each commit's lines since a moment, with its time, for work.ts to put on the company's days
export const linesSince = (since: string) =>
  db.prepare('select at, lines from commit_lines where at >= ?').all(since) as { at: string; lines: number }[];
export const firstCounted = () => (db.prepare('select min(at) at from commit_lines').get() as { at: string | null }).at;
