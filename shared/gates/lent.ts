// A check on a lent machine's helper of the `tests` kind instead of here (tests.ts and gates.ts --helper), as a run of
// the job (the coordinator's runs.ts, with the job's HQ_URL and HQ_TOKEN): the repo at the base and as it is now go in a
// git bundle, and tests-on-helper.sh runs the check's own script there, against that base. HQ takes a run back from a
// lent helper that went quiet, for another take, and refuses what that one sends after. The run's report, exit code and
// the files it brings back are the check's, taken once it's done. Run here instead (undefined) when no helper takes it
// in time, it's lost, or it couldn't run there. The command has the end of the helper's limit in LENT_UNTIL (seconds on
// the helper's clock), for a check that stops itself in time to say how far it got. A run the helper stopped at the
// limit is that check's result (limitIsResult), never one to run again here, where nothing would stop it.
//
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, openAsBlob, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { git } from './repo.ts';

const POLL_MS = 5000;
const NEVER_CONNECTED = ['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
const BUNDLE = 'tests.bundle';
const FILES = 'files.tar.gz';
const execute = promisify(execFile);

// What a check sends: what it's called in its notes, the base and the tree to check, its script in shared/gates with its
// arguments, the helper's time limit, the files it brings back (in the tree the bundle unpacks to, beside the repo), and
// tools to put first on the helper's PATH.
export type LentCheck = {
  what: string;
  kind?: string;
  bootstrap?: string;
  binary?: string[];
  exitIsResult?: true;
  waitWhilePresent?: true;
  base: string;
  tree: string;
  script: string;
  args: string[];
  minutes: number;
  bring: string[];
  tools: string[];
  fallback?: false; // a comparison cannot move to another environment,
  inputs?: Record<string, string>; // nonsecret files beside the bundle,
  limitIsResult?: true;
};
// (timedOut: stopped at the limit, a limitIsResult check's, with its output and nothing brought)
export type LentRun = {
  output: string;
  exitCode: number;
  machine: string;
  brought: Map<string, string>;
  timedOut: boolean;
  binary?: Map<string, Buffer>;
};
type Call = (path: string, init?: RequestInit) => Promise<Response>;
type RunState = {
  state: string;
  exitCode: number | null;
  timedOut: boolean;
  machine: string | null;
  why: string | null;
  helper: { takeMinutes: number; present?: boolean };
};

export async function onLent(root: string, check: LentCheck): Promise<LentRun | undefined> {
  const { HQ_URL: hq, HQ_TOKEN: token } = process.env;
  if (!hq || !token) return undefined;
  const call: Call = (path, init = {}) =>
    fetch(`${hq}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const said = (why: string) => {
    const next = check.fallback === false ? 'The check is incomplete.' : 'They run here instead.';
    console.log(`${check.what} on the helper: ${why}. ${next}\n`);
    return undefined;
  };
  // The worker's limit on a lent launch (the gates': worker.ts gatesLentMs) stops this process: the run on HQ stops with
  // it (once it's sent, if it's being sent), so what a helper sends later is refused.
  let stopAsked = false;
  let stop = () => {
    stopAsked = true;
  };
  const onStop = () => {
    console.log(`${check.what} on the helper: stopped at the time limit`);
    stop();
  };
  process.once('SIGTERM', onStop);
  try {
    const sent = await sendRun(root, call, check);
    if (typeof sent === 'string') return said(`the helper refused the run: ${sent}`);
    stop = () => void stopAndExit(call, sent);
    if (stopAsked) await stopAndExit(call, sent);
    return await outcomeOf(call, sent, check, said);
  } finally {
    process.off('SIGTERM', onStop);
  }
}

async function stopAndExit(call: Call, id: number) {
  try {
    await call(`/api/agent/runs/${id}/stop`, { method: 'POST' });
  } catch (err) {
    console.error('The run on HQ could not be stopped', err);
  }
  process.exit(2);
}

// The run's outcome once it's done, or undefined (said) when it ended otherwise
async function outcomeOf(call: Call, sent: number, check: LentCheck, said: (why: string) => undefined) {
  let waitingSince = Date.now();
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const run = (await reaching(() => call(`/api/agent/runs/${sent}`).then(answer => answer.json()))) as RunState;
    if (run.state === 'running') waitingSince = Date.now();
    if (
      run.state === 'waiting' &&
      Date.now() - waitingSince > run.helper.takeMinutes * 60_000 &&
      !(check.waitWhilePresent && run.helper.present)
    ) {
      await reaching(() => call(`/api/agent/runs/${sent}/withdraw`, { method: 'POST' }));
      continue;
    }
    if (['withdrawn', 'stopped', 'lost'].includes(run.state))
      return said(`no helper ran them (${run.why ?? run.state})`);
    if (run.state !== 'done') continue;
    const output = await reaching(() => call(`/api/agent/runs/${sent}/output`).then(answer => answer.text()));
    if (run.timedOut && check.limitIsResult)
      return {
        output,
        exitCode: run.exitCode!,
        machine: run.machine!,
        brought: new Map<string, string>(),
        timedOut: true,
      };
    if (!check.exitIsResult && run.exitCode !== 0 && run.exitCode !== 1)
      return said(`they couldn't run on ${run.machine}:\n${output.trim()}`);
    const names = [...check.bring, ...(check.binary ?? [])];
    let files: Map<string, Buffer>;
    try {
      files = names.length ? await broughtBack(call, sent, names) : new Map<string, Buffer>();
    } catch (error) {
      if (check.exitIsResult) console.error(`${check.what} on ${run.machine}:\n${output}`);
      throw error;
    }
    const brought = new Map(check.bring.map(name => [name, files.get(name)!.toString('utf8')]));
    const binary = new Map((check.binary ?? []).map(name => [name, files.get(name)!]));
    return { output, exitCode: run.exitCode!, machine: run.machine!, brought, binary, timedOut: run.timedOut };
  }
}

// The run asked of the helper: its id, or HQ's words when it refused it
async function sendRun(root: string, call: Call, check: LentCheck): Promise<number | string> {
  const dir = mkdtempSync(join(tmpdir(), 'lent-bundle-'));
  const command =
    `export LENT_UNTIL=$(($(date +%s) + ${Math.round(check.minutes * 60)})) && ` +
    `git init -q repo && git -C repo fetch -q ../${BUNDLE} refs/tests/change:refs/heads/change && cd repo && ` +
    'git checkout -q change && git update-ref refs/remotes/origin/main change~1 && ' +
    'export PATH="$PWD/../tools:$PATH" && ' +
    `sh ${quoted(check.bootstrap ?? 'shared/gates/tests-on-helper.sh')} ${[check.script, ...check.args].map(quoted).join(' ')}`;
  const spec = {
    command,
    kind: check.kind ?? 'tests',
    cwd: '',
    bring: [...check.bring, ...(check.binary ?? [])],
    minutes: check.minutes,
  };
  try {
    const run = {
      method: 'POST',
      headers: { 'x-run': Buffer.from(JSON.stringify(spec)).toString('base64url') },
      body: await bundleOf(root, check, dir),
    };
    const sent = await reaching(() => call('/api/agent/runs', run), true);
    if (!sent.ok) return await sent.text();
    return ((await sent.json()) as { id: number }).id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The bundle a run carries: the base and the tree, each a commit of its own on refs/tests/change (the base its parent,
// with none before it), in a git bundle, and the tools when there are any, as a gzipped tar
async function bundleOf(root: string, check: LentCheck, dir: string) {
  const env = {
    ...process.env,
    ...Object.fromEntries(
      ['AUTHOR', 'COMMITTER'].flatMap(who => [
        [`GIT_${who}_NAME`, 'tests'],
        [`GIT_${who}_EMAIL`, 'tests@hq'],
      ]),
    ),
  };
  const commit = (...args: string[]) =>
    execFileSync('git', ['commit-tree', ...args, '-m', 'tests'], { cwd: root, env, encoding: 'utf8' }).trim();
  const ref = 'refs/tests/change';
  git(root, 'update-ref', ref, commit(check.tree, '-p', commit(`${check.base}^{tree}`)));
  try {
    // The event loop must observe closed HQ connections while the archive is made.
    await execute('git', ['bundle', 'create', '-q', join(dir, BUNDLE), ref], { cwd: root });
  } finally {
    git(root, 'update-ref', '-d', ref);
  }
  if (check.tools.length) {
    mkdirSync(join(dir, 'tools'));
    for (const tool of check.tools) copyFileSync(tool, join(dir, 'tools', basename(tool)));
  }
  for (const [name, content] of Object.entries(check.inputs ?? {})) writeFileSync(join(dir, name), content);
  const packed = [BUNDLE, ...(check.tools.length ? ['tools'] : []), ...Object.keys(check.inputs ?? {})];
  await execute('tar', ['-czf', join(dir, 'bundle.tar.gz'), '-C', dir, ...packed]);
  return openAsBlob(join(dir, 'bundle.tar.gz'));
}

// The files a run brought back, by name
async function broughtBack(call: Call, id: number, names: string[]) {
  const files = await reaching(async () => {
    const answer = await call(`/api/agent/runs/${id}/files`);
    if (!answer.ok) throw new Error(`the helper's run brought no files back (HTTP ${answer.status})`);
    return Buffer.from(await answer.arrayBuffer());
  });
  const dir = mkdtempSync(join(tmpdir(), 'lent-files-'));
  try {
    writeFileSync(join(dir, FILES), files);
    execFileSync('tar', ['-xzf', FILES, ...names], { cwd: dir, stdio: 'ignore' });
    return new Map(names.map(name => [name, readFileSync(join(dir, name))]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A call to HQ and the answer read, tried once more after POLL_MS when the network fails it (fetch's TypeError: HQ
// restarting, its name gone from DNS meanwhile), where an HTTP status is HQ's own answer. A second failure ends the
// check as not run. `once`: a call that mustn't reach HQ twice, so only one that never connected is tried again.
async function reaching<T>(ask: () => Promise<T>, once = false): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    const code = ((err as Error).cause as { code?: string } | undefined)?.code ?? '';
    if (!(err instanceof TypeError && (!once || NEVER_CONNECTED.includes(code)))) throw err;
  }
  await new Promise(resolve => setTimeout(resolve, POLL_MS));
  return ask();
}

const quoted = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
