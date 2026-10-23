// node --test shared/readability/count.test.ts   (needs the tools: npm ci at the repo root; makes a throwaway repo)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const repo = join(import.meta.dirname, '..', '..');
const COUNT = join(import.meta.dirname, 'count.ts');

// The count's output in a throwaway repo holding `files`
function count(files: Record<string, string>, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'readability-test-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    cpSync(join(repo, 'package.json'), join(dir, 'package.json'));
    cpSync(join(repo, '.prettierignore'), join(dir, '.prettierignore'));
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    return execFileSync('node', [COUNT, ...args], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The row of `area` in the table titled `title`, by column name
function row(output: string, title: string, area: string) {
  const table = output.split(`### ${title}`)[1].split('###')[0];
  const lines = table.split('\n').filter(line => line.startsWith('|'));
  const cells = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map(cell => cell.trim());
  const header = cells(lines[0]);
  const values = cells(lines.find(line => cells(line)[0] === area)!);
  return Object.fromEntries(header.map((name, i) => [name, values[i]]));
}

const lines = (n: number, text: (i: number) => string) => Array.from({ length: n }, (_, i) => text(i)).join('\n');
const sharedBlock = lines(
  6,
  i => `  const total${i} = order.lines.reduce((sum, line) => sum + line.priceCents * ${i}, 0);`,
);

// The same code spaced another way, and code that differs only inside its strings and templates
const respacedBlock = lines(6, i => `const total${i}=order.lines.reduce( (sum,line)=>sum+line.priceCents*${i},0 ) ;`);
const quoted = (space: string) =>
  lines(
    6,
    i =>
      `  const label${i} = order.lines.map(line => \`\${line.name}:${space}\${line.count / ${i}}\`)` +
      `.filter(text => /'/.test(text)).join(',${space}');`,
  );
const pythonBlock = (spaced: boolean) =>
  lines(6, i =>
    spaced
      ? `    total_${i} = sum(line.price_cents * ${i} for line in order.lines if line.name != "a b")`
      : `    total_${i}=sum( line.price_cents*${i} for line in order.lines if line.name!="a b" )`,
  );
const shellBlock = (space: string) =>
  lines(6, i => `echo "total ${i}:${space}$(wc -l < orders.txt) lines in the orders file" >> report.txt`);

// Literals spanning lines that differ only in their whitespace, and token runs that differ only at a boundary
const template = (indent: string) =>
  `export const page = \`\n${lines(6, i => `${indent}<li class="order-line">order line ${i} of the page</li>`)}\`;\n`;
const docstring = (indent: string) =>
  `def page():\n    """\n${lines(6, i => `${indent}order line ${i} of the page, as the page shows it`)}\n    """\n`;
const quotedHash = (word: string) =>
  `printf '%s\\n' '\n${lines(3, i => `order line ${i} of the page, as the page shows it`)}\n# ${word}\n` +
  `${lines(3, i => `order line ${i + 3} of the page, as the page shows it`)}\n'\n`;
const regexAfterCondition = (space: string) =>
  lines(6, i => `if (enabled${i}) /match${space}a b/.test(candidate) && console.log("order line ${i} matched");`);
const unicodeNames = (space: string) =>
  lines(6, i => `export const kind${i} = typeof${space}π${i} === "string" ? "order line ${i}" : "something else";`);

const longBody = lines(55, i => `  console.log(${i});`);
const squeezedBody = '  if (x) { a(); b(); } else { c(); }\n  try { a(); } catch { b(); }';

test('each area gets its long files and functions, squeezed control flow and copies', () => {
  const output = count({
    'products/shop/src/long.ts': `// One file\nexport function long() {\n${longBody}\n}\n${lines(400, () => '')}`,
    'products/shop/src/squeezed.ts': `// One file\nexport const f = (x: number) => {\n${squeezedBody}\n};\n`,
    'products/shop/src/a.ts': `// One file\nexport function a(order: any) {\n${sharedBlock}\n}\n`,
    'kits/boundary/a.ts': `${lines(400, i => `export const value${i} = ${i};`)}\n`,
    'kits/boundary/empty.ts': '',
    'kits/python/long.py': `def long():\n${lines(55, i => `    print(${i})`)}\n`,
    'kits/sale/b.ts': `// One file\nexport function b(order: any) {\n${sharedBlock}\n}\n`,
    'kits/spacing/a.ts': `export function respaced(order: any) {\n${respacedBlock}\n}\n`,
    'kits/literals/a.ts': `export function a(order: any) {\n${quoted(' ')}\n}\n`,
    'kits/literals/b.ts': `export function b(order: any) {\n${quoted('  ')}\n}\n`,
    'kits/pyspace/a.py': `def a(order):\n${pythonBlock(true)}\n`,
    'kits/pyspace/b.py': `def b(order):\n${pythonBlock(false)}\n`,
    'kits/shell/a.sh': `${shellBlock(' ')}\n`,
    'kits/shell/b.sh': `${shellBlock('  ')}\n`,
    'kits/template/a.ts': template('  '),
    'kits/template/b.ts': template('    '),
    'kits/docstring/a.py': docstring('    '),
    'kits/docstring/b.py': docstring('      '),
    'kits/quotedhash/a.sh': quotedHash('first'),
    'kits/quotedhash/b.sh': quotedHash('second'),
    'kits/shellcopy/a.sh': `${shellBlock('   ')}\n`,
    'kits/shellcopy/b.sh': `${shellBlock('   ')}\n`,
    'kits/regex/a.ts': `${regexAfterCondition(' ')}\n`,
    'kits/regex/b.ts': `${regexAfterCondition('  ')}\n`,
    'kits/unicode/a.ts': `${unicodeNames(' ')}\n`,
    'kits/unicode/b.ts': `${unicodeNames('')}\n`,
  });
  const shape = row(output, 'Size and shape', 'products/shop');
  assert.equal(shape['files past 400 lines'], '1');
  assert.equal(shape['functions past 50 lines'], '1');
  const boundary = row(output, 'Size and shape', 'kits/boundary');
  assert.equal(boundary.lines, '400');
  assert.equal(boundary['files past 400 lines'], '0');
  assert.equal(row(output, 'Size and shape', 'kits/python')['functions past 50 lines'], '1');
  // the if with its else, its two-statement block, and the try
  assert.equal(shape['squeezed control flow'], '3');
  assert.equal(row(output, 'Copies and tests', 'products/shop')['lines copied from another file'], '6');
  assert.equal(row(output, 'Copies and tests', 'kits/sale')['lines copied from another file'], '6');
  const copied = (area: string) => row(output, 'Copies and tests', area)['lines copied from another file'];
  assert.equal(copied('kits/spacing'), '6');
  assert.equal(copied('kits/pyspace'), '12');
  assert.equal(copied('kits/literals'), '0');
  assert.equal(copied('kits/shell'), '0');
  assert.equal(copied('kits/template'), '0');
  assert.equal(copied('kits/docstring'), '0');
  assert.equal(copied('kits/quotedhash'), '0');
  assert.equal(copied('kits/shellcopy'), '12');
  assert.equal(copied('kits/regex'), '0');
  assert.equal(copied('kits/unicode'), '0');
});

test('comments that tell history and long openings count, the foundation tag does not', () => {
  const output = count({
    'platform/hq/a.ts': '// What it is\n// for, in\n// four\n// lines\nexport const a = 1; // (job #12)\n',
    'platform/hq/ids.ts': '// job 3 ends\n// round 4 checks the merge\n// what the board said meanwhile\n',
    'products/shop/mixed.ts': '/* Prices */ /* Euros */ export const price = c => `€${(c / 100).toFixed(2)}`;\n',
    'platform/hq/b.ts': '// What b is for\n//\nexport const b = 1;\n',
  });
  const comments = row(output, 'Comments', 'platform/hq');
  assert.equal(comments['openings past 3 lines'], '1');
  assert.equal(comments['comments telling history'], '1');
  assert.equal(row(output, 'Comments', 'products/shop')['files more comment than code'], '0');
  assert.equal(row(output, 'Copies and tests', 'products/shop')['money formatting by hand'], '1');
});

test('money and dates formatted by hand count outside shared/format, and --list names where', () => {
  const files = {
    'products/shop/src/price.ts': '// Prices\nexport const euros = (c: number) => `€${(c / 100).toFixed(2)}`;\n',
    'products/shop/numbers.ts': 'export const count = n => n.toLocaleString("en");\n',
    'products/shop/dates.ts':
      'export const day = d => d.toLocaleDateString();\nexport const time = d => d.toLocaleTimeString();\n',
    'kits/web/routes.ts': 'export const get = method => method === "GET";\n',
    'shared/format/format.js': "// Money\nexport const day = d => new Intl.DateTimeFormat('en').format(d);\n",
  };
  const output = count(files);
  assert.equal(row(output, 'Copies and tests', 'all')['money formatting by hand'], '1');
  assert.equal(row(output, 'Copies and tests', 'all')['date formatting by hand'], '2');
  assert.equal(row(output, 'Copies and tests', 'kits/web')['routing by string matching'], '1');
  assert.match(count(files, '--list', 'money'), /^products\/shop\/src\/price\.ts:2 /);
});
