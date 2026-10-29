// The size limits a change crosses (CODE_STYLE.md, "Size limits"): ESLint's max-lines and max-lines-per-function, judged
// by what the change makes long, since they report on a line the change may never touch. Python and shell, which ESLint
// can't read, are measured here against the same limits: a shell script for its length only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ESLint, Linter } from 'eslint';
import type * as Prettier from 'prettier';
import type TypeScript from 'typescript';
import { git } from './repo.ts';

const CODE = /\.(ts|js|mjs|cjs)$/;
export const SCRIPT = /\.(py|sh)$/;
const SIZED = /\.(ts|js|mjs|cjs|py|sh)$/;
// A Python or shell test grows with the behaviour it covers, as the code's tests do (eslint.config.js)
const SCRIPT_TEST = /(^|\/)(test_[^/]*|tests\/.*)$/;
export const SIZE_RULES = new Set(['max-lines', 'max-lines-per-function']);

type Change = { path: string; basePath: string | null };
type Tools = { eslint: ESLint; prettier: typeof Prettier; typescript: typeof TypeScript };
// A limit a file or function is past: where, ESLint's words and rule, and for a function the name it goes by
type Long = { line: number; message: string; ruleId: string | null };
type Sizes = { text: string; longFile: Long | null; longFunctions: (Long & { name: string })[] };

// The changes as the size limits read them: each side only where the gates hold it (Prettier's ignore file, read by
// today's rules), so a file ignored at the base counts as new and one ignored now only lends its old functions
export async function sizedChanges<C extends Change>(tools: Tools, root: string, changes: C[], kept: Set<string>) {
  const ignorePath = join(root, '.prettierignore');
  const basePaths = changes.flatMap(c => (c.basePath && SIZED.test(c.basePath) ? [c.basePath] : []));
  const infos = await Promise.all(basePaths.map(p => tools.prettier.getFileInfo(join(root, p), { ignorePath })));
  const keptAtBase = new Set(basePaths.filter((_, i) => !infos[i].ignored));
  return changes
    .map(c => ({
      ...c,
      path: kept.has(c.path) ? c.path : '',
      basePath: keptAtBase.has(c.basePath!) ? c.basePath : null,
    }))
    .filter(c => c.path || c.basePath);
}

// A file fails when it crosses 400 lines: it's new, or was 400 or under at the base. A long function fails in any file
// the change touches, unless a function of that name was already long at the base in the same file, or in a file the
// change deletes or shrinks: a pass that moves an old function into a file of its own isn't held up, and older code
// waits for its area's pass. The base counts as Prettier writes it, as the change's own files are, so a pass that only
// formats old code crosses nothing.
export async function crossedLimits(
  tools: Tools,
  root: string,
  base: string,
  changes: Change[],
  linted: ESLint.LintResult[],
) {
  const atBase = await Promise.all(changes.map(change => sizesAtBase(tools, root, base, change)));
  const now = await Promise.all(changes.map(change => sizesNow(tools, root, change, linted)));
  const lines = (text: string) => text.split('\n').length;
  const movedFrom = changes.map((_, i) => {
    const before = atBase[i];
    return !!before && (!now[i] || lines(now[i].text) < lines(before.text));
  });
  const oldFunctions = atBase.flatMap((b, i) => (b ? b.longFunctions.map(f => ({ name: f.name, index: i })) : []));
  const old = (name: string, index: number) =>
    oldFunctions.some(f => f.name === name && (f.index === index || movedFrom[f.index]));
  return now.flatMap((sizes, index) => {
    if (!sizes) return [];
    const longFile = sizes.longFile && !atBase[index]?.longFile ? [sizes.longFile] : [];
    return [...longFile, ...sizes.longFunctions.filter(f => !old(f.name, index))].map(m => ({
      path: changes[index].path,
      line: m.line,
      text: `${m.message} (${m.ruleId}): split it by concern (CODE_STYLE.md, "Size limits")`,
    }));
  });
}

// A touched file's sizes as it was at the base: code linted by today's rules under its name today (baseLint)
async function sizesAtBase(tools: Tools, root: string, base: string, change: Change) {
  if (!change.basePath || !SIZED.test(change.basePath)) return null;
  const path = change.path || change.basePath;
  if (SCRIPT.test(change.basePath)) {
    return scriptSizes(path, git(root, 'show', `${base}:${change.basePath}`)).catch(err => unreadableBase(err, change));
  }
  const before = await baseLint(tools, root, base, change);
  return { text: before.text, ...codeSizes(tools, path, before.text, before.messages) };
}

// A Python file Python couldn't parse at the base has no sizes there to keep: it's measured as a new file, saying so.
// Any other failure still stops the gates.
function unreadableBase(err: unknown, change: Change) {
  if (!(err instanceof UnreadablePython)) throw err;
  console.log(`${change.basePath} at the base: ${err.message}; measured as a new file`);
  return null;
}

// A touched file's sizes now: code by ESLint's findings on it
async function sizesNow(tools: Tools, root: string, change: Change, linted: ESLint.LintResult[]) {
  if (!change.path || !SIZED.test(change.path)) return null;
  const text = readFileSync(join(root, change.path), 'utf8');
  if (SCRIPT.test(change.path)) return scriptSizes(change.path, text);
  const result = linted.find(r => r.filePath === join(root, change.path))!;
  return { text, ...codeSizes(tools, change.path, text, result.messages) };
}

const codeSizes = (tools: Tools, path: string, text: string, messages: Linter.LintMessage[]) => ({
  longFile: messages.find(m => m.ruleId === 'max-lines' && m.severity === 2) ?? null,
  longFunctions: longFunctions(tools, path, () => text, messages),
});

