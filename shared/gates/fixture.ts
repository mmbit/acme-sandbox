// Throwaway repositories for the test runner integration suites, and HQ as a check's --helper meets it.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after as afterAll } from 'node:test';

const repo = join(import.meta.dirname, '..', '..');

// A repo with the runner and a base commit on main, then a branch whose changes are `after`, run with `env` added.
export function tests(before: Record<string, string>, after: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  return clone(before, after).run(env);
}

// The same repo, in `dir`, to run more than once: `change` commits more to the branch.
export function clone(before: Record<string, string>, after: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'tests-test-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  git('init', '-q', '-b', 'main');
  for (const path of [
    'shared/gates/tests.ts',
    'shared/gates/comparison.ts',
    'shared/gates/suites.ts',
    'shared/gates/repo.ts',
    'shared/gates/lent.ts',
    'shared/gates/timings.ts',
  ])
    cpSync(join(repo, path), join(dir, path));
  write(before);
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  const change = (files: Record<string, string>) => {
    write(files);
    git('add', '-A');
    git('commit', '-qm', 'work');
  };
  change(after);
  const run = (env: NodeJS.ProcessEnv = {}, script = 'tests.ts', more: string[] = []) => {
    const ran = spawnSync(process.execPath, [`shared/gates/${script}`, '--base', 'main', ...more], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GATES_HOME: join(dir, 'none'), ...env },
    });
    return { status: ran.status, out: ran.stdout };
  };
  return { dir, change, run };
}

export const nodeTest = (name: string, check: string) =>
  `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './sum.ts';\ntest('${name}', () => { ${check} });\n`;
export const sum = (body: string) => `export const sum = (a: number, b: number) => ${body};\n`;

// HQ as --helper meets it (lent.ts), in a process of its own (a check's spawnSync blocks the test's): each run carried
// out at once, in `env`, as a lent machine "attic" would, with the files it brings back. Each ask for a run's state
// takes the next of `states` (the last stays), each a state and the machine that has the run then, until the check
// stops it, answering that after PLAYED_STOP_MS. PLAYED_TIMED_OUT: each run stopped at its limit, as a helper's is
// (exit code 124, with its output). The network fails as `env` says: REPORT_DISCONNECTS drops that many
// GETs unanswered, DROP_SUBMIT drops the first run's submission once HQ has it, and RESTARTING plays HQ restarting.
// playedHq returns its HQ_URL and HQ_TOKEN, for the check's environment, with `env`.
// (#5575 and #5602's network failures)
const PLAYED_HQ = `
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const states = JSON.parse(process.argv[2]);
const runs = [];
const comparisons = new Map();
let disconnects = Number(process.env.REPORT_DISCONNECTS ?? 0);
const read = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
const answer = async (req, res) => {
  if (req.headers.authorization !== 'Bearer job-token') return res.writeHead(401).end();
  if (!process.env.KEEP_ALIVE) res.setHeader('connection', 'close');
  if (req.url.startsWith('/api/agent/tests/base/')) {
    const request = JSON.parse(await read(req));
    const key = test => JSON.stringify([request.commit, request.environment, test]);
    if (req.url.endsWith('/claim')) return res.end(JSON.stringify(request.tests.map(test =>
      comparisons.has(key(test)) ? { test, failed: comparisons.get(key(test)) } : { test, yours: true })));
    for (const { test, failed } of request.tests) {
      if (failed === null) comparisons.delete(key(test));
      else comparisons.set(key(test), failed);
    }
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === 'GET' && disconnects-- > 0) return res.destroy();
  if (req.url === '/api/agent/runs/helper') return res.end(JSON.stringify({
    browser: process.env.HELPER_BROWSER ?? 'render',
    kinds: JSON.parse(process.env.HELPER_KINDS ?? '[{"name":"render","present":true}]') }));
  if (req.url === '/api/agent/runs') {
    const spec = JSON.parse(Buffer.from(req.headers['x-run'], 'base64url').toString());
    const tree = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'played-helper-'));
    execFileSync('tar', ['-xzf', '-', '-C', tree], { input: await read(req) });
    let output = '', exitCode = 0;
    try { output = execFileSync('sh', ['-c', spec.command], { cwd: tree, encoding: 'utf8',
      env: { ...process.env, RUN_KIND: spec.kind, ...JSON.parse(process.env.HELPER_ENV ?? '{}') } }); }
    catch (err) { output = err.stdout; exitCode = err.status; }
    if (process.env.PLAYED_TIMED_OUT) exitCode = 124;
    if (spec.bring.length) execFileSync('tar', ['-czf', 'files.tar.gz', ...spec.bring], { cwd: tree });
    const runStates = JSON.parse(process.env.RUN_STATES ?? 'null')?.[runs.length] ?? states;
    runs.push({ tree, output, exitCode, states: [...runStates] });
    if (process.env.DROP_SUBMIT && runs.length === 1) return res.destroy();
    return res.end(JSON.stringify({ id: runs.length }));
  }
  const run = runs[Number(req.url.split('/')[4]) - 1];
  if (req.url.endsWith('/files')) return res.end(readFileSync(join(run.tree, 'files.tar.gz')));
  if (req.url.endsWith('/output')) return res.end(run.output);
  if (req.url.endsWith('/withdraw')) run.states = [['withdrawn', run.states[0][1]]];
  if (req.url.endsWith('/stop')) {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.PLAYED_STOP_MS ?? 0)));
    run.states = [['stopped', run.states[0][1]]];
  }
  const [state, machine] = run.states.length > 1 ? run.states.shift() : run.states[0];
  const why = state === 'lost' ? machine + ' went quiet' : null;
  const timedOut = !!process.env.PLAYED_TIMED_OUT;
  res.end(JSON.stringify({ state, exitCode: run.exitCode, timedOut, machine, why, helper: { takeMinutes: Number(process.env.HELPER_TAKE_MINUTES ?? 1), present: true } }));
};
if (!process.env.RESTARTING) createServer(answer).listen(0, function () { console.log(this.address().port); });
// as a deploy does: down (connections refused) as the push sends its run, and again from the run's first poll, which
// it drops unanswered, each time back within the one more try's POLL_MS
let dropped = false;
const restarting = createServer((req, res) => {
  if (dropped || req.method !== 'GET' || req.url.split('/').length !== 5) return answer(req, res);
  dropped = true;
  down(3000);
});
const down = ms => {
  const { port } = restarting.address();
  restarting.close();
  restarting.closeAllConnections();
  setTimeout(() => restarting.listen(port), ms);
};
if (process.env.RESTARTING) restarting.listen(0, () => { console.log(restarting.address().port); down(2000); });
`;
export async function playedHq(states: [string, string][] = [['done', 'attic']], env: NodeJS.ProcessEnv = {}) {
  const script = join(mkdtempSync(join(tmpdir(), 'tests-hq-')), 'hq.mjs');
  writeFileSync(script, PLAYED_HQ);
  const hq = spawn(process.execPath, [script, JSON.stringify(states)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  afterAll(() => hq.kill());
  const [port] = (await once(hq.stdout, 'data')) as Buffer[];
  return { HQ_URL: `http://localhost:${String(port).trim()}`, HQ_TOKEN: 'job-token', ...env };
}

// The helper's script (tests-on-helper.sh) without its installs: the check's script with the arguments after it
export const ON_HELPER = 'script="$1"; shift; exec node "shared/gates/$script" --base origin/main "$@"\n';
