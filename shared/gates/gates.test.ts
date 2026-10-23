// node --test shared/gates/gates.test.ts   (needs the tools: npm ci at the repo root; each test makes a throwaway repo)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ON_HELPER, playedHq } from './fixture.ts';

const repo = join(import.meta.dirname, '..', '..');
const CONFIGS = [
  'package.json',
  'eslint.config.js',
  'tsconfig.json',
  '.prettierignore',
  'shared/gates/gates.ts',
  'shared/gates/lent.ts',
  'shared/gates/output.ts',
  'shared/gates/repo.ts',
  'shared/gates/sizes.ts',
  'shared/demo/renders.mjs',
];

// A repo with the gates and a base commit on main, then a branch whose changes are `after` (null deletes a file), run
// with `env` added and more arguments.
// stopAfterMs: the worker's time limit, a SIGTERM then
type Run = { tools?: boolean; env?: NodeJS.ProcessEnv; args?: string[]; stopAfterMs?: number };
function gates(before: Record<string, string>, after: Record<string, string | null>, how: Run = {}) {
  const { tools = true, env = {}, args = [], stopAfterMs } = how;
  const dir = mkdtempSync(join(tmpdir(), 'gates-test-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  const write = (files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git('rm', '-q', path);
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    }
  };
  git('init', '-q', '-b', 'main');
  for (const path of CONFIGS) cpSync(join(repo, path), join(dir, path), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  if (tools) symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  write(before);
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  write(after);
  git('add', '-A'); // as the worker has it: committed (renames are only found among tracked files)
  const run = spawnSync('node', ['shared/gates/gates.ts', '--base', 'main', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GATES_HOME: join(dir, 'none'), ...env },
    timeout: stopAfterMs,
    killSignal: 'SIGTERM',
  });
  return { status: run.status, out: run.stdout };
}

const messy = 'export function sum(a: number, b: number) { return a+b }\n';

test('a new file starts formatted, a formatted one stays so, an old messy one waits for its pass', () => {
  const { status, out } = gates(
    { 'lib/clean.ts': 'export const one = 1;\n', 'lib/old.ts': messy },
    {
      'lib/clean.ts': 'export const one   = 2;\n',
      'lib/old.ts': messy.replace('a+b', 'a+b+0'),
      'lib/new.js': 'let x=1\n',
    },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/clean\.ts: not formatted/);
  assert.match(out, /lib\/new\.js: not formatted/);
  assert.doesNotMatch(out, /lib\/old\.ts: not formatted/);
});

test('ESLint counts the lines a change adds, not the old ones around them', () => {
  const { status, out } = gates(
    { 'lib/a.ts': 'const oldUnused = 1;\nexport const a = 1;\n' },
    { 'lib/a.ts': 'const oldUnused = 1;\nexport const a = 1;\nconst newUnused = 2;\n' },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/a\.ts:3: 'newUnused'/);
  assert.doesNotMatch(out, /oldUnused/);
});

// A file of `n` lines of constants, and a function of `n` lines (its head and closing brace included), for the size
// limits' tests.
const constants = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `export const c${from + i} = ${from + i};\n`).join('');
const fn = (name: string, n: number) => `export function ${name}() {\n${'  console.log(1);\n'.repeat(n - 2)}}\n`;

test('a change that makes a file cross 400 lines fails; one that grows an already long file passes', () => {
  const { status, out } = gates(
    { 'lib/short.ts': constants(400), 'lib/long.ts': constants(450), 'lib/long.test.ts': constants(10) },
    {
      'lib/short.ts': constants(401),
      'lib/long.ts': constants(460),
      'lib/new.ts': constants(401),
      'lib/long.test.ts': constants(500),
    },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/short\.ts:401: File has too many lines \(401\).*\(max-lines\)/);
  assert.match(out, /lib\/new\.ts:401: .*\(max-lines\)/);
  assert.doesNotMatch(out, /long\.ts|long\.test\.ts/);
});

test('a function that grows past 50 lines or is new fails, wherever ESLint reports it; an old one moved or grown passes', () => {
  const caller = (body: string) => `const handler = () => {\n${body}};\nexport const run = [handler];\n`;
  const { status, out } = gates(
    {
      'lib/old.ts': fn('budget', 50) + fn('orders', 60) + fn('report', 70),
      'lib/routes.ts': caller('  console.log(1);\n'.repeat(48)),
    },
    {
      'lib/old.ts': fn('budget', 51) + fn('report', 80),
      'lib/orders.ts': fn('orders', 60),
      'lib/new.ts': fn('invoices', 51),
      'lib/routes.ts': caller('  console.log(1);\n'.repeat(49)),
    },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/old\.ts:1: Function 'budget' has too many lines \(51\).*\(max-lines-per-function\)/);
  assert.match(out, /lib\/new\.ts:1: Function 'invoices'/);
  assert.match(out, /lib\/routes\.ts:1: Arrow function has too many lines \(51\)/);
  assert.doesNotMatch(out, /orders|report/);
});