// A file as it was at the base, formatted unless the change left it unformatted, and linted by today's rules under its
// name today
async function baseLint(tools: Tools, root: string, base: string, change: Change) {
  const path = change.path || change.basePath!;
  const options = { ...(await tools.prettier.resolveConfig(join(root, path))), filepath: path };
  const asItWas = git(root, 'show', `${base}:${change.basePath}`);
  const keptUnformatted = change.path && !(await tools.prettier.check(readFileSync(join(root, path), 'utf8'), options));
  const text = keptUnformatted ? asItWas : await tools.prettier.format(asItWas, options);
  const [result] = await tools.eslint.lintText(text, { filePath: join(root, path) });
  return { text, messages: result.messages };
}

// ESLint's long-function findings, each with the name of the function it points at
function longFunctions(tools: Tools, path: string, text: () => string, messages: Linter.LintMessage[]) {
  const found = messages.filter(m => m.ruleId === 'max-lines-per-function' && m.severity === 2);
  if (!found.length) return [];
  const heads = functionHeads(tools.typescript, path, text());
  return found.map(m => {
    const onLine = heads.filter(h => h.line === m.line);
    const closest = onLine.sort((a, b) => Math.abs(a.column - m.column) - Math.abs(b.column - m.column))[0];
    return { ...m, name: closest?.name ?? `(line ${m.line})` };
  });
}

// Every function's head, where ESLint reports a long one (an arrow at its =>, a member at its key, any other at its
// start), and the name it goes by: its own, the variable, property or class member it's assigned to, or for a callback,
// what it's passed to within its enclosing function.
function functionHeads(ts: typeof TypeScript, path: string, text: string) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const heads: { line: number; column: number; name: string }[] = [];
  const visit = (node: TypeScript.Node, enclosing: string) => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const name = functionName(ts, node, enclosing);
      const parent = node.parent;
      const headNode = ts.isArrowFunction(node)
        ? node.equalsGreaterThanToken
        : ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)
          ? parent
          : node;
      const head = file.getLineAndCharacterOfPosition(headNode.getStart(file));
      heads.push({ line: head.line + 1, column: head.character + 1, name });
      enclosing = name;
    }
    ts.forEachChild(node, child => visit(child, enclosing));
  };
  visit(file, '');
  return heads;
}

function functionName(ts: typeof TypeScript, node: TypeScript.SignatureDeclaration, enclosing: string): string {
  const parent = node.parent;
  const nameOf = (name: TypeScript.Node) => (ts.isStringLiteral(name) ? name.text : name.getText());
  const member = (name: string) => (ts.isClassLike(parent) && parent.name ? `${parent.name.text}.${name}` : name);
  if (ts.isConstructorDeclaration(node)) return member('constructor');
  if (node.name) return member(nameOf(node.name));
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    return nameOf(parent.name);
  if (ts.isBinaryExpression(parent)) return parent.left.getText();
  if (ts.isCallExpression(parent)) return `${enclosing || '(top)'}: callback to ${parent.expression.getText()}`;
  if (ts.isExportAssignment(parent)) return 'default';
  return `${enclosing || '(top)'}: (anonymous)`;
}

// A Python or shell file measured as ESLint measures code, in ESLint's words: its lines, and for Python each function's
// from its def to its last line (Python's own ast, spans.py). Its tests aren't held. The override is a comment that says
// why, as ESLint's disable comments do: `# max-lines -- <why>` on a line of its own for the file, `#
// max-lines-per-function -- <why>` on the line above a function (above its decorators).
export async function scriptSizes(path: string, text: string): Promise<Sizes> {
  if (SCRIPT_TEST.test(path)) return { text, longFile: null, longFunctions: [] };
  // (imported once the tools are linked in: the config imports ESLint's plugins)
  const { SIZE_LIMITS } = await import('../../eslint.config.js');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const allowed = (rule: string, line?: string) => !!line?.match(new RegExp(`^\\s*# ${rule} -- \\S`));
  const fileMax = SIZE_LIMITS.file,
    functionMax = SIZE_LIMITS.function;
  const longFile =
    lines.length > fileMax && !lines.some(line => allowed('max-lines', line))
      ? {
          line: fileMax + 1,
          message: `File has too many lines (${lines.length}). Maximum allowed is ${fileMax}.`,
          ruleId: 'max-lines',
        }
      : null;
  if (!path.endsWith('.py')) return { text, longFile, longFunctions: [] };
  const longFunctions = functionSpans(path, text)
    .map(f => ({ ...f, length: f.end - f.line + 1 }))
    .filter(f => f.length > functionMax && !allowed('max-lines-per-function', lines[f.first - 2]))
    .map(f => ({
      name: f.name,
      line: f.line,
      message: `Function '${f.name}' has too many lines (${f.length}). Maximum allowed is ${functionMax}.`,
      ruleId: 'max-lines-per-function',
    }));
  return { text, longFile, longFunctions };
}

// Python couldn't parse a file's text: spans.py's UNREADABLE exit
const UNREADABLE = 3;
class UnreadablePython extends Error {}

// A Python file's functions (spans.py). One Python can't parse stops the gates, saying which.
function functionSpans(path: string, text: string) {
  const run = spawnSync('python3', ['-I', join(import.meta.dirname, 'spans.py')], { input: text, encoding: 'utf8' });
  if (run.error) throw run.error;
  const why = run.stderr.trim().split('\n').at(-1);
  if (run.status === UNREADABLE) throw new UnreadablePython(`${path}: Python can't read it: ${why}`);
  if (run.status !== 0) throw new Error(`${path}: spans.py failed: ${why}`);
  return JSON.parse(run.stdout) as { name: string; line: number; first: number; end: number }[];
}
