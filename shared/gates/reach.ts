// The files a change can reach, for the gates' type check (gates.ts newTypeErrors): the files it changes and every file
// that imports one, and theirs in turn, at the base and now. A file's type errors come from it and what it imports, so
// the rest can't have one the change made, and isn't checked.
//
// It's what the type check holds: a program over the whole repo held ~1.3 GB (2,413 source files), and the check builds
// two, one at the base and one now; a job's closing gates held ~2 GB of a worker every job's memory shares. A change to
// a leaf file now checks a few hundred source files (~170 MB), one to the coordinator's jobs.ts ~570 files (~920 MB).
//
// An import is any module the file names (ts.preProcessFile), or any quoted relative path in it that resolves to a file
// (a JSDoc import() type in a .js file, which preProcessFile skips): one too many costs a little memory, one missed
// would let an error by. A file that declares globals (a script, `declare global`, `declare module '...'`) is read by
// every file of the program: one the change touches reaches them all (undefined: check the whole program), the others
// are always checked beside what's reached, as the whole program would see them.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CompilerOptions } from 'typescript';

type TS = typeof import('typescript');
// One side of the change, at the base or now: its folder, its code files and the whole check's roots (relative).
export type Side = { dir: string; files: string[]; roots: string[] };

const CODE = /\.(ts|js|mjs|cjs)$/;
const RELATIVE = /['"`](\.\.?\/[^'"`\s]+)['"`]/g;

// Each side's roots for the type check, or undefined: the whole program
export function reach(ts: TS, options: CompilerOptions, sides: Side[], changed: string[]): string[][] | undefined {
  const importers = new Map<string, Set<string>>();
  const globals = sides.map(side => {
    const imports = importsOf(ts, options, side);
    for (const [file, targets] of imports)
      for (const target of targets) importers.set(target, (importers.get(target) ?? new Set()).add(file));
    const read = new Set(side.roots);
    for (const file of read) for (const target of imports.get(file) ?? []) read.add(target);
    return [...read].filter(file => declaresGlobals(ts, file, readFileSync(join(side.dir, file), 'utf8')));
  });
  if (changed.some(path => globals.some(files => files.includes(path)))) return undefined;
  const reached = new Set(changed);
  for (const path of reached) for (const importer of importers.get(path) ?? []) reached.add(importer);
  return sides.map((side, i) => [...new Set([...side.roots.filter(file => reached.has(file)), ...globals[i]])]);
}

// Each code file's imports among the side's own files (a package's are never the change's)
function importsOf(ts: TS, options: CompilerOptions, { dir, files }: Side) {
  const cache = ts.createModuleResolutionCache(dir, name => name, options);
  const imports = new Map<string, Set<string>>();
  for (const file of files.filter(f => CODE.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const named = ts.preProcessFile(text, true, true).importedFiles.map(i => i.fileName);
    const specifiers = new Set([...named, ...[...text.matchAll(RELATIVE)].map(m => m[1])]);
    const targets = new Set<string>();
    for (const specifier of specifiers) {
      const found = ts.resolveModuleName(specifier, join(dir, file), options, ts.sys, cache).resolvedModule;
      const path = found && !found.isExternalLibraryImport && relative(dir, found.resolvedFileName);
      if (path && !path.startsWith('..')) targets.add(path);
    }
    imports.set(file, targets);
  }
  return imports;
}

function declaresGlobals(ts: TS, file: string, text: string) {
  const source = ts.createSourceFile(file, text, {
    languageVersion: ts.ScriptTarget.Latest,
    jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
  });
  if (!ts.isExternalModule(source)) return true;
  return source.statements.some(
    s => ts.isModuleDeclaration(s) && (!!(s.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(s.name)),
  );
}