test("a new long function under an old one's name fails in another file, unless the change moved it out of there", () => {
  const { status, out } = gates(
    { 'lib/panel.ts': fn('render', 57) },
    { 'lib/panel.ts': fn('render', 57) + 'export const shown = true;\n', 'lib/other.ts': fn('render', 57) },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/other\.ts:1: Function 'render' has too many lines \(57\)/);
  assert.doesNotMatch(out, /lib\/panel\.ts/);
});

test('an ignored template edited beside ordinary code stays out of the size limits, and the code is still checked', () => {
  const { status, out } = gates(
    { 'lib/page.template.js': 'const T = {{T}};\n', 'lib/a.ts': 'export const a = 1;\n' },
    { 'lib/page.template.js': 'const T = {{T}};\nconst U = {{U}};\n', 'lib/a.ts': fn('long', 51) },
  );
  assert.equal(status, 1, out);
  assert.match(out, /lib\/a\.ts:1: Function 'long' has too many lines \(51\)/);
  assert.doesNotMatch(out, /template/);
});

test('a pass that only formats old code passes, though Prettier makes it longer', () => {
  // two statements a line, which Prettier puts on two: 330 lines become 660, the function's 32 become 62
  const old = (joint: string) =>
    Array.from({ length: 300 }, (_, i) => `export const a${i} = 1;${joint}export const b${i} = 2;\n`).join('') +
    `export function packed() {\n${`  console.log(1);${joint}  console.log(2);\n`.repeat(30)}}\n`;
  const { status, out } = gates({ 'lib/old.ts': old(' ') }, { 'lib/old.ts': old('\n') });
  assert.equal(status, 0, out);
});

test('a long function or file with a disable comment that says why passes', () => {
  const why = "// eslint-disable-next-line max-lines-per-function -- a page's markup, one template\n";
  const { status, out } = gates(
    { 'lib/page.ts': constants(10) },
    {
      'lib/page.ts': `/* eslint-disable max-lines -- a table of every postcode */\n${constants(410)}`,
      'lib/markup.ts': why + fn('markup', 80),
    },
  );
  assert.equal(status, 0, out);
});

test('a type error the change causes in a file it never touched fails it', () => {
  const { status, out } = gates(
    {
      'lib/sum.ts': 'export const sum = (a: number) => a;\n',
      'lib/use.ts': "import { sum } from './sum.ts';\nexport const one = sum(1);\n",
    },
    { 'lib/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n' },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/use\.ts:2: Expected 2 arguments, but got 1\. \(TS2554\)/);
});

test('type errors the base already had pass, in a renamed file too', () => {
  const broken = "export const bad: number = 'x';\n";
  const { status, out } = gates(
    { 'lib/old.ts': broken, 'lib/other.ts': 'export const other = 1;\n' },
    { 'lib/old.ts': null, 'lib/moved.ts': broken, 'lib/other.ts': 'export const other = 2;\n' },
  );
  assert.equal(status, 0, out);
});

test('an old type error whose union another file now prints in another order passes', () => {
  // the compiler prints a union's members in the order it first met them: a new file meeting 500 first turns the old
  // error's '1000 | 500' into '500 | 1000'
  const old = 'function f(size: 1000 | 500) {\n  return size;\n}\nconst n: number = 1;\nexport const g = f(n);\n';
  const { status, out } = gates({ 'lib/b.ts': old }, { 'lib/a.ts': 'export const sizes: (500 | 1000)[] = [500];\n' });
  assert.equal(status, 0, out);
});

test('a type error whose generic type changed fails, even with the same members in another order', () => {
  const error = (type: string) => `export const x: number = null as unknown as ${type};\n`;
  const { status, out } = gates(
    { 'lib/b.ts': error('string | Set<500 | 2000> | Promise<1000 | 3000>') },
    { 'lib/b.ts': error('string | Set<500 | 3000> | Promise<1000 | 2000>') },
  );
  assert.equal(status, 1, out);
  assert.match(out, /Set<500 \| 3000>/);
});

