// The worker's git flow. Only root (the worker process) holds GITHUB_TOKEN, and it only runs git in a bare mirror
// that agents can't write. Each job gets its own clone of the mirror, owned by the slot that runs it (slots.ts):
// nothing git writes is shared between jobs. Agents hand their commits over as a bundle; root pushes them to
// GitHub as job/<n>, and a thread task's own profile lines as profile/<n>, and
// nothing else.
import { pushProcess } from './pushprocess.ts';
import { assertOwned, ownershipSignal } from './ownership.ts';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { JOB_BRANCH, PROFILE_BRANCH, SHA, redact } from './safety.ts';
import { MARKS, countedLines, markedPaths, numstatRow, type FileLines } from './countedlines.ts';

const execFileAsync = promisify(execFile);

export type Agent = { uid?: number; gid?: number; env: Record<string, string> };

// The token lives only in the root worker's environment; no URL or config file ever holds it.
const HELPER = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f';
const stat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

// A workflow filter pattern (GitHub's syntax: * stops at /, ** doesn't, ? and + as in regexes); one we can't read
// matches everything, so it errs towards refusing.
const glob = (p: string) => {
  try {
    return new RegExp(
      `^(?:${p
        .replace(/[.^${}()|\\]/g, '\\$&')
        .replace(/\*\*/g, '\0')
        .replace(/\*/g, '[^/]*')
        .replace(/\0/g, '.*')})$`,
    );
  } catch {
    return /(?:)/;
  }
};
// Whether a workflow runs when `branch` is pushed (created or updated): an on: push or create that isn't limited
// away from the branch. Reads the YAML subset workflows use; what it can't place counts as running.
export function setsOff(workflow: string, branch: string) {
  const on = (workflow + '\n').match(/^(['"]?)on\1:[ \t]*([^\n]*)\n((?:(?:[ \t]+\S.*|[ \t]*(?:#.*)?)\n)*)/m);
  if (!on) return false;
  const inline = on[2].replace(/(^|\s)#.*/, '').trim();
  if (inline) return /\b(push|create)\b/.test(inline); // on: push, on: [push, ...], on: {push: ...}
  const ind = on[3].match(/^([ \t]+)\S/m)?.[1] ?? '  ';
  const event = (e: string) =>
    on[3].match(new RegExp(`^${ind}(['"]?)${e}\\1:([^\\n]*)\\n((?:(?:${ind}[ \\t]+\\S.*|[ \\t]*(?:#.*)?)\\n)*)`, 'm'));
  const push = event('push');
  return !!event('create') || (!!push && runsOn(push[2] + '\n' + push[3], branch));
}
// Whether a push trigger's filters let a push to `branch` through. GitHub's rules: branch filters decide; tag filters
// alone mean no branch pushes; no filters, every branch. Negated patterns are ignored, so they only ever add refusals.
function runsOn(filters: string, branch: string) {
  const list = (k: string) =>
    filters
      .match(
        new RegExp(
          `(?:^|[\\s{,])${k}:[ \\t]*(?:#[^\\n]*)?` +
            `(\\[(?:"[^"]*"|'[^']*'|[^\\]"'])*\\]|\\n(?:[ \\t]*(?:-.*|#.*)?\\n)*|[^\\n,}]*)`,
        ),
      )?.[1] // [a, "b"], a block of - a, or a
      .replace(/(^|\s)#.*$/gm, '')
      .match(/"[^"]*"|'[^']*'|[^\s,[\]"'-][^\s,\]]*/g)
      ?.map(p => p.replace(/^['"]|['"]$/g, '')) ?? [];
  const hits = (ps: string[]) => ps.some(p => !p.startsWith('!') && glob(p).test(branch));
  const has = (k: string) => new RegExp(`(?:^|[\\s{,])${k}:`).test(filters);
  if (has('branches')) return hits(list('branches'));
  if (has('branches-ignore')) return !hits(list('branches-ignore'));
  return !has('tags') && !has('tags-ignore');
}

// The Markdown files on the Library's shelves (the coordinator's library.ts library() and company.ts gazette()): the
// handbook, playbooks and departments, the knowledge base's notes by topic and the shared craft library (no READMEs),
// and the newsletter's posts.
export const SHELVES =
  /^(company\/(playbooks\/|departments\/)?|knowledge\/notes\/[^/]+\/|shared\/craft\/)(?!README\.md$)[^/]+\.md$|^knowledge\/posts\/[^/]+\/index\.md$/;
// The company's settings: its plain config files at the top of company/ (infra.env, schedule.yaml, models.yaml, org.yaml…),
// as review.ts's SETTINGS has them
export const SETTINGS = /^company\/[^/]+\.(env|ya?ml|json)$/;
// The most lines a consolidator's touch-up may change (touchUp); its briefing tells it (worker.ts reviewBriefing).
export const TOUCHUP_LINES = 200;

// The lines a job's branch changes against base, committed or not and new files whole, as the agent's uid: staged
// into a throwaway index (the agent's own index stays as it was), so agents that commit only at the end, write through
// commands or work in a team count too. .hq/ and node_modules/ stay out (the clone's info/exclude); only code and docs
// count (countedlines.ts).
export async function branchLines(agent: Agent, dir: string, base: string) {
  const env = { ...agent.env, GIT_INDEX_FILE: `${dir}/.git/hq-lines` };
  const git = async (...args: string[]) =>
    (
      await execFileAsync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env,
        uid: agent.uid,
        gid: agent.gid,
        maxBuffer: 16 << 20,
      })
    ).stdout.trim();
  // A merge of main not yet committed counts as made, or main's own files would count as the branch's.
  //
  const merging = await git('rev-parse', '-q', '--verify', 'MERGE_HEAD').catch(() => '');
  const from = await git('merge-base', `origin/${base}`, 'HEAD', ...(merging ? [merging] : []));
  await git('read-tree', 'HEAD');
  await git('add', '-A');
  const files = (await git('-c', 'core.quotePath=false', 'diff', '--cached', '--numstat', from))
    .split('\n')
    .map(numstatRow)
    .filter((f): f is FileLines => !!f);
  const marked = files.length
    ? markedPaths(await git('check-attr', '-z', ...MARKS, '--', ...files.map(f => f.path)))
    : new Set<string>();
  const { add, del } = countedLines(files, marked);
  return { add, del };
}

// Git a job's clone and home can't change, for the worker's own git as the job's user after its session and a push's
// tests: no hook or fsmonitor the session left in the clone runs then (none starts a process that outlives it), no git
// config or attributes of the home's (~/.gitconfig, ~/.config/git/attributes: a working-tree-encoding there re-encodes a
// checkout) apply, and no replacement ref or graft stands in for a commit. The system's does: the image's own, which no
// job can write, and the mirror's safe.directory (the Dockerfile), which a fetch from it needs, since git leaves the
// GIT_CONFIG_* pairs below out of the mirror's side of a local fetch. As the environment of
// forAgent's git and of a push's checks (worker.ts checkSpec); the clone's own config is written anew first (forAgent's
// settle).
const PINNED: [string, string][] = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['core.attributesFile', '/dev/null'], // (the committed .gitattributes still apply)
];
export const pinnedGitEnv = Object.fromEntries([
  ['GIT_CONFIG_GLOBAL', '/dev/null'],
  ['GIT_NO_REPLACE_OBJECTS', '1'],
  ['GIT_GRAFT_FILE', '/dev/null/none'], // (a path that can't be a file: /dev/null itself reads as a graft file)
  ['GIT_CONFIG_COUNT', String(PINNED.length)],
  ...PINNED.flatMap(([key, value], i) => [
    [`GIT_CONFIG_KEY_${i}`, key],
    [`GIT_CONFIG_VALUE_${i}`, value],
  ]),
]);

// Runs a command as an agent's uid with its env (its hooks may run; they get nothing that uid doesn't have).
export const runAs = (agent: Agent, cmd: string, args: string[], input?: string) => {
  assertOwned();
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    env: agent.env,
    uid: agent.uid,
    gid: agent.gid,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

// Whether a failed push (or the mirror's fetch) was lost on the way to GitHub
// rather than refused by it.
// A refused ref ([rejected], [remote rejected]: not a fast-forward, a workflow file without the scope, a lease that no
// longer holds) means GitHub answered. A push our timeout killed, a dropped connection, or a 5xx can go again.
function lostOnTheWay(e: { killed?: boolean; stderr?: unknown }) {
  const said = String(e.stderr ?? '');
  if (/\[(remote )?rejected\]|HTTP 4\d\d|returned error: 4\d\d|remote unpack failed/i.test(said)) return false;
  return (
    !!e.killed ||
    /RPC failed|remote end hung up|unexpected disconnect|early EOF|Could not resolve host|Failed to connect|Connection (timed out|reset|refused)|Operation timed out|returned error: 5\d\d/i.test(
      said,
    )
  );
}
// A push that never reached GitHub in all its tries (a refusal is a plain Error): the worker's own snag, so its job goes
// back in the queue (worker.ts land).
export class PushUnreachedError extends Error {}
// The mirror's fetch lost on the way to GitHub (lostOnTheWay), at a job's start: the same snag.
export class FetchUnreachedError extends Error {}
// The pauses before each try again, growing: a few minutes in all
const PUSH_PAUSES_MS = [15_000, 60_000, 120_000];
// The most a push sends as one request: it must exceed our largest push, and GitHub refuses a file over 100 MB anyway.
const PUSH_BUFFER_BYTES = 128 << 20;

export type Merged = { sha?: string; conflicts?: string[]; moved?: boolean; why?: string };
// The coordinator's ask to merge main into a passed branch, answered. It waits
// `msLeft` from `askedAt` (epoch ms); `merge` gets the moment its pushes stop, REPORT_MS before that, so the answer
// still reaches it. An ask without a finite budget is answered without a merge: nothing would bound its pushes.
export async function answerMainMerge(
  askedAt: number,
  msLeft: unknown,
  merge: (by: number) => Promise<Merged>,
): Promise<Merged> {
  if (typeof msLeft !== 'number' || !Number.isFinite(msLeft))
    return { why: `the coordinator gave no time to merge in (${String(msLeft)})` };
  try {
    return await merge(askedAt + msLeft - REPORT_MS);
  } catch (err) {
    return { why: redact(String(err)).slice(0, 300) };
  }
}
export const REPORT_MS = 15_000;

// `clones`: the folders of the job clones that read the mirror's objects (clone below), so its gc keeps what they read.
// `pushPausesMs`: PUSH_PAUSES_MS unless a test says otherwise.
export function gitFlow(o: {
  mirror: string;
  remote: string;
  base: string;
  clones: () => string[];
  log?: (...a: unknown[]) => void;
  pushPausesMs?: number[];
}) {
  const { mirror, base } = o;
  // Root side: always --git-dir to the mirror, so no config or hook from an agent's repo can apply.
  const inMirror = (args: string[]) => ['--git-dir', mirror, '-c', 'core.hooksPath=/dev/null', ...args];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const root = (...args: string[]) =>
    execFileSync('git', inMirror(args), { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  function ensureMirror() {
    const me = process.getuid!();
    const parent = stat(dirname(mirror));
    // If agents could rename the mirror, they could swap in a repo whose config root would obey.
    if (!parent?.isDirectory() || parent.uid !== me || parent.mode & 0o022)
      throw new Error(`${dirname(mirror)} must be ours alone`);
    const st = stat(mirror);
    if (st && (!st.isDirectory() || st.uid !== me || st.mode & 0o022)) {
      const aside = `${mirror}.untrusted-${Date.now()}`;
      renameSync(mirror, aside);
      o.log?.(`${mirror} wasn't ours alone; moved it to ${aside}`);
    }
    if (!stat(mirror)) execFileSync('git', ['init', '-q', '--bare', mirror]);
    // (uploadpack.hideRefs: clones never see the kept tips, keepCommits below)
    for (const [k, v] of [
      ['remote.origin.url', o.remote],
      ['remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
      ['transfer.fsckObjects', 'true'],
      ['credential.helper', HELPER],
      ['maintenance.auto', 'false'],
      ['gc.autoDetach', 'false'],
      ['uploadpack.hideRefs', 'refs/kept/'],
      // A push to GitHub as one HTTP/1.1 request with its length: git's default streams it over HTTP/2 in pieces, which
      // dropped mid-send ("RPC failed; curl 55") on large pushes. postBuffer is allocated up front: room for any push we make.
      ['http.version', 'HTTP/1.1'],
      ['http.postBuffer', String(PUSH_BUFFER_BYTES)],
    ])
      root('config', '--replace-all', k, v);
    root('symbolic-ref', 'HEAD', `refs/heads/${base}`); // so a fresh clone checks out the base branch
    // this runs at the worker's start, before any git in the mirror, so a lock,
    // gc.pid or tmp_ file here is a dead git's: a gc killed with the container leaves them, and git won't gc past them.
    const dead = readdirSync(mirror, { recursive: true, encoding: 'utf8' }).filter(
      f => /(^|\/)(gc\.pid|[^/]+\.lock)$|^objects\/(.+\/)?tmp_[^/]+$/.test(f) && stat(join(mirror, f))?.isFile(),
    );
    for (const f of dead) rmSync(join(mirror, f));
    if (dead.length) o.log?.(`mirror: removed what a killed git left: ${dead.join(', ')}`);
  }

  // the mirror's gc runs only here, in the foreground, when the worker says (between
  // fetches, never while a job clones): one a fetch started on its own, detached, would die with the container.
  // --auto: only once packs or loose objects pile up past git's limits.
  // First it lets go of the kept tips no clone can read any more (keepCommits below).
  async function gcMirror() {
    releaseExpiredKeptTips();
    await execFileAsync('git', inMirror(['gc', '--auto', '--quiet']), { env });
  }

  const fetchMirror = () => {
    const releaseKeptTips = keepTipsDuringFetch();
    let fetchError: unknown;
    try {
      root('fetch', '-q', '--prune', 'origin');
    } catch (err) {
      fetchError = lostOnTheWay(err as { stderr?: unknown })
        ? new FetchUnreachedError((err as Error).message, { cause: err })
        : err;
    }
    releaseKeptTips(fetchError);
  };
  // The same in the background, given up after a minute: the worker carries on meanwhile, and a stalled GitHub can't hang it
  const refreshMirror = () =>
    new Promise<void>((ok, fail) => {
      const releaseKeptTips = keepTipsDuringFetch();
      execFile('git', inMirror(['fetch', '-q', '--prune', 'origin']), { env, timeout: 60_000 }, fetchError => {
        try {
          releaseKeptTips(fetchError);
          ok();
        } catch (err) {
          fail(err);
        }
      });
    });

  // Keeps every branch tip before a fetch: git fetch --prune deletes a gone branch before it transfers anything, so a
  // worker killed mid-fetch still leaves the tips kept. The function it returns, called once the fetch is done (failed
  // or not), lets go of the tips their branch still reaches, then throws the fetch's own error if it had one.
  function keepTipsDuringFetch() {
    const fetchStartMs = Date.now();
    const tipsBefore = branchTips();
    keepCommits(
      fetchStartMs,
      tipsBefore.map(tip => tip.sha),
    );
    return function releaseKeptTips(fetchError: unknown) {
      try {
        const shaAfter = new Map(branchTips().map(tip => [tip.ref, tip.sha]));
        const stillReached = (tip: { sha: string; ref: string }) => {
          const now = shaAfter.get(tip.ref);
          return (
            now === tip.sha ||
            (now !== undefined &&
              spawnSync('git', inMirror(['merge-base', '--is-ancestor', tip.sha, now])).status === 0)
          );
        };
        const lostShas = new Set(tipsBefore.filter(tip => !stillReached(tip)).map(tip => tip.sha));
        const reachedShas = new Set(tipsBefore.map(tip => tip.sha).filter(sha => !lostShas.has(sha)));
        updateRefs([...reachedShas].map(sha => `delete refs/kept/${fetchStartMs}/${sha} ${sha}`));
      } catch (keepError) {
        if (!fetchError) throw keepError;
        const message = 'The mirror fetch failed, and letting go of the tips it kept failed too';
        throw new AggregateError([fetchError, keepError], message, { cause: keepError });
      }
      if (fetchError) throw fetchError;
    };
  }

  function branchTips() {
    const lines = root('for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/').split('\n').filter(Boolean);
    return lines.map(line => {
      const [sha, ref] = line.split(' ');
      return { sha, ref };
    });
  }

  // A clone's refs don't keep the objects it reads from the mirror alive there, and gc prunes an unreachable object
  // by its age, not by how long ago its branch went. So every tip a fetch drops or moves past stays on a ref,
  // refs/kept/<ms>/<sha> (ms: when the fetch started; hidden from clones), as long as a clone made before then is
  // left. A pinned review sha is kept the same way from its clone on. A clone whose folder's birth time can't be
  // read (0) holds everything.
  function keepCommits(sinceMs: number, shas: Iterable<string>) {
    updateRefs([...new Set(shas)].map(sha => `update refs/kept/${sinceMs}/${sha} ${sha}`));
  }

  // Lets go of the kept tips no clone can read any more: those kept since before the oldest clone was made.
  function releaseExpiredKeptTips() {
    const cloneBirthsMs = o.clones().map(dir => stat(dir)?.birthtimeMs ?? Infinity);
    const oldestCloneBirthMs = Math.floor(Math.min(...cloneBirthsMs));
    const keptRefs = root('for-each-ref', '--format=%(refname)', 'refs/kept/').split('\n').filter(Boolean);
    const expiredRefs = keptRefs.filter(ref => Number(ref.split('/')[2]) < oldestCloneBirthMs);
    updateRefs(expiredRefs.map(ref => `delete ${ref}`));
  }

  // One update-ref transaction in the mirror, a command per line (git update-ref --stdin)
  function updateRefs(commands: string[]) {
    if (!commands.length) return;
    const input = commands.map(command => `${command}\n`).join('');
    execFileSync('git', inMirror(['update-ref', '--stdin']), { env, input, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  // Workflows run with the Actions secrets (the Hetzner key, the server's GitHub key). One that a push to a job branch
  // sets off runs before any review: server.yml would provision the server from it. So a job branch that would set
  // one off isn't pushed (H3). GitHub runs a push's workflows as they are in the pushed commit, so that's where the
  // check reads them (our token can't change workflow files, so they're whatever the branch last took from base).
  // What the job changes doesn't matter: GitHub matches `paths` against its own range (before..after, the deepest new
  // commit's parent for a new branch, and no paths at all past 1,000 commits), not ours. So any push or create
  // trigger that isn't limited away from this branch refuses the push; for an old branch the fix is to merge base.
  const triggers = (sha: string, branch: string) =>
    root('ls-tree', '--name-only', sha, '.github/workflows/')
      .split('\n')
      .filter(wf => wf && setsOff(root('show', `${sha}:${wf}`), branch));

  // GitHub merges a pull request without .gitattributes' merge drivers, so it refuses one that git merges cleanly (the
  // coordinator's review.ts mergeMain). Root merges base into `head` here, the branch's head as the panel passed it, and
  // pushes the merge to the branch only if git needed no hand in it and the branch is still at `head`. The attributes are
  // base's: a branch's own could union-merge code. (In a bare repository git 2.39 reads no .gitattributes from a commit.)
  // Nothing is pushed from `by` on (epoch ms), when the coordinator no longer waits for it and the author may take it.
  // Returns the merge, or the files git couldn't merge, or that the branch moved, or why it didn't try. A profile branch
  // (profile/<n>, its one commit on main: pushProfile) takes main differently: its commit again on main's head, which root
  // checks as it checks a push of it.
  async function mergeBase(
    branch: string,
    head: string,
    author: { name: string; email: string },
    by = Infinity,
  ): Promise<Merged> {
    const profile = PROFILE_BRANCH.test(branch);
    if (!JOB_BRANCH.test(branch) && !profile)
      throw new Error(`Refused to merge into ${branch}: the worker only pushes job/<n> and profile/<n> branches`);
    if (!SHA.test(head)) throw new Error(`Not a commit id: ${head}`);
    if (Date.now() >= by) return { why: 'its time was up before the worker reached it' };
    if (root('rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) !== head)
      return { moved: true, why: `${branch} isn't at ${head.slice(0, 7)} any more` };
    const main = root('rev-parse', '--verify', `refs/heads/${base}^{commit}`);
    if (spawnSync('git', inMirror(['merge-base', '--is-ancestor', main, head])).status === 0) return { sha: head }; // has it already
    const tmp = mkdtempSync(join(tmpdir(), 'attributes-')); // 0700, root's alone
    try {
      const attributes = join(tmp, 'gitattributes');
      let text = '';
      try {
        text = root('cat-file', 'blob', `${main}:.gitattributes`);
      } catch {
        /* base has none */
      }
      writeFileSync(attributes, text);
      const r = spawnSync(
        'git',
        inMirror([
          '-c',
          `core.attributesFile=${attributes}`,
          'merge-tree',
          '--write-tree',
          '--name-only',
          '--no-messages',
          '-z',
          main,
          head,
        ]),
        { encoding: 'utf8', env, maxBuffer: 1 << 26 },
      );
      // -z: the tree, then each file that conflicts (exit 1)
      const [tree, ...conflicts] = r.stdout.split('\0').filter(Boolean);
      if (r.status === 1) return { conflicts: [...new Set(conflicts)] };
      if (r.status !== 0)
        return {
          why: `git merge-tree failed: ${redact(String(r.stderr ?? r.error))
            .trim()
            .slice(-300)}`,
        };
      const who = {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      };
      let sha: string;
      if (profile) {
        const [, parent, other] = root('rev-list', '--parents', '-n', '1', head).split(' ');
        if (!parent || other || spawnSync('git', inMirror(['merge-base', '--is-ancestor', parent, main])).status !== 0)
          return { why: `${branch} isn't one commit on ${base}` };
        const message = root('log', '-1', '--format=%B', head);
        sha = execFileSync('git', inMirror(['commit-tree', tree, '-p', main, '-m', message]), {
          encoding: 'utf8',
          env: { ...env, ...who },
        }).trim();
        try {
          checkProfile(sha, new Set(changes(parent, head).map(e => e.path)));
        } catch (e: any) {
          return { why: e.message };
        }
      } else
        sha = execFileSync(
          'git',
          inMirror(['commit-tree', tree, '-p', head, '-p', main, '-m', `Merge ${base} into ${branch}`]),
          { encoding: 'utf8', env: { ...env, ...who } },
        ).trim();
      const runs = triggers(sha, branch);
      if (runs.length)
        return { why: `its copy of ${runs.join(', ')} would run on the push, with the company's secrets` };
      try {
        await pushToGitHub(
          branch,
          `${sha}:refs/heads/${branch}`,
          [`--force-with-lease=refs/heads/${branch}:${head}`],
          by,
        );
      } catch (e: any) {
        return { why: e.message };
      }
      root('update-ref', `refs/heads/${branch}`, sha);
      return { sha };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  // Bound each attempt so a stalled connection can be retried
  const PUSH_MS = 180_000;

  // Every push to GitHub. One lost on the way there goes again after each pause
  // that ends before `by` (epoch ms). The deadline also cuts each try short. A refusal or the last failed try throws why,
  // redacted.
  async function pushToGitHub(branch: string, refspec: string, options: string[] = [], by = Infinity) {
    const pauses = o.pushPausesMs ?? PUSH_PAUSES_MS;
    for (const [i, pause] of [...pauses, undefined].entries()) {
      assertOwned();
      // (a timeout of 0 would be none)
      const timeout = Math.max(1, Math.min(PUSH_MS, by - Date.now()));
      try {
        await pushProcess(inMirror(['push', '-q', ...options, 'origin', refspec]), env, timeout, ownershipSignal());
        assertOwned();
        return;
      } catch (e: any) {
        assertOwned();
        const why = redact(String(e.stderr || e.message))
          .trim()
          .slice(-300);
        if (!lostOnTheWay(e)) throw new Error(`GitHub refused the push to ${branch}: ${why}`, { cause: e });
        if (pause === undefined || Date.now() + pause >= by)
          throw new PushUnreachedError(`The push to ${branch} didn't reach GitHub in ${i + 1} tries: ${why}`, {
            cause: e,
          });
        o.log?.(
          `push to ${branch} didn't reach GitHub, trying again in ${Math.round(pause / 1000)} s: ${why.replace(/\s*\n\s*/g, ' / ')}`,
        );
        await sleep(pause, undefined, { signal: ownershipSignal() });
      }
    }
  }

  // A job's side of the flow, as the uid of the slot that runs it.
  function forAgent(agent: Agent) {
    const pinned = { ...agent, env: { ...agent.env, ...pinnedGitEnv } };
    const ag = (dir: string, ...args: string[]) => runAs(pinned, 'git', ['-C', dir, ...args]).trim();

    // The job's own clone of the mirror, in the (empty) folder root made for its slot. Work jobs get their branch
    // (from origin if it exists, else from base); reviewers read exactly the commit the panel was asked about (M4),
    // the branch tip only if the job has no sha.
    // `as`: the clone's own identity, for commits made in it without an author of their own
    function clone(
      dir: string,
      branch: string,
      review?: { sha?: string | null },
      as = { name: 'Agents', email: 'agents@agents.invalid' },
    ) {
      if (review?.sha && !SHA.test(review.sha)) throw new Error(`Not a commit id: ${review.sha}`);
      // --reference: the clone reads its history from the mirror's objects (an alternates entry). The mirror isn't
      // writable by others (ensureMirror), so what a job writes lands only in its own objects; the mirror keeps what its
      // clones read (keepCommits above). A mirror moved aside as untrusted takes those objects with it: the clones made
      // before then can't be used.
      const pinnedSha = review?.sha;
      const pinnedInMirror =
        !!pinnedSha && spawnSync('git', inMirror(['cat-file', '-e', `${pinnedSha}^{commit}`])).status === 0;
      if (pinnedInMirror) keepCommits(Date.now(), [pinnedSha]);
      runAs(agent, 'git', ['clone', '-q', '--no-checkout', '--reference', mirror, `file://${mirror}`, dir]);
      ag(dir, 'config', 'user.name', as.name);
      ag(dir, 'config', 'user.email', as.email);
      runAs(agent, 'sh', ['-c', 'printf ".hq/\\nnode_modules/\\n" >> "$1"', 'sh', `${dir}/.git/info/exclude`]);
      // A pinned sha the branch has since dropped (amended, rebased, force-pushed) is still in the mirror, on no ref
      if (review?.sha) ag(dir, 'fetch', '-q', 'origin', review.sha);
      if (review) ag(dir, 'checkout', '-q', '--detach', review.sha || `origin/${branch}`);
      else {
        const remote = ag(dir, 'ls-remote', '--heads', 'origin', branch) !== '';
        ag(dir, 'checkout', '-q', '-B', branch, remote ? `origin/${branch}` : `origin/${base}`);
      }
    }

    // After the session, before the worker's own git in its clone (the commit and push, a touch-up): the clone's config
    // written anew, with its identity and origin alone, so nothing the session set there (a filter or diff driver, an
    // include) runs in that git, and no commondir it wrote lends the clone another repository's config.
    function settle(dir: string, as: { name: string; email: string }) {
      const config = [
        '[core]',
        '\trepositoryformatversion = 0',
        '\tbare = false',
        '[remote "origin"]',
        `\turl = file://${mirror}`,
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '[user]',
        `\tname = ${as.name}`,
        `\temail = ${as.email}`,
      ];
      runAs(agent, 'rm', ['-f', '--', `${dir}/.git/commondir`]);
      runAs(
        agent,
        'sh',
        ['-c', 'umask 077 && cat > "$1.hq" && mv -f "$1.hq" "$1"', 'sh', `${dir}/.git/config`],
        `${config.join('\n')}\n`,
      );
    }

    // A clone of the mirror at `sha` in the empty folder `dir`, for a push's tests (worker.ts testsCheckout): made
    // after the session, so nothing of its clone or home is in it.
    function checkout(dir: string, sha: string) {
      runAs(pinned, 'git', ['clone', '-q', '--no-checkout', '--reference', mirror, `file://${mirror}`, dir]);
      ag(dir, 'checkout', '-q', '--detach', sha);
    }

    // The agent side writes a bundle of the job's commits into a file only root can open; root fetches it into the
    // mirror and pushes it as job/<n>. Returns the pushed head and the files it changes against base, and `pushedSince`:
    // the branch's head before this push and which of the pull request's files the push changed since it. The review
    // routes a fix round's fixes by that list.
    async function push(dir: string, branch: string) {
      if (!JOB_BRANCH.test(branch))
        throw new Error(`Refused to push ${branch}: the worker only pushes job/<n> branches`);
      const sha = bundleInto(dir, `refs/outgoing/${branch}`, `origin/${base}`, "the job's commits");
      // Both sides of a rename: a file moved into a profile or a note would otherwise be listed as only that, and skip
      // the panel. Submodules (links) aren't what a reader of their path expects: they never take the profile or
      // documentation shortcuts. -z: paths come unquoted (a quoted "platform/… path would miss HIGH_RISK).
      const entries = changes(`refs/heads/${base}...${sha}`);
      const files = entries.map(e => e.path);
      // A symlink is never pushed: what serves the repo's files follows one wherever it points (Caddy, from a product's
      // folder into its own TLS keys), and nothing in the repo needs one.
      const symlinks = entries.filter(e => e.mode.split(' ')[1] === '120000').map(e => e.path);
      if (symlinks.length)
        throw new Error(
          `Refused to push ${branch}: ${symlinks.slice(0, 10).join(', ')}${symlinks.length > 10 ? ` and ${symlinks.length - 10} more` : ''} ` +
            `${symlinks.length === 1 ? 'is a symlink' : 'are symlinks'}, and the repo takes none. Commit a copy of the file in its place.`,
        );
      const links = entries.filter(e => /^:\d+ 160000 /.test(e.mode)).map(e => e.path);
      const { frontmatter, knowledge } = shelved(entries, sha);
      const pushedSince = changedSince(branch, sha, files);
      const lines = changedLines(sha);
      const settings = configs(entries);
      const runs = triggers(sha, branch);
      if (runs.length)
        throw new Error(
          `Refused to push ${branch}: its copy of ${runs.join(', ')} runs on pushes to any branch, with the ` +
            `company's secrets, before review. Merge ${base} if it already limits them to ${base}; otherwise leave these to the board.`,
        );
      await pushToGitHub(branch, `${sha}:refs/heads/${branch}`);
      root('update-ref', `refs/heads/${branch}`, sha);
      return { sha, files, links, frontmatter, knowledge, pushedSince, lines, settings };
    }

    // A thread task's own profile and archive lines, as the commit its clone built on `ref` (threads.ts splitProfile, or
    // rebuildProfile for the branch's repair), pushed to profile/<the task's id>. Root checks the commit itself in the
    // mirror: one commit on main's head, changing only `paths`, as plain files. A run of the same task again builds it
    // anew on main as it is then, with the lines the branch holds that main hasn't merged, so the push replaces the
    // branch, only while it's still at `over`, the commit the build stood on ('': while there's no branch). A writer that
    // started from an older one (a run again beside the branch's repair) is refused, rather than undo the other's lines.
    // Returns the commit and its files.
    async function pushProfile(dir: string, branch: string, ref: string, paths: string[], over: string) {
      if (!PROFILE_BRANCH.test(branch))
        throw new Error(`Refused to push ${branch}: profile lines go only on profile/<n> branches`);
      if (over && !SHA.test(over)) throw new Error(`Not a commit id: ${over}`);
      const outgoing = `refs/outgoing/${branch}`;
      try {
        const sha = bundleInto(dir, outgoing, `origin/${base}`, 'the profile lines', ref);
        const files = checkProfile(sha, new Set(paths));
        const runs = triggers(sha, branch);
        if (runs.length)
          throw new Error(
            `Refused to push ${branch}: its copy of ${runs.join(', ')} would run on the push, with the company's secrets`,
          );
        await pushToGitHub(branch, `${sha}:refs/heads/${branch}`, [`--force-with-lease=refs/heads/${branch}:${over}`]);
        root('update-ref', `refs/heads/${branch}`, sha);
        return { sha, files };
      } finally {
        spawnSync('git', inMirror(['update-ref', '-d', outgoing]));
      }
    }

    // A profile branch its repair left with nothing for main (threads.ts rebuildProfile): deleted on GitHub, which closes
    // its pull request, and in the mirror, while it's still at `head`, the publication the repair started from
    // (threads.ts repairFrom).
    async function withdrawProfile(branch: string, head: string) {
      if (!PROFILE_BRANCH.test(branch))
        throw new Error(`Refused to withdraw ${branch}: only profile/<n> branches are withdrawn`);
      if (!SHA.test(head)) throw new Error(`Not a commit id: ${head}`);
      await pushToGitHub(branch, `:refs/heads/${branch}`, [`--force-with-lease=refs/heads/${branch}:${head}`]);
      root('update-ref', '-d', `refs/heads/${branch}`);
    }

    // The lines the pull request adds or alters in each file, on the pushed side as [first, last] (a deletion as the two
    // lines around it): the review tells a finding on them from one on code the change doesn't touch. Content lines
    // start with +, - or a space, so "diff --git" opens a file's header for sure, and its "+++" names the file until the
    // first hunk. A path git still quotes is left out, and the review counts that file as changed throughout.
    function changedLines(sha: string) {
      const diff = [
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-renames',
        '--diff-filter=d', // Removed files have no pushed lines.
        '--no-color',
        '--no-ext-diff',
        '-U0',
        `refs/heads/${base}...${sha}`,
      ];
      const r = spawnSync('git', inMirror(diff), { encoding: 'utf8', env, maxBuffer: 1 << 26 });
      if (r.status !== 0)
        throw new Error(
          `Couldn't read the diff's lines: ${redact(String(r.stderr || r.error))
            .trim()
            .slice(-300)}`,
        );
      const lines: Record<string, [number, number][]> = {};
      let file: string | null = null,
        header = false;
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('diff --git ')) [file, header] = [null, true];
        else if (header && line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : null;
        else if (line.startsWith('@@ ')) {
          header = false;
          const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
          if (!hunk || file === null) continue;
          const first = Number(hunk[1]),
            count = hunk[2] === undefined ? 1 : Number(hunk[2]);
          (lines[file] ??= []).push(count ? [first, first + count - 1] : [first, first + 1]);
        }
      }
      return lines;
    }

    // The consolidator's own safe fixes on the commit its panel reviewed (review.ts, "touch-ups"), as one commit pushed
    // onto the branch. Only edits to `writes`, the files the coordinator let it touch, are taken from the review's clone:
    // anything else the run left there stays behind. Root then checks the commit itself in the mirror, whatever the clone
    // did: one commit on `base`, every change an edit of a plain file in `writes`, at most TOUCHUP_LINES lines. It
    // pushes only while the branch is still at `base`. Returns the commit and its files.
    async function touchUp(
      dir: string,
      branch: string,
      base: string,
      writes: string[],
      commit: { message: string; name: string; email: string },
    ) {
      if (!JOB_BRANCH.test(branch))
        throw new Error(`Refused to push ${branch}: the worker only pushes job/<n> branches`);
      if (!SHA.test(base)) throw new Error(`Not a commit id: ${base}`);
      // no hook or file-system monitor the review's clone may have been given runs here
      const inClone = (...args: string[]) =>
        ag(dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args);
      const allowed = new Set(writes);
      inClone('reset', '-q', base);
      const edited = inClone('diff', '--no-renames', '--diff-filter=M', '--name-only', '-z')
        .split('\0')
        .filter(f => allowed.has(f));
      if (!edited.length) throw new Error('the consolidator changed none of the files it may change');
      inClone('add', '--', ...edited.map(f => `:(literal)${f}`));
      inClone(
        '-c',
        `user.name=${commit.name}`,
        '-c',
        `user.email=${commit.email}`,
        'commit',
        '-q',
        '--no-verify',
        '-m',
        commit.message,
      );
      const ref = `refs/touchups/${branch}`;
      try {
        const sha = bundleInto(dir, ref, base, 'the touch-up');
        const files = checkTouchup(base, sha, allowed);
        if (root('rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) !== base)
          throw new Error(`${branch} isn't at ${base.slice(0, 7)} any more`);
        const runs = triggers(sha, branch);
        if (runs.length)
          throw new Error(`the branch's copy of ${runs.join(', ')} would run on the push, with the company's secrets`);
        await pushToGitHub(branch, `${sha}:refs/heads/${branch}`, [`--force-with-lease=refs/heads/${branch}:${base}`]);
        root('update-ref', `refs/heads/${branch}`, sha);
        return { sha, files };
      } finally {
        spawnSync('git', inMirror(['update-ref', '-d', ref]));
      }
    }

    // The agent side writes a bundle of the clone's `head` (its commits since `since`) into a file only root can open; root
    // fetches it into the mirror as `ref`. Returns the commit.
    function bundleInto(dir: string, ref: string, since: string, what: string, head = 'HEAD') {
      const tmp = mkdtempSync(join(tmpdir(), 'bundle-')); // 0700, root's alone
      try {
        const file = join(tmp, 'job.bundle'),
          fd = openSync(file, 'w', 0o600);
        const r = spawnSync('git', ['-C', dir, 'bundle', 'create', '-q', '-', head, '--not', since], {
          env: pinned.env,
          uid: agent.uid,
          gid: agent.gid,
          stdio: ['ignore', fd, 'pipe'],
          encoding: 'utf8',
        });
        closeSync(fd);
        if (r.status !== 0)
          throw new Error(
            `Couldn't bundle ${what}: ${redact(String(r.stderr ?? r.error))
              .trim()
              .slice(-300)}`,
          );
        root('fetch', '-q', file, `+${head}:${ref}`);
        return root('rev-parse', '--verify', `${ref}^{commit}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    // The pull request's own changes since then: to its files now, and to the ones it changed before and put back as
    // main has them. Putting one back is a change too: the code the pull request keeps then runs against main's old auth
    // check, say. What only a merge of main brought in drops out. (none: the branch's first push)
    function changedSince(branch: string, sha: string, files: string[]) {
      let previous: string;
      try {
        previous = root('rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`);
      } catch {
        return undefined;
      }
      const changed = (...range: string[]) =>
        root('diff', '--no-renames', '--name-only', '-z', ...range)
          .split('\0')
          .filter(Boolean);
      const ours = new Set([...files, ...changed(`refs/heads/${base}...${previous}`)]);
      return { sha: previous, files: changed(previous, sha).filter(f => ours.has(f)) };
    }

    // The frontmatter of each changed file the Library reads (a plain file, not deleted), as it is in the pushed commit:
    // the review sends a pull request back if the Library couldn't read it whole (review.ts). The Library takes the text
    // between a first line of --- and the next line starting with --- (company.ts frontmatter()), so that's what goes.
    // Frontmatter is a few hundred bytes: one over 8 KB goes as null (cut, it could fail to parse where the file doesn't;
    // the review sends it back unchecked), and past 200 KB in all nothing more.
    // The changed posts and notes go whole too, with the files under knowledge/ in the pushed commit, so the review sends
    // back one that points at a picture or file that isn't there (company.ts missing()). So do the unchanged ones that name a file under knowledge/ the push deletes (or moves: --no-renames).
    // One over 64 KB, those past 128 KB in all, and all of them if the list of files is over 200 KB, go unchecked.
    function shelved(entries: { mode: string; path: string }[], sha: string) {
      const out: { path: string; text: string | null }[] = [],
        docs: { path: string; text: string }[] = [];
      let total = 0,
        whole = 0;
      const read = (blob: string) =>
        execFileSync('git', ['--git-dir', mirror, 'cat-file', 'blob', blob], {
          encoding: 'utf8',
          maxBuffer: 1 << 26,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      const take = (path: string, src: string) => {
        if (path.startsWith('knowledge/') && src.length <= 65_536 && (whole += src.length) <= 131_072)
          docs.push({ path, text: src });
      };
      for (const { mode, path } of entries) {
        const [, to, , blob] = mode.split(' ');
        if (!SHELVES.test(path) || !/^100(644|755)$/.test(to) || !SHA.test(blob ?? '')) continue;
        let src: string;
        try {
          src = read(blob);
        } catch {
          continue;
        }
        take(path, src);
        const m = src.match(/^---\n([\s\S]*?)\n---/);
        if (!m || total > 200_000) continue;
        if (m[1].length > 8192) {
          out.push({ path, text: null });
          continue;
        }
        if ((total += m[1].length) > 200_000) continue;
        out.push({ path, text: m[1] });
      }
      // the deleted files' names, searched in the commit's posts and notes (missing() then checks the paths for real)
      const gone = [
        ...new Set(
          entries
            .filter(e => e.mode.split(' ')[1] === '000000' && e.path.startsWith('knowledge/'))
            .map(e => e.path.slice(e.path.lastIndexOf('/') + 1)),
        ),
      ];
      if (gone.length && gone.length <= 500) {
        let hits: string[] = [];
        try {
          hits = root('grep', '-l', '-z', '-F', ...gone.flatMap(n => ['-e', n]), sha, '--', 'knowledge').split('\0');
        } catch {
          /* none: git grep exits 1 */
        }
        for (const hit of hits) {
          const path = hit.slice(sha.length + 1);
          if (!SHELVES.test(path) || docs.some(d => d.path === path)) continue;
          try {
            take(path, read(`${sha}:${path}`));
          } catch {
            /* not a file */
          }
        }
      }
      let files: string[] = [];
      try {
        if (docs.length)
          files = root('ls-tree', '-r', '-z', '--name-only', sha, '--', 'knowledge').split('\0').filter(Boolean);
      } catch {
        /* over 1 MB of names: unchecked, like over 200 KB */
      }
      const small = files.reduce((n, f) => n + f.length + 3, 0) <= 200_000;
      return { frontmatter: out, knowledge: small && files.length ? { docs, files } : { docs: [], files: [] } };
    }

    // Each changed settings file as it was at the merge base and as pushed: a pull request that changes only settings
    // gets its panel by the keys it changes (review.ts). null where there's no plain file (added, deleted, a link) or it's
    // over 64 KB, and past 128 KB in all: the review can't tell what changed there, so it gets the normal panel. (#3900 had
    // 256 KB; with the shelves' documents beside it, that could take the worker's report past the coordinator's 1 MB.)
    function configs(entries: { mode: string; path: string }[]) {
      let total = 0;
      const text = (mode: string, blob: string) => {
        if (!/^100(644|755)$/.test(mode) || !SHA.test(blob)) return null;
        try {
          const src = execFileSync('git', ['--git-dir', mirror, 'cat-file', 'blob', blob], {
            encoding: 'utf8',
            maxBuffer: 1 << 26,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return src.length > 65_536 || (total += src.length) > 131_072 ? null : src;
        } catch {
          return null;
        }
      };
      return entries
        .filter(e => SETTINGS.test(e.path))
        .map(({ mode, path }) => {
          const [from, to, a, b] = mode.slice(1).split(' ');
          return { path, before: text(from, a), after: text(to, b) };
        });
    }

    return {
      ag,
      clone,
      settle, // (settle, checkout)
      checkout,
      push,
      pushProfile,
      withdrawProfile,
      touchUp,
      as: (cmd: string, args: string[], input?: string) => runAs(agent, cmd, args, input),
      // (git with stdin and variables of its own, its output whole: threads.ts)
      git: (args: string[], extra: { input?: string; env?: Record<string, string> } = {}) =>
        runAs({ ...pinned, env: { ...pinned.env, ...extra.env } }, 'git', args, extra.input),
    };
  }

  // A touch-up as root finds it in the mirror: exactly one commit on `base`, and each change an edit of a plain file the
  // consolidator may touch (same mode, no file added, deleted or renamed), small enough to stay a touch-up.
  function checkTouchup(base: string, sha: string, allowed: Set<string>) {
    if (root('rev-list', '--parents', '-n', '1', sha) !== `${sha} ${base}`)
      throw new Error('the touch-up is not one commit on the reviewed one');
    const entries = changes(base, sha);
    const edit = (mode: string) => /^:(100644|100755) \1 [0-9a-f]{40} [0-9a-f]{40} M$/.test(mode);
    const outside = entries.filter(e => !edit(e.mode) || !allowed.has(e.path)).map(e => e.path);
    if (outside.length)
      throw new Error(
        `the touch-up changes more than edits of the files it may change: ${outside.slice(0, 10).join(', ')}`,
      );
    const counts = root('diff', '--no-renames', '--numstat', '-z', base, sha)
      .split('\0')
      .filter(Boolean)
      .map(line => line.split('\t'));
    if (counts.some(([added]) => added === '-')) throw new Error('the touch-up changes a binary file');
    const lines = counts.reduce((n, [added, removed]) => n + Number(added) + Number(removed), 0);
    if (lines > TOUCHUP_LINES) throw new Error(`the touch-up changes ${lines} lines, more than its ${TOUCHUP_LINES}`);
    return entries.map(e => e.path);
  }

  // Profile lines as root finds them in the mirror: exactly one commit on main's head, and each change a plain file it
  // may change, added or edited.
  function checkProfile(sha: string, allowed: Set<string>) {
    const main = root('rev-parse', '--verify', `refs/heads/${base}^{commit}`);
    if (root('rev-list', '--parents', '-n', '1', sha) !== `${sha} ${main}`)
      throw new Error(`the profile lines are not one commit on ${base}'s head`);
    const entries = changes(main, sha);
    const plain = (mode: string) => /^:(000000|100644|100755) 100(644|755) [0-9a-f]{40} [0-9a-f]{40} [AM]$/.test(mode);
    const outside = entries.filter(e => !plain(e.mode) || !allowed.has(e.path)).map(e => e.path);
    if (outside.length)
      throw new Error(
        `the profile lines change more than the agent's profile and archive: ${outside.slice(0, 10).join(', ')}`,
      );
    if (!entries.length) throw new Error('the profile lines change nothing');
    return entries.map(e => e.path);
  }

  // Each change between two commits (or in a range) as git's raw diff has it, read in the mirror: its modes, blobs and
  // status, and its path (-z: unquoted)
  function changes(...range: string[]) {
    const raw = root('diff', '--no-renames', '--raw', '--no-abbrev', '-z', ...range).split('\0');
    return raw.flatMap((mode, i) => (i % 2 || !mode ? [] : [{ mode, path: raw[i + 1] }]));
  }

  // The code a push's tests test (worker.ts testsOnceOf): the pushed commit, its base on main and the trees of both, read
  // in the mirror, so nothing in the job's clone decides them.
  function testedCode(sha: string) {
    const baseSha = root('merge-base', sha, `refs/heads/${base}`);
    const [tree, baseTree] = root('rev-parse', `${sha}^{tree}`, `${baseSha}^{tree}`).split('\n');
    return { sha, base: baseSha, tree, baseTree };
  }

  return { ensureMirror, gcMirror, fetchMirror, refreshMirror, mergeBase, forAgent, testedCode }; // (testedCode)
}
