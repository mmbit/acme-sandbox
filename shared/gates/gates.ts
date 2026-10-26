// The gates every change passes before review: Prettier, ESLint and the type check, on what the change adds, and no
// rendered video or audio in git (a render's recipe and its .render.json go in its place: shared/demo/renders.mjs), nor
// generated output (a run's raw results: its summary goes in their place), nor a brand colour HQ can't wear (brand.ts.
// npm run gates [-- --base <ref>] [-- --all]   (CODE_STYLE.md, "The gates").
//
// Old code isn't held hostage. A file must be formatted if it's new or was formatted at the base. ESLint's findings
// count on the lines the change adds or edits, the size limits on what it makes long (sizes.ts). A type error counts
// when the base didn't have it. The refactoring passes bring old code in, area by area. --all counts what fails in the
// whole repo, per area, for those passes.
//
// --helper: on a lent machine instead (onHelper, lent.ts), as the worker sends a push's gates while one has a helper of
// the `tests` kind. They exit 2 when they didn't run there, and the worker runs them here.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Diagnostic } from 'typescript';
import { SIDE } from '../demo/renders.mjs';
import { brandProblems } from './brand.ts';
import { HqUnreachable, onLent, UNREACHED_EXIT } from './lent.ts';
import { dataProblems, outputProblems, renderProblems, type Change, type Problem } from './output.ts';
import { areaOf, missingPackage, git, gitFiles, linkModules, plural, TOOLS_HOME, workingTree } from './repo.ts';
import { crossedLimits, SIZE_RULES, sizedChanges } from './sizes.ts';

const CODE = /\.(ts|js|mjs|cjs)$/;
const PAGE = /\.html$/; // linted for its inline scripts, never formatted (eslint.config.js)
const FORMATTED = /\.(ts|js|mjs|cjs|css)$/;
const TYPED = /\.(ts|js|mjs|cjs)$|(^|\/)(package|tsconfig)\.json$/; // a change to one runs the type check
const BASE_FILES = /\.(ts|js|mjs|cjs)$|(^|\/)package\.json$/; // what the type check reads at the base
const FALSE_ALARM = 'A finding the tool gets wrong gets a disable comment that says why.';
// The run's time on the helper, which HQ's runs.ts needs (the worker's gatesLentMs counts it).
const HELPER_MINUTES = 5;

const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
const args = process.argv.slice(2);
const baseRef = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';

try {
  process.exitCode = args.includes('--helper') ? await onHelper() : await checkHere();
} catch (err) {
  // a gate that couldn't run says so and fails: the worker reports it as not run, never as passed. Gates that lost HQ,
  // the worker runs again once it answers.
  const unreached = err instanceof HqUnreachable;
  console.log(`The gates could not ${unreached ? 'reach HQ' : 'run'}: ${(err as Error).message}`);
  process.exitCode = unreached ? UNREACHED_EXIT : 2;
}

// --helper: the same gates on a lent machine's helper, when the type check runs: it's what takes the time (Prettier and
// ESLint on a few files take seconds here). A change to a .render.json stays here too: the file it names and git's
// history aren't in the bundle. Exit 2 when they didn't run there.
async function onHelper() {
  const base = baseOf();
  const changes = changedFiles(base);
  if (args.includes('--all') || !typeChecked(changes) || changes.some(c => c.path.endsWith(SIDE))) {
    console.log('The gates on the helper: not sent, as they take seconds here or need what the bundle lacks');
    return 2;
  }
  const tree = workingTree(root);
  const check = { what: 'The gates', base, tree, script: 'gates.ts', args: [], minutes: HELPER_MINUTES };
  const ran = await onLent(root, { ...check, bring: [], tools: [] });
  if (!ran) return 2;
  console.log(`${ran.output.trim()}\n(on ${ran.machine})`);
  return ran.exitCode;
}

async function checkHere() {
  linkTools();
  const tools = await loadTools();
  return args.includes('--all') ? await countAll(tools) : await checkChange(tools);
}

// ---- a change against its base