test("a browser dialog fails, in a page's inline scripts too, where nothing else is held", () => {
  const page = [
    '<html><body><p>alert(1)</p>',
    '<script src="/a.js"></script><script type="application/json">{"say": "confirm(2)"}</script>',
    '<script>let unused = undefinedName;</script>',
    '<script type="module">',
    "  if (confirm('Sure?')) go();",
    '</script>',
    '<!-- <script>alert(3)</script> -->',
    '<script data-label=">">confirm(4)</script>',
    '<script data-src="x">confirm(5)</script>',
    '<script type="text/ecmascript">confirm(6)</script>',
    "<script TYPE='application/ecmascript' data-note=' src=x'>confirm(7)</script >",
    '<script type="text/javascript" type="text/plain">confirm(8)</script>',
    '<script type="text/java&#115;cript">confirm(9)</script><script type="text&#47;javascript">confirm(10)</script>',
    '<script>confirm(11)</script foo>',
    '<script>if (</script></body></html>',
    '',
  ].join('\n');
  const { status, out } = gates(
    {},
    { 'lib/page.html': page, 'lib/a.js': "export const ask = () => window.prompt('Name?');\n" },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/page\.html:5: Unexpected confirm\. \(no-alert\)/);
  for (const line of [8, 9, 10, 11, 12, 13, 14])
    assert.match(out, new RegExp(`lib/page\\.html:${line}: Unexpected confirm\\. \\(no-alert\\)`));
  assert.match(out, /lib\/page\.html:15: Parsing error/);
  assert.match(out, /lib\/a\.js:1: Unexpected prompt\. \(no-alert\)/);
  assert.equal(out.match(/^lib\//gm)?.length, 11, out);
});

test('throwaway work is left out', () => {
  const { status } = gates({}, { 'products/_cycles/pitch/deck.js': 'var x=eval("1")\n' });
  assert.equal(status, 0);
});

test('without its tools the gates fail loudly, never pass', () => {
  const { status, out } = gates({}, { 'lib/a.ts': 'export const a = 1;\n' }, { tools: false });
  assert.equal(status, 2);
  assert.match(out, /could not run: .*npm ci/);
});

test('a path with a space is checked like any other', () => {
  const { status, out } = gates({}, { 'lib/new file.js': 'let x=1\n' });
  assert.equal(status, 1);
  assert.match(out, /lib\/new file\.js: not formatted/);
});

test("a removed line that starts with '-- ' is a line, not a file header", () => {
  const sql = (rows: string) => `export const sql = \`\n-- the table\n${rows}\`;\n`;
  const { status, out } = gates(
    { 'lib/db.ts': sql('-- old rows\nselect 1;\n') },
    { 'lib/db.ts': sql('select 2;\n'), 'lib/new.js': 'let x=1\n' },
  );
  assert.equal(status, 1, out);
  assert.match(out, /lib\/new\.js: not formatted/);
  assert.doesNotMatch(out, /could not run/);
});

test('deleting a file a caller still imports fails the type check', () => {
  const { status, out } = gates(
    {
      'lib/value.ts': 'export const value = 1;\n',
      'lib/use.ts': "import { value } from './value.ts';\nexport const two = value + 1;\n",
    },
    { 'lib/value.ts': null },
  );
  assert.equal(status, 1);
  assert.match(out, /lib\/use\.ts:1: .*\(TS2307\)/);
});

test("a package the change adds to its package.json, not yet in the image's packages, passes; an undeclared one or a missing subpath fails", () => {
  const manifest = (deps: object) => JSON.stringify({ name: 'app', type: 'module', dependencies: deps }) + '\n';
  const use = (name: string) => `import { decode } from '${name}';\nexport const text = String(decode('&amp;'));\n`;
  const added = gates(
    { 'app/package.json': manifest({}) },
    { 'app/package.json': manifest({ 'not-installed-yet': '^1.0.0' }), 'app/use.ts': use('not-installed-yet') },
  );
  assert.equal(added.status, 0, added.out);
  assert.match(added.out, /app\/use\.ts: 'not-installed-yet' isn't installed here yet/);
  const undeclared = gates({ 'app/package.json': manifest({}) }, { 'app/use.ts': use('@nobody/never-declared/sub') });
  assert.equal(undeclared.status, 1);
  assert.match(undeclared.out, /app\/use\.ts:1: .*\(TS2307\)/);
  // declared and installed (the tools' typescript), but no such subpath: a real unresolved import
  const subpath = gates(
    { 'app/package.json': manifest({ typescript: '*' }) },
    { 'app/use.ts': use('typescript/absent-subpath') },
  );
  assert.equal(subpath.status, 1, subpath.out);
  assert.match(subpath.out, /app\/use\.ts:1: .*\(TS2307\)/);
});

test('a file with a non-ASCII name is type checked like any other', () => {
  const { status, out } = gates({}, { 'lib/café.ts': "export const bad: number = 'x';\n" });
  assert.equal(status, 1, out);
  assert.match(out, /lib\/café\.ts:1: .*\(TS2322\)/);
});

test('a type check config that breaks the check fails it as not run, never as passed', () => {
  const tsconfig = readFileSync(join(repo, 'tsconfig.json'), 'utf8').replace(
    /"types": \[[^\]]*\]/,
    '"types": ["missing-type-package"]',
  );
  const { status, out } = gates({}, { 'tsconfig.json': tsconfig });
  assert.equal(status, 2, out);
  assert.match(out, /could not run: the type check's config: .*missing-type-package.*\(TS2688\)/);
});

test('a render stays out of git: a big video or audio file is refused; its .render.json must name what is there', () => {
  const film = 'f'.repeat(600 * 1024),
    sha256 = createHash('sha256').update(film).digest('hex');
  const note = (n: object) =>
    JSON.stringify({ command: ['node', 'shared/demo/ad.mjs', 'products/x/ads/scene.html'], ...n });
  const { status, out } = gates(
    {},
    {
      '.gitignore': 'node_modules\n/products/**/*.mp4\n', // (as a company's: renders aren't committed)
      'products/x/ads/raw.wav': film,
      'products/x/ads/ok.mp4': film,
      'products/x/ads/ok.mp4.render.json': note({ sha256, bytes: film.length }),
      'products/x/ads/gone.mp4.render.json': note({ sha256, bytes: film.length }),
      'products/x/ads/stale.mp4.render.json': note({ sha256: '0'.repeat(64), bytes: film.length }),
      'platform/hq/phone/chime.mp3': 'small',
    },
  );
  assert.equal(status, 1);
  assert.match(out, /products\/x\/ads\/raw\.wav: a render in git/);
  assert.match(out, /gone\.mp4\.render\.json: products\/x\/ads\/gone\.mp4 is missing here/);
  assert.match(out, /stale\.mp4\.render\.json: products\/x\/ads\/stale\.mp4 is missing here or isn't what it names/);
  assert.doesNotMatch(out, /ok\.mp4|chime\.mp3/);
});

test("generated output stays out of git: a run's raw results, in one file or many", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `{"seed":${i}}`).join('\n') + '\n';
  const one = gates(
    { 'products/x/README.md': 'x\n' },
    {
      'tools/x/runs/seeds.ndjson': rows(12_000),
      'products/x/package-lock.json': rows(12_000),
      'products/x/plate.png': Buffer.from([0, ...Array(30_000).fill(10)]).toString('latin1'),
      'products/x/summary.md': 'Seeds 1 to 12000: every island holds.\n',
    },
  );
  assert.equal(one.status, 1);
  assert.match(one.out, /seeds\.ndjson: 12,000 lines of generated output: commit a short summary/);
  assert.doesNotMatch(one.out, /package-lock|plate\.png|summary\.md/);
  const spread = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`tools/x/runs/seed-${i}.json`, rows(9_000)]));
  const many = gates({}, spread);
  assert.equal(many.status, 1);
  assert.match(many.out, /\(the whole change\): adds 108,000 lines: generated output\?/);
});

