// What the gates and the tests both read of the repo: git, its files as git stores them, its tree as it is now, its
// areas, and the tools' node_modules linked in from the worker image's copy.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const TOOLS_HOME = process.env.GATES_HOME ?? '/opt/gates'; // the worker image's copy of the tools, laid out as the repo

export function git(cwd: string, ...gitArgs: string[]) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
}

// A list of paths exactly as git stores them: without -z, git quotes a name with a space or a non-ASCII letter.
export function gitFiles(cwd: string, command: string, ...gitArgs: string[]) {
  return git(cwd, command, '-z', ...gitArgs)
    .split('\0')
    .filter(Boolean);
}

// The tree of the repo's files as they are now, committed or not (except those git ignores), without changing its index.
export function workingTree(root: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tests-index-'));
  try {
    const index = join(dir, 'index');
    const original = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
    writeFileSync(index, readFileSync(original));
    const env = { ...process.env, GIT_INDEX_FILE: index };
    // Git must find same-second edits against the original index's timestamp before the newer copy stages them.
    const changed = new Set(gitFiles(root, 'diff-files', '--name-only'));
    if (changed.size) {
      const entries = gitFiles(root, 'ls-files', '--stage').filter(entry =>
        changed.has(entry.slice(entry.indexOf('\t') + 1)),
      );
      execFileSync('git', ['update-index', '-z', '--index-info'], {
        cwd: root,
        env,
        input: `${entries.join('\0')}\0`,
      });
    }
    execFileSync('git', ['add', '-A'], { cwd: root, env });
    return execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Links each package's node_modules (the packages `root` has) from one copy of the repo into another, where the other
// has none.
export function linkModules(root: string, from: string, to: string) {
  const packages = gitFiles(root, 'ls-files', '-co', '--exclude-standard', 'package.json', '*/package.json');
  for (const dir of packages.map(dirname)) {
    const source = join(from, dir, 'node_modules');
    const target = join(to, dir, 'node_modules');
    if (!existsSync(source) || !existsSync(join(to, dir)) || lstatSync(target, { throwIfNoEntry: false })) continue;
    try {
      symlinkSync(source, target);
    } catch (err) {
      // the gates and the tests start side by side in the worker, and either may link it first
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

// The package an import of `specifier` in `file` names, when the nearest package.json under `dir` declares it and no
// node_modules from the file up has it; else null (a relative path, node's own, a package nobody declared, or one that
// is there, whose subpath or export is what's missing).
export function missingPackage(dir: string, file: string, specifier: string) {
  if (/^[./]|^node:/.test(specifier)) return null;
  const name = specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');
  for (let at = dirname(file); at.startsWith(dir); at = dirname(at)) {
    const manifest = join(at, 'package.json');
    if (!existsSync(manifest)) continue;
    const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    return (name in dependencies || name in devDependencies) && !installed(dirname(file), name) ? name : null;
  }
  return null;
}

// as node looks for a package: in each node_modules from `from` up to the root
function installed(from: string, name: string): boolean {
  if (existsSync(join(from, 'node_modules', name))) return true;
  return dirname(from) !== from && installed(dirname(from), name);
}

// The area a path is in, as the refactoring passes take them: platform/<x>, shared/<x>, kits/<x>, products/<x>, or a
// folder at the top (infra), or the root's own files ('.').
export function areaOf(path: string) {
  const parts = path.split('/');
  if (parts.length === 1) return '.';
  const depth = /^(platform|shared|kits|products)$/.test(parts[0]) && parts.length > 2 ? 2 : 1;
  return parts.slice(0, depth).join('/');
}

export function plural(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