async function checkChange(tools: Tools) {
  const base = baseOf();
  const changes = changedFiles(base);
  const kept = await inScope(
    tools,
    changes.map(c => c.path),
  );
  const checked = changes.filter(c => kept.has(c.path));
  const problems = [
    ...(await unformatted(
      tools,
      base,
      checked.filter(c => FORMATTED.test(c.path)),
    )),
    ...(await lintFindings(
      tools,
      base,
      await sizedChanges(tools, root, changes, kept),
      checked.filter(c => CODE.test(c.path) || PAGE.test(c.path)),
    )),
    ...(typeChecked(changes) ? await newTypeErrors(tools, base, changes) : []),
    ...renderProblems(root, changes),
    ...dataProblems(root, changes),
    ...brandProblems(root, changes),
    ...outputProblems(root, changes),
  ];
  if (!problems.length) {
    console.log(`Gates passed: ${plural(checked.length, 'changed file')} checked against ${baseRef}`);
    return 0;
  }
  console.log(`Gates failed: ${plural(problems.length, 'problem')} in what this change adds\n`);
  for (const p of problems) console.log(`${p.path}${p.line ? `:${p.line}` : ''}: ${p.text}`);
  console.log(`\nFix each one and run \`npm run gates\` again. ${FALSE_ALARM}`);
  return 1;
}

// A merge not yet committed counts as made: against main's tip, main's own files aren't this change's
function baseOf() {
  return git(root, 'merge-base', baseRef, 'HEAD', ...mergeHead()).trim();
}

// A deleted or renamed file can break a caller too, and a .js one a .ts caller (allowJs)
function typeChecked(changes: Change[]) {
  return changes.some(c => [c.path, c.basePath].some(p => p && TYPED.test(p)));
}