test('raw output stays out of the knowledge base and the products: past 2,000 lines or 512 KB, unless a fixture', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `{"frame":${i}}`).join('\n') + '\n';
  const run = gates(
    { 'products/x/README.md': 'x\n' },
    {
      'knowledge/qa/x/trace-1.json': rows(2_500),
      'knowledge/qa/x/frames.json': `[${'0,'.repeat(300_000)}0]`,
      'products/x/test/world.json': rows(3_000),
      'products/x/.gitattributes': 'test/world.json fixture\n',
      'knowledge/qa/x/summary.json': rows(1_500),
      'knowledge/qa/x/README.md': 'Trace 1: 2,500 frames, none dropped.\n',
      'tools/x/runs.json': rows(3_000),
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.out, /trace-1\.json: raw output in git \(over 2,000 lines or 512 KB\): keep it in the store/);
  assert.match(run.out, /frames\.json: raw output in git/);
  assert.doesNotMatch(run.out, /world\.json|summary\.json|README|tools\/x/);
  assert.doesNotMatch(run.out, /lines of generated output/, 'one refusal for a data file');
});

test("a merge of main not yet committed counts as made: main's own files aren't the change's, in a linked worktree too", () => {
  const dir = mkdtempSync(join(tmpdir(), 'gates-test-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  for (const path of CONFIGS) cpSync(join(repo, path), join(dir, path), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'work');
  writeFileSync(join(dir, 'notes.md'), 'the change\n');
  git('add', '-A');
  git('commit', '-qm', 'work');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'qa.json'), '[1]\n'.repeat(12_000)); // main's own (raw output, but not this change's)
  git('add', '-A');
  git('commit', '-qm', 'main moves on');
  git('checkout', '-q', 'work');
  const linked = `${dir}-linked`;
  git('worktree', 'add', '-q', '-b', 'linked', linked, 'work');
  symlinkSync(join(repo, 'node_modules'), join(linked, 'node_modules'));
  for (const cwd of [dir, linked]) {
    git('-C', cwd, 'merge', '-q', '--no-commit', '--no-ff', 'main');
    const run = spawnSync('node', ['shared/gates/gates.ts', '--base', 'main'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GATES_HOME: join(dir, 'none') },
    });
    assert.equal(run.status, 0, `${cwd}: ${run.stdout}`); // (against the old base, qa.json's 12,000 lines would be refused)
  }
});

