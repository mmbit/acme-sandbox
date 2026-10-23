// The size limits a change crosses (CODE_STYLE.md, "Size limits"): ESLint's max-lines and max-lines-per-function, judged
// by what the change makes long, since they report on a line the change may never touch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ESLint, Linter } from 'eslint';
import type * as Prettier from 'prettier';
import type TypeScript from 'typescript';
import { git } from './repo.ts';

const CODE = /\.(ts|js|mjs|cjs)$/;
export const SIZE_RULES = new Set(['max-lines', 'max-lines-per-function']);

type Change = { path: string; basePath: string | null };
type Tools = { eslint: ESLint; prettier: typeof Prettier; typescript: typeof TypeScript };

// The changes as the size limits read them: each side only where the gates hold it (Prettier's ignore file, read by
// today's rules), so a file ignored at the base counts as new and one ignored now only lends its old functions
export async function sizedChanges<C extends Change>(tools: Tools, root: string, changes: C[], kept: Set<string>) {
  const ignorePath = join(root, '.prettierignore');
  const basePaths = changes.flatMap(c => (c.basePath && CODE.test(c.basePath) ? [c.basePath] : []));
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
  now: ESLint.LintResult[],
) {
  const atBase = await Promise.all(changes.map(change => baseLint(tools, root, base, change)));
  const textNow = (change: Change) => readFileSync(join(root, change.path), 'utf8');
  const lines = (text: string) => text.split('\n').length;
  const movedFrom = changes.map((change, i) => {
    const before = atBase[i];
    return !!before && (!change.path || lines(textNow(change)) < lines(before.text));
  });
  const oldFunctions = atBase.flatMap((b, i) => {
    return b ? longFunctions(tools, b.path, () => b.text, b.messages).map(f => ({ name: f.name, index: i })) : [];
  });
  const old = (name: string, index: number) =>
    oldFunctions.some(f => f.name === name && (f.index === index || movedFrom[f.index]));
  return now.flatMap(result => {
    const index = changes.findIndex(c => c.path && join(root, c.path) === result.filePath);
    const path = changes[index].path;
    const wasLong = atBase[index]?.messages.some(m => m.ruleId === 'max-lines');
    const longFile = result.messages.filter(m => m.ruleId === 'max-lines' && m.severity === 2 && !wasLong);
    const longNow = longFunctions(tools, path, () => textNow(changes[index]), result.messages);
    return [...longFile, ...longNow.filter(f => !old(f.name, index))].map(m => ({
      path,
      line: m.line,
      text: `${m.message} (${m.ruleId}): split it by concern (CODE_STYLE.md, "Size limits")`,
    }));
  });
}

// A touched file as it was at the base, formatted unless the change left it unformatted, and linted by today's rules
// under its name today
async function baseLint(tools: Tools, root: string, base: string, change: Change) {
  if (!change.basePath || !CODE.test(change.basePath)) return null;
  const path = change.path || change.basePath;
  const options = { ...(await tools.prettier.resolveConfig(join(root, path))), filepath: path };
  const asItWas = git(root, 'show', `${base}:${change.basePath}`);
  const keptUnformatted = change.path && !(await tools.prettier.check(readFileSync(join(root, path), 'utf8'), options));
  const text = keptUnformatted ? asItWas : await tools.prettier.format(asItWas, options);
  const [result] = await tools.eslint.lintText(text, { filePath: join(root, path) });
  return { path, text, messages: result.messages };
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
