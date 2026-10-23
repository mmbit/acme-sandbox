// The readability count the weekly review compares week on week, per area (CODE_STYLE.md, the code-quality routine).
// node shared/readability/count.ts [--list <measure>] [<area or path prefix>...]   (after npm ci at the repo root)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Node, SourceFile } from 'typescript';
import { areaOf, git, gitFiles, linkModules, TOOLS_HOME } from '../gates/repo.ts';

const FILE_LIMIT = 400;
const FUNCTION_LIMIT = 50;
const LINE_LIMIT = 120;
const OPENING_LIMIT = 3; // one line on what the file is for, wrapped once or twice
const COPY_WINDOW = 6; // significant lines in a row that make a copy
const COPY_MIN_CHARS = 150; // without spaces, so six lines of closing braces aren't one

const CODE = /\.(ts|js|mjs|cjs|py|sh)$/;
const SCRIPT = /\.(ts|js|mjs|cjs)$/;
const TEST = /\.test\.(ts|js|mjs)$|(^|\/)test_[^/]*\.(py|sh)$|-check\.mjs$/;
const ROOTS = /^(platform|infra|shared|kits|products|theme|template)\//;

// One pattern from its alternatives, a line each
const anyOf = (flags: string, ...alternatives: RegExp[]) =>
  new RegExp(alternatives.map(a => a.source).join('|'), flags);