const onHelper = { 'shared/gates/tests-on-helper.sh': ON_HELPER };
const typeError = { 'lib/a.ts': "export const a: number = 'one';\n" };
const lent = async (states?: [string, string][], env: NodeJS.ProcessEnv = {}) => ({
  env: await playedHq(states, { GATES_HOME: repo, ...env }),
  args: ['--helper'],
});

test("--helper sends a push's type-checked gates to a lent machine, whose verdict is theirs; a change with no type check isn't sent, for the worker to run here", async () => {
  const there = gates(onHelper, typeError, await lent());
  assert.equal(there.status, 1, there.out);
  assert.match(there.out, /lib\/a\.ts:1: Type 'string' is not assignable to type 'number'/);
  assert.match(there.out, /\(on attic\)$/m);
  const notes = gates(onHelper, { 'lib/style.css': 'a {\n  color: red;\n}\n' }, await lent());
  assert.equal(notes.status, 2, notes.out);
  assert.doesNotMatch(notes.out, /on attic/);
  const withoutHq = gates(onHelper, typeError, { env: { HQ_URL: '', HQ_TOKEN: '' }, args: ['--helper'] });
  assert.equal(withoutHq.status, 2, withoutHq.out);
  assert.doesNotMatch(withoutHq.out, /on attic|Type 'string'/);
});

test("a run HQ handed back to this server's helper is taken once, as that helper finished it; a lost one isn't run here", async () => {
  const handedBack = await lent([
    ['running', 'attic'],
    ['waiting', 'attic'],
    ['done', 'server'],
  ]);
  const back = gates(onHelper, typeError, handedBack);
  assert.equal(back.status, 1, back.out);
  assert.equal(back.out.match(/Gates failed/g)?.length, 1, back.out);
  assert.match(back.out, /\(on server\)$/m);
  const lost = gates(onHelper, typeError, await lent([['lost', 'attic']]));
  assert.equal(lost.status, 2, lost.out);
  assert.doesNotMatch(lost.out, /\(on attic\)|Type 'string'/);
});

test("--helper stopped at the worker's time limit stops its run on HQ, however late HQ answers, and gives no verdict", async () => {
  const runOf = async (hq: NodeJS.ProcessEnv) => {
    const run = await fetch(`${hq.HQ_URL}/api/agent/runs/1`, { headers: { authorization: 'Bearer job-token' } });
    return ((await run.json()) as { state: string }).state;
  };
  // as it waits for the helper's outcome
  const quickSend = { 'shared/gates/tests-on-helper.sh': 'echo started\n' };
  const waiting = await lent([['running', 'attic']], { PLAYED_STOP_MS: '1500' });
  const late = gates(quickSend, typeError, { ...waiting, stopAfterMs: 6000 });
  assert.equal(late.status, 2, late.out);
  assert.doesNotMatch(late.out, /\(on attic\)|Type 'string'/);
  assert.equal(await runOf(waiting.env), 'stopped'); // (what attic sends later, HQ refuses)
  // as it sends the run (HQ answers once the helper has run it)
  const sending = await lent([['running', 'attic']]);
  const early = gates(onHelper, typeError, { ...sending, stopAfterMs: 1000 });
  assert.equal(early.status, 2, early.out);
  assert.equal(await runOf(sending.env), 'stopped');
});