// The commit a merge under way brings in, if any (rev-parse exits 1 when there's none)
function mergeHead() {
  try {
    return [git(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()];
  } catch {
    return [];
  }
}

// What the change touches against the base: committed, staged, unstaged and untracked. A file's lines are the ones the
// change adds or edits ('all' for a new file, or one that was a symlink). A renamed file keeps its base path, so its old
// lines stay old. A deleted file has no path: nothing of it is checked, but it still counts for the type check.
// The paths come from --name-status -z, exactly as git stores them. The patch lists the same files in the same order
// (a type change as two: the old one deleted, the new one added) and gives only its hunk headers: a hunk's own lines
// all start with + or -, so a line starting `@@` is always a header.
function changedFiles(base: string): Change[] {
  const changes: Change[] = [];
  const fields = git(root, 'diff', '-z', '--name-status', '-M', base).split('\0');
  for (let i = 0; fields[i];) {
    const status = fields[i++][0];
    const basePath = fields[i++];
    const path = 'RC'.includes(status) ? fields[i++] : basePath;
    if (status === 'D') changes.push({ path: '', basePath, lines: new Set() });
    else if (status === 'A' || status === 'T') changes.push({ path, basePath: null, lines: 'all' });
    else changes.push({ path, basePath, lines: new Set() });
    if (status === 'T') changes.push({ path: '', basePath: null, lines: 'all' }); // the patch's second diff for it
  }
  const patch = git(root, 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', base);
  const files = patch.split(/^diff --git /m).slice(1);
  if (files.length !== changes.length)
    throw new Error(`git listed ${changes.length} changes but ${files.length} diffs`);
  files.forEach((text, i) => {
    const lines = changes[i].lines;
    if (lines === 'all') return;
    for (const [, start, count] of text.matchAll(/^@@ [^@]*\+(\d+)(?:,(\d+))? @@/gm))
      for (let n = Number(start); n < Number(start) + Number(count ?? 1); n++) lines.add(n);
  });
  const untracked = git(root, 'ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
  for (const path of untracked) changes.push({ path, basePath: null, lines: 'all' });
  return changes;
}

// A file is formatted if it's new or was formatted at the base: an old file waits for its area's refactoring pass.
async function unformatted(tools: Tools, base: string, changes: Change[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const change of changes) {
    const baseText = change.basePath ? git(root, 'show', `${base}:${change.basePath}`) : null;
    if (baseText !== null && !(await formatted(tools, change.path, baseText))) continue;
    if (await formatted(tools, change.path, readFileSync(join(root, change.path), 'utf8'))) continue;
    problems.push({ path: change.path, text: `not formatted (npx prettier --write ${change.path})` });
  }
  return problems;
}

// The size limits count by what the change crosses (sizes.ts), with every file in scope it touches, deleted ones too.
async function lintFindings(tools: Tools, base: string, sized: Change[], linted: Change[]): Promise<Problem[]> {
  if (!linted.length) return [];
  const results = await tools.eslint.lintFiles(linted.map(c => join(root, c.path)));
  const findings = results.flatMap(result => {
    const change = linted.find(c => join(root, c.path) === result.filePath)!;
    const added = (line: number) => change.lines === 'all' || change.lines.has(line);
    return result.messages
      .filter(m => m.fatal || (m.severity === 2 && !SIZE_RULES.has(m.ruleId!) && added(m.line)))
      .map(m => ({ path: change.path, line: m.line, text: `${m.message} (${m.ruleId ?? 'parse error'})` }));
  });
  return [...findings, ...(await crossedLimits(tools, root, base, sized, results))];
}

// The whole program is checked at the base and now, so a change that breaks a caller in a file it didn't touch is
// caught too. An error is new when now has more of it (same file, code and message) than the base had. A renamed
// file's errors at the base count under its new name.
async function newTypeErrors(tools: Tools, base: string, changes: Change[]): Promise<Problem[]> {
  const listedNow = gitFiles(root, 'ls-files', '-co', '--exclude-standard', '*.ts');
  const present = listedNow.filter(p => existsSync(join(root, p)));
  const now = typeErrors(tools, root, [...(await inScope(tools, present))]);
  const baseDir = mkdtempSync(join(tmpdir(), 'gates-base-'));
  try {
    const listedBase = gitFiles(root, 'ls-tree', '-r', '--name-only', base);
    // (-m: no file times set, a call the work Stop hook's confinement refuses, platform/worker/hq/confine.py)
    const archive = 'git archive --format=tar "$0" -- "$@" | tar -x -m -C "$GATES_BASE_DIR"';
    const env = { ...process.env, GATES_BASE_DIR: baseDir, GIT_LITERAL_PATHSPECS: '1' };
    execFileSync('sh', ['-c', archive, base, ...listedBase.filter(p => BASE_FILES.test(p))], { cwd: root, env });
    linkModules(root, root, baseDir);
    const before = typeErrors(tools, baseDir, [...(await inScope(tools, listedBase, baseDir))]);
    const renamed = new Map(
      changes.filter(c => c.path && c.basePath && c.basePath !== c.path).map(c => [c.basePath, c.path]),
    );
    const left = new Map<string, number>();
    for (const error of before) {
      const key = errorKey(renamed.get(error.path) ?? error.path, error.code, error.message);
      left.set(key, (left.get(key) ?? 0) + 1);
    }
    return now.filter(error => {
      const key = errorKey(error.path, error.code, error.message);
      left.set(key, (left.get(key) ?? 0) - 1);
      return left.get(key)! < 0;
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

// Both checks use the change's own tsconfig.json, so the base is judged by today's rules. An error in no file (the
// config, a `types` package that can't be found) means the check itself is broken: it can't run, so it fails.
function typeErrors(tools: Tools, dir: string, files: string[]) {
  const ts = tools.typescript;
  const broken = (diagnostics: readonly Diagnostic[]) => {
    const texts = diagnostics.map(d => `${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (TS${d.code})`);
    if (texts.length) throw new Error(`the type check's config: ${texts.join('; ')}`);
  };
  const { config, error } = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  broken(error ? [error] : []);
  const { options, errors } = ts.convertCompilerOptionsFromJson(config.compilerOptions, dir);
  broken(errors);
  const program = ts.createProgram({ rootNames: files.filter(f => f.endsWith('.ts')).map(f => join(dir, f)), options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  broken(diagnostics.filter(d => !d.file));
  return diagnostics.flatMap(diagnostic => {
    if (!diagnostic.file || notInstalledYet(dir, diagnostic)) return [];
    const path = relative(dir, diagnostic.file.fileName);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').replaceAll(dir, '');
    const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
    return [{ path, line, code: diagnostic.code, message, text: `${message} (TS${diagnostic.code})` }];
  });
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

// The compiler prints a union's members in the order it first met them, so a file the change adds can turn an old
// error's '1000 | 500' into '500 | 1000': a quoted union of plain numbers has its members sorted, and it stays the same
// error. Any other type stays as printed: its ' | ' can sit inside a generic, where sorting would make two types one.
function errorKey(path: string, code: number, message: string) {
  const types = message.replace(/'-?\d+(?:\.\d+)?(?: \| -?\d+(?:\.\d+)?)+'/g, union => {
    return `'${union.slice(1, -1).split(' | ').sort().join(' | ')}'`;
  });
  return `${path}\n${code}\n${types}`;
}

// ---- the whole repo, per area

async function countAll(tools: Tools) {
  const listed = gitFiles(root, 'ls-files', '-co', '--exclude-standard');
  const files = [...(await inScope(tools, listed))];
  const areas = new Map<string, AreaCount>();
  const area = (path: string) => {
    const name = areaOf(path);
    if (!areas.has(name))
      areas.set(name, { files: 0, unformatted: 0, lint: new Set(), types: new Set(), long: new Set(), functions: 0 });
    return areas.get(name)!;
  };
  for (const path of files) {
    area(path).files++;
    if (FORMATTED.test(path) && !(await formatted(tools, path, readFileSync(join(root, path), 'utf8'))))
      area(path).unformatted++;
  }
  const code = files.filter(p => CODE.test(p) || PAGE.test(p)).map(p => join(root, p));
  for (const result of await tools.eslint.lintFiles(code)) {
    const counted = area(relative(root, result.filePath));
    const errors = result.messages.filter(m => m.fatal || m.severity === 2);
    if (errors.some(m => !SIZE_RULES.has(m.ruleId!))) counted.lint.add(result.filePath);
    if (errors.some(m => m.ruleId === 'max-lines')) counted.long.add(result.filePath);
    counted.functions += errors.filter(m => m.ruleId === 'max-lines-per-function').length;
  }
  for (const error of typeErrors(tools, root, files))
    if (files.includes(error.path)) area(error.path).types.add(error.path);
  printAreas(areas);
  return 0;
}

type AreaCount = {
  files: number;
  unformatted: number;
  lint: Set<string>;
  types: Set<string>;
  long: Set<string>;
  functions: number;
};

function printAreas(areas: Map<string, AreaCount>) {
  const rows = [...areas].sort(([a], [b]) => a.localeCompare(b));
  console.log('Files per area that fail each gate (a file counts once per gate), and functions over 50 lines');
  console.table(
    rows.map(([name, a]) => ({
      area: name,
      files: a.files,
      unformatted: a.unformatted,
      'eslint errors': a.lint.size,
      'type errors': a.types.size,
      'over 400 lines': a.long.size,
      'functions over 50 lines': a.functions,
    })),
  );
}

// ---- the tools

type Tools = Awaited<ReturnType<typeof loadTools>>;

// The tools come from node_modules at the root (npm ci). A job's clone in the worker has none: the image keeps them in
// TOOLS_HOME, laid out as the repo, and they're linked in, the coordinator's packages too (for the type check).
function linkTools() {
  linkModules(root, TOOLS_HOME, root);
  if (!existsSync(join(root, 'node_modules', 'prettier')))
    throw new Error('its tools are missing: run `npm ci` at the repo root first');
}

async function loadTools() {
  const [prettier, { ESLint }, typescript] = await Promise.all([
    import('prettier'),
    import('eslint'),
    import('typescript'),
  ]);
  return { prettier, eslint: new ESLint({ cwd: root }), typescript: typescript.default };
}

// The code files and pages among `paths` (in `dir`) that the gates hold. Prettier's ignore file is the one list of what
// they leave out (eslint.config.js reads it too).
async function inScope(tools: Tools, paths: string[], dir = root) {
  const ignorePath = join(root, '.prettierignore');
  const candidates = paths.filter(p => (FORMATTED.test(p) || PAGE.test(p)) && regularFile(join(dir, p)));
  const infos = await Promise.all(candidates.map(p => tools.prettier.getFileInfo(join(root, p), { ignorePath })));
  return new Set(candidates.filter((_, i) => !infos[i].ignored));
}

async function formatted(tools: Tools, path: string, text: string) {
  const options = await tools.prettier.resolveConfig(join(root, path));
  return tools.prettier.check(text, { ...options, filepath: path });
}

// (functions, not arrow consts: the run at the top calls them before this point of the module is reached)
function regularFile(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}
