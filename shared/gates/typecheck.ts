// The gates' type check (gates.ts), each step in a thread of its own: what the change reaches (reach.ts), then the
// program at the base, then now.
//
// Each thread's heap has a cap, which guards the worker's memory: the gates run in every job's clone (the closing run
// and the push's, when no helper takes them), on a worker every job's memory shares, and its admission starts no job
// while they hold it. A check that passes the cap fails as not run, never as passed: the cap is set over the whole
// repo's program (~1.3 GB live in October 2026), so only a check far bigger than any yet stops at it. A thread's memory
// goes when it ends, so no step holds what the one before left for V8 to collect (one process held ~1.96 GB at the end
// of a job, measured in job #21775).
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { join, relative } from 'node:path';
import type { CompilerOptions, Diagnostic } from 'typescript';
import { reach, type Side } from './reach.ts';
import { missingPackage } from './repo.ts';

type TS = typeof import('typescript');
export type TypeFinding = { path: string; line: number; code: number; message: string; text: string };
type Step = { root: string } & ({ dir: string; roots: string[] } | { sides: Side[]; changed: string[] });

export const HEAP_CAP_MB = 2048;

// The errors of the program with `roots` in `dir`, by the tsconfig.json at `root` (capMb: for the tests)
export const typeErrors = (root: string, dir: string, roots: string[], capMb = HEAP_CAP_MB) =>
  inThread<TypeFinding[]>({ root, dir, roots }, capMb);

// Each side's roots for the type check, as far as the change reaches, or undefined: the whole program (reach.ts)
export const reachedRoots = (root: string, sides: Side[], changed: string[]) =>
  inThread<string[][] | undefined>({ root, sides, changed }, HEAP_CAP_MB);

function inThread<T>(step: Step, capMb: number) {
  const thread = new Worker(new URL(import.meta.url), {
    workerData: { typecheck: step },
    resourceLimits: { maxOldGenerationSizeMb: capMb },
  });
  return new Promise<T>((resolve, reject) => {
    thread.once('message', resolve);
    thread.once('error', (err: Error & { code?: string }) => {
      const capped = err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      reject(capped ? new Error(`the type check passed its ${capMb} MB cap (typecheck.ts HEAP_CAP_MB)`) : err);
    });
    thread.once('exit', code => reject(new Error(`the type check's thread ended with ${code} and no answer`)));
  });
}

// (only for a step of its own: another module's thread may import this one)
const step = isMainThread ? undefined : (workerData as { typecheck?: Step } | null)?.typecheck;
if (step) {
  const ts = (await import('typescript')).default;
  parentPort!.postMessage(
    'roots' in step
      ? check(ts, step.root, step.dir, step.roots)
      : reach(ts, compilerOptions(ts, step.root, step.root), step.sides, step.changed),
  );
}

// Both checks use the change's own tsconfig.json, so the base is judged by today's rules. An error in no file (the
// config, a `types` package that can't be found) means the check itself is broken: it can't run, so it fails.
function check(ts: TS, root: string, dir: string, roots: string[]): TypeFinding[] {
  const program = ts.createProgram({
    rootNames: roots.map(f => join(dir, f)),
    options: compilerOptions(ts, root, dir),
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  configBroken(
    ts,
    diagnostics.filter(d => !d.file),
  );
  return diagnostics.flatMap(diagnostic => {
    if (!diagnostic.file || notInstalledYet(dir, diagnostic)) return [];
    const path = relative(dir, diagnostic.file.fileName);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').replaceAll(dir, '');
    const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
    return [{ path, line, code: diagnostic.code, message, text: `${message} (TS${diagnostic.code})` }];
  });
}

export function compilerOptions(ts: TS, root: string, dir: string): CompilerOptions {
  const { config, error } = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  configBroken(ts, error ? [error] : []);
  const { options, errors } = ts.convertCompilerOptionsFromJson(config.compilerOptions, dir);
  configBroken(ts, errors);
  return options;
}

function configBroken(ts: TS, diagnostics: readonly Diagnostic[]) {
  const texts = diagnostics.map(d => `${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (TS${d.code})`);
  if (texts.length) throw new Error(`the type check's config: ${texts.join('; ')}`);
}

// A package the change adds to a package.json: the image's copy (TOOLS_HOME) has it once built from the merged lock, and
// the tests install it from the lock (tests.ts). Its types wait for the image.
function notInstalledYet(dir: string, diagnostic: Diagnostic) {
  const { code, file, start, length = 2 } = diagnostic;
  if (code !== 2307 || !file || start === undefined) return false;
  const name = missingPackage(dir, file.fileName, file.text.slice(start + 1, start + length - 1));
  if (name)
    console.log(`${relative(dir, file.fileName)}: '${name}' isn't installed here yet: its types aren't checked`);
  return !!name;
}