const MONEY = anyOf(
  '',
  /style:\s*['"]currency['"]/,
  /toLocaleString\([^)]*FractionDigits/,
  /\/\s*100\)?\.toFixed\(2\)/,
  /€\$\{|\$\{[^}]*\}\s?€/,
);
const DATES = anyOf(
  '',
  /Intl\.DateTimeFormat|\.toLocale(Date|Time)String\(/,
  /toISOString\(\)\.slice\(|get(UTC)?Month\(\) \+ 1/,
);
const HAND_ROUTING = anyOf(
  '',
  /\b(pathname|path|url|req\.url|self\.path)\s*===?\s*['"`]\/\w/,
  /\b(pathname|path|url|self\.path)\.(startsWith|startswith)\(['"`]\/\w/,
  /\.match\(\/\^\\\//,
  /\bmethod\s*===\s*['"](GET|POST|PUT|DELETE|PATCH)/,
);
const HISTORY = anyOf(
  'i',
  /\b(jobs?|cards?|PRs?|pull requests?|requests?|rounds?|items?)\s+#\d+|\bcalls?\s+#?\d+/,
  /\(#\d+\)/,
);
const FOUNDATION_TAG = /company: job #\d+, not upstream yet/;
const READS_SOURCE = anyOf(
  '',
  /\b(readFileSync|readFile|open)\([^;\n]*\.(ts|js|mjs|cjs|py|sh|html|css)['"`]/,
  /(\.ts|\.js|\.mjs|\.py)['"`][^;\n]*,\s*['"]utf-?8['"]\)/,
);
const SPY = /\bmock\.(method|fn|module)\(|\bmock\.patch|@patch\(|\bMagicMock\(/;

const MEASURES = {
  files: 'code files',
  lines: 'lines',
  longFiles: `files past ${FILE_LIMIT} lines`,
  longFunctions: `functions past ${FUNCTION_LIMIT} lines`,
  longLines: `lines past ${LINE_LIMIT} columns`,
  squeezed: 'squeezed control flow',
  commentShare: 'comment lines, % of lines',
  longOpenings: `openings past ${OPENING_LIMIT} lines`,
  commentHeavy: 'files more comment than code',
  history: 'comments telling history',
  copies: 'lines copied from another file',
  money: 'money formatting by hand',
  dates: 'date formatting by hand',
  handRouting: 'routing by string matching',
  readsSource: 'tests reading source text',
  spies: 'mocks and spies in tests',
} as const;
type Measure = keyof typeof MEASURES;
const TABLES: Record<string, Measure[]> = {
  'Size and shape': ['files', 'lines', 'longFiles', 'longFunctions', 'longLines', 'squeezed'],
  Comments: ['commentShare', 'longOpenings', 'commentHeavy', 'history'],
  'Copies and tests': ['copies', 'money', 'dates', 'handRouting', 'readsSource', 'spies'],
};
type Finding = { path: string; line: number; text: string };
type Token = { line: number; text: string }; // by the line it starts on
// asWritten: compared as written, whatever it holds: a line inside a literal, or any line of shell
type CopyLine = { line: number; tokens: string[]; asWritten: boolean };
type FileCount = {
  path: string;
  area: string;
  lines: number;
  commentLines: number;
  copyLines: CopyLine[]; // the lines the copy count compares, comments aside
  findings: Partial<Record<Measure, Finding[]>>;
};

const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
const args = process.argv.slice(2);
const listed = args.includes('--list') ? (args[args.indexOf('--list') + 1] as Measure) : null;
const prefixes = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--list');

linkModules(root, TOOLS_HOME, root);
const ts = (await import('typescript')).default;
const prettier = await import('prettier');

const paths = await inScope();
const counts = paths.map(countFile);
countCopies(counts);
if (listed) printFindings(listed);
else printTable();

// ---- which files count

// The code the gates hold (Prettier's ignore file says what they leave out), Python and shell included
async function inScope() {
  const ignorePath = join(root, '.prettierignore');
  const candidates = gitFiles(root, 'ls-files')
    .filter(p => ROOTS.test(p) && CODE.test(p) && !p.includes('node_modules/'))
    .filter(p => !prefixes.length || prefixes.some(prefix => p.startsWith(prefix)));
  const infos = await Promise.all(candidates.map(p => prettier.getFileInfo(join(root, p), { ignorePath })));
  return candidates.filter((_, i) => !infos[i].ignored);
}

function countFile(path: string): FileCount {
  const text = readFileSync(join(root, path), 'utf8');
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  const count: FileCount = {
    path,
    area: areaOf(path),
    lines: lines.length,
    commentLines: 0,
    copyLines: [],
    findings: {},
  };
  const add = (measure: Measure, line: number, found: string) =>
    (count.findings[measure] ??= []).push({ path, line, text: found.trim().slice(0, 100) });

  if (lines.length > FILE_LIMIT) add('longFiles', 1, `${lines.length} lines`);
  const source = SCRIPT.test(path) ? parseScript(path, text) : null;
  const comments = source ? scriptShape(source, text, add) : hashCommentLines(lines, add);
  const python = path.endsWith('.py') ? pythonShape(path) : null;
  for (const { line, length, name } of python?.functions ?? []) add('longFunctions', line, `${length} lines: ${name}`);
  if (source) count.copyLines = tokenLines(scriptTokens(source));
  else if (python) count.copyLines = tokenLines(python.tokens);
  else count.copyLines = lines.map((text, i) => ({ line: i + 1, tokens: [text], asWritten: true }));
  const isTest = TEST.test(path);
  const handWritten = (engine: string) => !isTest && !path.startsWith(engine);
  const measured: { measure: Measure; pattern: RegExp; applies: boolean }[] = [
    { measure: 'money', pattern: MONEY, applies: handWritten('shared/format/') },
    { measure: 'dates', pattern: DATES, applies: handWritten('shared/format/') },
    { measure: 'handRouting', pattern: HAND_ROUTING, applies: handWritten('shared/routes/') },
    { measure: 'readsSource', pattern: READS_SOURCE, applies: isTest },
    { measure: 'spies', pattern: SPY, applies: isTest },
  ];
  for (const [i, line] of lines.entries()) {
    if (line.length > LINE_LIMIT) add('longLines', i + 1, `${line.length} columns`);
    if (comments.has(i + 1)) continue;
    for (const { measure, pattern, applies } of measured) if (applies && pattern.test(line)) add(measure, i + 1, line);
  }
  count.commentLines = comments.size;
  const codeLines = lines.filter((line, i) => line.trim() && !comments.has(i + 1)).length;
  if (comments.size > codeLines) add('commentHeavy', 1, `${comments.size} comment lines, ${codeLines} of code`);
  return count;
}

// ---- JavaScript and TypeScript, read by TypeScript's parser

function parseScript(path: string, text: string) {
  const kind = path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

// Functions, squeezed blocks and comments in a script; returns the lines that hold only a comment, each with its text
function scriptShape(source: SourceFile, text: string, add: (m: Measure, line: number, text: string) => void) {
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const comments = new Map<number, string>();
  const seen = new Set<number>();
  const codeWithoutComments = text.split('');

  const visit = (node: Node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const comment = text.slice(range.pos, range.end);
      const first = lineOf(range.pos);
      for (let pos = range.pos; pos < range.end; pos++) if (text[pos] !== '\n') codeWithoutComments[pos] = ' ';
      for (let line = first; line <= lineOf(range.end - 1); line++) comments.set(line, comment);
      if (HISTORY.test(comment) && !FOUNDATION_TAG.test(comment)) add('history', lineOf(range.pos), comment);
    }
    const start = lineOf(node.getStart(source));
    const end = lineOf(node.end);
    if (ts.isFunctionLike(node) && 'body' in node && node.body && end - start + 1 > FUNCTION_LIMIT)
      add('longFunctions', start, `${end - start + 1} lines: ${functionName(node, source)}`);
    if (squeezed(node, start, end)) add('squeezed', start, node.getText(source).split('\n')[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const codeLines = codeWithoutComments.join('').split('\n');
  for (const line of comments.keys()) if (codeLines[line - 1].trim()) comments.delete(line);
  const opening = openingLines(source, text, lineOf);
  if (opening > OPENING_LIMIT) add('longOpenings', 1, `${opening} lines`);
  return comments;
}

// Control flow a reader can't see the shape of: a block of two statements or more on one line, an if with its else
// or a try with its catch on one line
function squeezed(node: Node, start: number, end: number) {
  if (start !== end) return false;
  if (ts.isBlock(node)) return node.statements.length > 1;
  if (ts.isIfStatement(node)) return node.elseStatement !== undefined && ts.isIfStatement(node.parent) === false;
  return ts.isTryStatement(node);
}

function functionName(node: Node, source: SourceFile) {
  const named = node as Node & { name?: Node };
  if (named.name) return named.name.getText(source);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  if (ts.isCallExpression(parent)) return `a callback to ${parent.expression.getText(source).slice(0, 40)}`;
  return 'an unnamed function';
}

// The comment lines a file opens with, a shebang and tool directives aside
function openingLines(source: SourceFile, text: string, lineOf: (pos: number) => number) {
  const first = source.statements[0];
  const ranges = ts.getLeadingCommentRanges(text, first ? first.pos : source.endOfFileToken.pos) ?? [];
  const prose = ranges.filter(r => !/^\/[/*]\s*(eslint|@ts-|prettier-ignore|global\b)/.test(text.slice(r.pos, r.end)));
  return prose.reduce((sum, r) => sum + lineOf(r.end) - lineOf(r.pos) + 1, 0);
}

// ---- Python and shell, by their # comments

function hashCommentLines(lines: string[], add: (m: Measure, line: number, text: string) => void) {
  const comments = new Map<number, string>();
  for (const [i, line] of lines.entries())
    if (/^\s*#(?!!)/.test(line)) {
      comments.set(i + 1, line);
      if (HISTORY.test(line) && !FOUNDATION_TAG.test(line)) add('history', i + 1, line);
    }
  const firstCode = lines.findIndex((line, i) => line.trim() && !comments.has(i + 1) && !line.startsWith('#!'));
  const opening = [...comments.keys()].filter(line => line <= firstCode).length;
  if (opening > OPENING_LIMIT) add('longOpenings', 1, `${opening} lines`);
  return comments;
}

// Python's own parser lists the long functions, and its tokenizer the tokens, comments aside
function pythonShape(path: string): {
  functions: { line: number; length: number; name: string }[];
  tokens: Token[];
} {
  const script = `import ast, io, json, sys, tokenize
text = open(sys.argv[1]).read()
functions = [
    {"line": node.lineno, "length": node.end_lineno - node.lineno + 1, "name": node.name}
    for node in ast.walk(ast.parse(text))
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    and node.end_lineno - node.lineno + 1 > ${FUNCTION_LIMIT}
]
layout = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER}
tokens = [
    {"line": token.start[0], "text": token.string}
    for token in tokenize.generate_tokens(io.StringIO(text).readline)
    if token.type not in layout
]
print(json.dumps({"functions": functions, "tokens": tokens}))`;
  return JSON.parse(execFileSync('python3', ['-c', script, join(root, path)], { encoding: 'utf8' }));
}

// ---- the lines the copy count compares

// A script's tokens, comments aside: the leaves of its parse tree, so a regular expression or a template's piece is
// one token, as written
function scriptTokens(source: SourceFile) {
  const { FirstJSDocNode, LastJSDocNode } = ts.SyntaxKind;
  const tokens: Token[] = [];
  const visit = (node: Node) => {
    if (node.kind >= FirstJSDocNode && node.kind <= LastJSDocNode) return;
    const children = node.getChildren(source);
    const start = node.getStart(source);
    if (children.length) children.forEach(visit);
    else if (node.end > start) {
      const line = source.getLineAndCharacterOfPosition(start).line + 1;
      tokens.push({ line, text: node.getText(source) });
    }
  };
  visit(source);
  return tokens;
}

// Tokens by the line they start on. A token spanning lines (a template, a docstring) gives each line after its first
// a line of its own, as written: whitespace there is the literal's.
function tokenLines(tokens: Token[]) {
  const lines: CopyLine[] = [];
  for (const token of tokens) {
    const goesOn = lines.at(-1)?.line === token.line;
    token.text.split('\n').forEach((text, i) => {
      if (i === 0 && goesOn) lines.at(-1)!.tokens.push(text);
      else lines.push({ line: token.line + i, tokens: [text], asWritten: i > 0 });
    });
  }
  return lines;
}

// ---- copies across files

// A run of COPY_WINDOW significant lines that another file has too. Each line counts once. A line compared as
// written is significant whatever it holds, a line of code when it's more than a closing bracket or two and no import.
function countCopies(files: FileCount[]) {
  const windows = new Map<string, Set<string>>();
  const significant = new Map<string, CopyLine[]>();
  const isSignificant = (l: CopyLine) =>
    l.asWritten || (l.tokens.join('').length > 3 && l.tokens[0] !== 'import' && l.tokens[0] !== 'from');
  for (const file of files) {
    const kept = file.copyLines.filter(isSignificant);
    significant.set(file.path, kept);
    for (const key of windowKeys(kept)) {
      if (!key) continue;
      let matchingPaths = windows.get(key);
      if (!matchingPaths) {
        matchingPaths = new Set<string>();
        windows.set(key, matchingPaths);
      }
      matchingPaths.add(file.path);
    }
  }
  for (const file of files) {
    const kept = significant.get(file.path)!;
    const copied = new Map<number, string>();
    windowKeys(kept).forEach((key, i) => {
      const others = key ? [...windows.get(key)!].filter(p => p !== file.path) : [];
      if (others.length) for (const l of kept.slice(i, i + COPY_WINDOW)) copied.set(l.line, others[0]);
    });
    file.findings.copies = [...copied].map(([line, other]) => ({ path: file.path, line, text: `also in ${other}` }));
  }
}

// Each window's key, its lines' tokens, null for a window too short to count
function windowKeys(kept: CopyLine[]) {
  const keys: (string | null)[] = [];
  for (let i = 0; i + COPY_WINDOW <= kept.length; i++) {
    const window = kept.slice(i, i + COPY_WINDOW).map(l => l.tokens);
    const chars = window.flat().join('').replace(/\s/g, '').length;
    keys.push(chars < COPY_MIN_CHARS ? null : createHash('sha1').update(JSON.stringify(window)).digest('hex'));
  }
  return keys;
}

// ---- the report

function printTable() {
  const areas = [...new Set(counts.map(c => c.area))].sort();
  for (const [title, measures] of Object.entries(TABLES)) {
    const header = ['area', ...measures.map(m => MEASURES[m])];
    const areaRows = areas.map(area => {
      const areaCounts = counts.filter(c => c.area === area);
      return rowOf(area, measures, areaCounts);
    });
    const rows = [...areaRows, rowOf('all', measures, counts)];
    console.log(`\n### ${title}\n`);
    console.log(`| ${header.join(' | ')} |`);
    console.log(`|${header.map(() => '---').join('|')}|`);
    for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  }
}

function rowOf(area: string, measures: Measure[], files: FileCount[]) {
  const sum = (of: (file: FileCount) => number) => files.reduce((total, file) => total + of(file), 0);
  const lines = sum(f => f.lines);
  const value = (measure: Measure) => {
    if (measure === 'files') return files.length;
    if (measure === 'lines') return lines;
    if (measure === 'commentShare') return lines && Math.round((100 * sum(f => f.commentLines)) / lines);
    return sum(f => f.findings[measure]?.length ?? 0);
  };
  return [area, ...measures.map(value)];
}

function printFindings(measure: Measure) {
  if (!(measure in MEASURES)) throw new Error(`no measure ${measure}: one of ${Object.keys(MEASURES).join(', ')}`);
  for (const file of counts)
    for (const f of file.findings[measure] ?? []) console.log(`${f.path}:${f.line}  ${f.text}`);
}
