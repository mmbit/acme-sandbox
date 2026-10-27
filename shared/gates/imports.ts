// A module's named imports name what its target exports. The type check doesn't read HQ's browser modules (they import
// by URL: /__review/ring.js is shared/review/ring.js), so a change that drops an export another file still imports
// passes it, and the browser refuses the whole page: HQ never assembles. Checked whenever the change touches a .js or
// .mjs file, on every import from or into what it touches, as the files stand now.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import type TS from 'typescript';
import type { Change, Problem } from './output.ts';
import { gitFiles } from './repo.ts';

const MODULE = /\.(js|mjs)$/;
// (what a module exports by name: a JSON file has only its default, and a package's CommonJS what Node finds in it)
const CODE = /^(?!.*\/node_modules\/).*\.(js|mjs|ts)$/;

export function importProblems(ts: typeof TS, root: string, changes: Change[]): Problem[] {
  const touched = new Set(changes.flatMap(c => [c.path, c.basePath]).filter(p => p && MODULE.test(p)) as string[]);
  if (!touched.size) return [];
  const names = [...new Set([...touched].map(p => basename(p)))];
  const parsed = new Map<string, TS.SourceFile | null>();
  const parse = (path: string) => {
    if (!parsed.has(path)) {
      const file = join(root, path);
      parsed.set(
        path,
        existsSync(file) ? ts.createSourceFile(path, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true) : null,
      );
    }
    return parsed.get(path)!;
  };
  const files = gitFiles(root, 'ls-files', '-co', '--exclude-standard', '*.js', '*.mjs').filter(p =>
    existsSync(join(root, p)),
  );
  // (a file that names none of the touched ones by name can't import them: it isn't parsed)
  const importers = files.filter(
    p => touched.has(p) || names.some(n => readFileSync(join(root, p), 'utf8').includes(n)),
  );
  return importers.flatMap(path =>
    importsOf(ts, parse(path)!).flatMap(({ spec, wanted, line }): Problem[] => {
      const target = resolve(root, path, spec);
      if (!target || !CODE.test(target) || !(touched.has(path) || touched.has(target))) return [];
      const at = parse(target);
      // (a file the change removes; one that was never there is served from somewhere this doesn't know)
      if (!at) return touched.has(target) ? [{ path, line, text: `imports ${spec}, and ${target} isn't there` }] : [];
      const has = exportsOf(ts, root, target, parse, new Set());
      if (!has) return [];
      return wanted
        .filter(name => !has.has(name))
        .map(name => ({ path, line, text: `imports ${name} from ${spec}, which ${target} doesn't export` }));
    }),
  );
}

// What a module's static imports and re-exports ask for by name ('default' for a default import)
function importsOf(ts: typeof TS, sf: TS.SourceFile) {
  const found: { spec: string; wanted: string[]; line: number }[] = [];
  for (const s of sf.statements) {
    if (!(ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) || !s.moduleSpecifier) continue;
    if (!ts.isStringLiteral(s.moduleSpecifier)) continue;
    const wanted: string[] = [];
    if (ts.isImportDeclaration(s) && s.importClause && !s.importClause.isTypeOnly) {
      const { name, namedBindings } = s.importClause;
      if (name) wanted.push('default');
      if (namedBindings && ts.isNamedImports(namedBindings))
        wanted.push(...namedBindings.elements.filter(e => !e.isTypeOnly).map(e => (e.propertyName ?? e.name).text));
    }
    if (ts.isExportDeclaration(s) && !s.isTypeOnly && s.exportClause && ts.isNamedExports(s.exportClause))
      wanted.push(...s.exportClause.elements.map(e => (e.propertyName ?? e.name).text));
    const line = sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1;
    if (wanted.length) found.push({ spec: s.moduleSpecifier.text, wanted, line });
  }
  return found;
}

// The names a module exports, through its `export * from`s; null when one of those isn't a file here to read
function exportsOf(
  ts: typeof TS,
  root: string,
  path: string,
  parse: (path: string) => TS.SourceFile | null,
  seen: Set<string>,
): Set<string> | null {
  const names = new Set<string>();
  const sf = parse(path);
  if (!sf) return null;
  if (seen.has(path)) return names;
  seen.add(path);
  for (const s of sf.statements) {
    if (ts.isExportAssignment(s)) names.add('default');
    else if (ts.isExportDeclaration(s)) {
      if (s.exportClause && ts.isNamedExports(s.exportClause))
        s.exportClause.elements.forEach(e => names.add(e.name.text));
      else if (s.exportClause) names.add(s.exportClause.name.text);
      else if (s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
        const from = resolve(root, path, s.moduleSpecifier.text);
        const more = from && exportsOf(ts, root, from, parse, seen);
        if (!more) return null;
        more.forEach(n => n !== 'default' && names.add(n));
      }
    } else if (ts.canHaveModifiers(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.getModifiers(s)!.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default');
      else if (ts.isVariableStatement(s)) s.declarationList.declarations.forEach(d => bound(ts, d.name, names));
      else if ('name' in s && s.name && ts.isIdentifier(s.name as TS.Node)) names.add((s.name as TS.Identifier).text);
    }
  }
  return names;
}

function bound(ts: typeof TS, name: TS.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else name.elements.forEach(e => !ts.isOmittedExpression(e) && bound(ts, e.name, names));
}

// The file a specifier names: relative, or one of the paths HQ serves its shared modules at (/__review/x.js is
// shared/review/x.js, /x.js shared/x/x.js, /kits/<kit>/… a kit's hq/ folder, /shared/… itself). Anything else (a
// package, a URL, a path only a check's page serves) isn't checked.
function resolve(root: string, from: string, spec: string): string | null {
  if (spec.startsWith('.')) return normalize(join(dirname(from), spec));
  const served = [
    spec.replace(/^\/__review\//, 'shared/review/'),
    spec.replace(/^\/([a-z0-9-]+)\.js$/, 'shared/$1/$1.js'),
    spec.replace(/^\/kits\/([a-z0-9-]+)\//, 'kits/$1/hq/'),
    spec.replace(/^\/(kits|shared)\//, '$1/'),
  ].filter(p => p !== spec);
  return served.find(p => existsSync(join(root, p))) ?? null;
}
