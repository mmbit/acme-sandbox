// A failed end-of-turn check returns its error to the same CLI session.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as api from './api.ts';
import { print } from './output.ts';

export const complete = {
  help: '\n   hq complete review | work <checkout> [<readable>...]  CLI Stop hook: validate the answer or run the work gates',
  async run(args: string[]) {
    let error: string | undefined;
    try {
      const hook = JSON.parse(readFileSync(0, 'utf8'));
      if (!(args[0] === 'review' ? args.length === 1 : args[0] === 'work' && args.length >= 2))
        throw new Error('use hq complete review | work <checkout> [<readable>...]');
      if (args[0] === 'review') {
        const answer = await api.call('review-output', {
          body: { output: submitted(hook.last_assistant_message) },
          timeoutMs: 10_000,
        });
        if (!api.isSuccess(answer.status)) throw new Error(api.errorIn(answer.body) || `HTTP ${answer.status}`);
        error = JSON.parse(answer.body).error ?? undefined;
      } else {
        const [checkout, ...readable] = args.slice(1);
        const helper = await gates(checkout, readable, true);
        const checked = helper.code === 2 ? await gates(checkout, readable, false) : helper;
        if (checked.code !== 0) {
          const output = checked.output || `npm run gates exited ${checked.code}`;
          error = checked === helper ? output : `Helper attempt:\n${helper.output}\nLocal attempt:\n${output}`;
        }
      }
    } catch (failure) {
      error = (failure as Error).message || String(failure);
    }
    print(
      JSON.stringify(
        error
          ? {
              decision: 'block',
              reason: `Completion check failed: ${error}. Correct it in this session, then submit again.`,
            }
          : {},
      ),
    );
  },
};

// The answer the worker submits (verdictOf, verdict.ts): the final message's JSON object, bare or in one ```json fence.
// The file on disk isn't the stream's (a Codex edit carries no contents, a command may rewrite it), so a final message
// without the JSON bounces. A file and a final message with different decisions are no verdict.
function submitted(last: unknown) {
  const jobDir = process.env.HQ_JOB_DIR;
  if (jobDir === undefined) throw new Error('HQ_JOB_DIR: unbound variable');
  let file: string | undefined;
  try {
    file = readFileSync(`${jobDir}/review.json`, 'utf8');
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
  }
  const t = typeof last === 'string' ? last.trim() : undefined;
  const said = [t, t?.match(/^```(?:json)?\n([\s\S]*)\n```$/)?.[1]].find(
    s => s !== undefined && object(s) !== undefined,
  );
  if (said === undefined)
    throw new Error(
      'your final message is not the JSON answer: end with the same JSON you wrote to .hq/review.json, and nothing else',
    );
  const decision = (s: string) => JSON.stringify(object(s)?.decision ?? null);
  if (file !== undefined && decision(file) !== decision(said))
    throw new Error(
      `.hq/review.json says ${decision(file)} and your final message ${decision(said)}: write the corrected JSON to .hq/review.json and end with that same JSON`,
    );
  return said;
}

function object(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// The gates run the checkout's own code (its package.json, what the gates import), which no CLI sandbox or action review
// saw: confine.py lets it write only the checkout and a scratch folder of its own, and read only those, the readable
// roots the worker names (the git mirror the clone borrows objects from) and the system's folders, and change no file's
// mode, owner, extended attributes or times, so it can't open the CLI home it owns to other slots. Its environment is
// built here, not inherited: no CLI home, sign-in or partner key, only the job's HQ address and token that a helper run
// needs (lent.ts), which every command of the session holds already.
const CONFINE = new URL('./confine.py', import.meta.url).pathname;
const PASSED = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'CI', 'HQ_URL', 'HQ_TOKEN'];

function gates(
  checkout: string,
  readable: string[],
  helper: boolean,
): Promise<{ code: number | null; output: string }> {
  const scratch = mkdtempSync(`${tmpdir()}/gates-`);
  const env = Object.fromEntries(PASSED.flatMap(k => (process.env[k] === undefined ? [] : [[k, process.env[k]]])));
  const roots = ['--write', checkout, scratch, ...(readable.length ? ['--read', ...readable] : [])];
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      'python3',
      [CONFINE, ...roots, '--', 'npm', 'run', 'gates', ...(helper ? ['--', '--helper'] : [])],
      { cwd: checkout, env: { ...env, HOME: scratch, TMPDIR: scratch }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  }).finally(() => rmSync(scratch, { recursive: true, force: true }));
}
