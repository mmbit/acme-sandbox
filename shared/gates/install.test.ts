// node --test shared/gates/install.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { tests, clone, nodeTest, sum } from './fixture.ts';

// A package that depends on a folder of the repo (`file:`, so npm needs no registry), with the lock npm writes for it
const usesPackage = (vendor: string) => ({
  'kits/uses/package.json': JSON.stringify({ name: 'uses', type: 'module', dependencies: { adder: `file:${vendor}` } }),
  'kits/uses/package-lock.json': JSON.stringify({
    name: 'uses',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'uses', dependencies: { adder: `file:${vendor}` } },
      [vendor]: { version: '1.0.0' },
      'node_modules/adder': { resolved: vendor, link: true },
    },
  }),
});
const adder = (folder: string, body: string) => ({
  [`${folder}/package.json`]: '{ "name": "adder", "version": "1.0.0", "type": "module", "main": "index.js" }',
  [`${folder}/index.js`]: `export const add = (a, b) => ${body};\n`,
});
const addsTest = `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from 'adder';\ntest('adds', () => assert.equal(add(1, 2), 3));\n`;
// a lock npm ci refuses: it doesn't have the manifest's dependency
const brokenLock = (name: string) =>
  `{ "name": "${name}", "lockfileVersion": 3, "packages": { "": { "name": "${name}" } } }`;
// a product whose test imports the kit's package through the kit
const shop = {
  'kits/uses/sum.ts': "export { add as sum } from 'adder';\n",
  'products/shop/sum.test.ts': nodeTest('sums through the kit', 'assert.equal(sum(1, 2), 3);'),
  'products/shop/sum.ts': "export { sum } from '../../kits/uses/sum.ts';\n",
};

test("a package's own dependencies are installed before the tests, and one that can't install leaves the run incomplete", () => {
  const { status, out } = tests(
    {
      '.gitignore': 'node_modules\n',
      ...adder('vendor/adder', 'a + b'),
      ...usesPackage('../../vendor/adder'),
      'kits/uses/uses.test.ts': addsTest,
      ...shop,
      'kits/stale/package.json': '{ "name": "stale", "dependencies": { "adder": "file:../../vendor/adder" } }',
      'kits/stale/package-lock.json': brokenLock('stale'),
      'kits/stale/stale.test.ts': addsTest,
    },
    { 'kits/uses/notes.md': 'touched\n', 'products/shop/notes.md': 'touched\n', 'kits/stale/notes.md': 'touched\n' },
  );
  assert.equal(status, 2, out);
  assert.match(out, /^Tests incomplete: /);
  assert.match(out, /- kits\/uses \(in kits\/uses: node --test, 1 file\): 1 passed/);
  assert.match(out, /- products\/shop \(node --test, 1 file\): 1 passed/);
  assert.match(out, /Not run, as their package couldn't install: kits\/stale \(1 file\)/);
  assert.match(out, /npm ci failed in kits\/stale:\n {2}npm error/);
  assert.doesNotMatch(out, /- kits\/stale/);
});

test("a change that breaks a package's install leaves its area not run, and fails what it breaks elsewhere", () => {
  const before = {
    '.gitignore': 'node_modules\n',
    ...adder('vendor/adder', 'a + b'),
    ...usesPackage('../../vendor/adder'),
    'kits/uses/uses.test.ts': addsTest,
    ...shop,
  };
  const broken = { 'kits/uses/package-lock.json': brokenLock('uses') };
  const alone = tests(before, broken);
  assert.equal(alone.status, 2, alone.out);
  assert.match(alone.out, /Not run, as their package couldn't install: kits\/uses \(1 file\)/);
  const both = tests(before, { ...broken, 'products/shop/notes.md': 'touched\n' });
  assert.equal(both.status, 1, both.out);
  assert.match(both.out, /- products\/shop \(node --test, 1 file\): 0 passed, 1 failing/);
});

test("failures are not taken as main's own when a package couldn't install there, whatever area imports it", () => {
  // main's lock is broken; the change mends it, but to a package that subtracts
  const before = {
    '.gitignore': 'node_modules\n',
    ...adder('vendor/adder', 'a + b'),
    ...usesPackage('../../vendor/adder'),
    'kits/uses/package-lock.json': brokenLock('uses'),
    'kits/uses/uses.test.ts': addsTest,
    ...shop,
    'kits/adds/sum.ts': sum('a + b'),
    'kits/adds/sum.test.ts': nodeTest('sums', 'assert.equal(sum(1, 2), 3);'),
  };
  const mended = { ...adder('vendor/subtracter', 'a - b'), ...usesPackage('../../vendor/subtracter') };
  const { status, out } = tests(before, { ...mended, 'products/shop/notes.md': 'touched\n' });
  assert.equal(status, 2, out);
  assert.match(out, /- kits\/uses \(in kits\/uses: node --test, 1 file\): 0 passed, 1 failing, not compared with main/);
  assert.match(out, /- products\/shop \(node --test, 1 file\): 0 passed, 1 failing, not compared with main/);
  assert.match(out, /npm ci failed in kits\/uses at main:\n {2}npm error/);
  assert.doesNotMatch(out, /Failing on main too/);
  // a failure that passes at the base still counts
  const more = tests(before, { ...mended, 'kits/adds/sum.ts': sum('a * b') });
  assert.equal(more.status, 1, more.out);
  assert.match(more.out, /- kits\/adds \(node --test, 1 file\): 0 passed, 1 failing, /);
  assert.match(more.out, /Failing, not compared with main \(its packages couldn't install\): kits\/uses/);

  // and so does one in a test file main doesn't have
  const added = tests(before, {
    ...mended,
    'kits/adds/new.test.ts': nodeTest('is new', 'assert.equal(sum(1, 2), 4);'),
  });
  assert.equal(added.status, 1, added.out);
  assert.match(added.out, /kits\/adds\/new\.test\.ts: is new/);
});

test('a change of dependencies after a first run is installed again in the same clone, and a removed one is gone', () => {
  const repo = clone(
    {
      '.gitignore': 'node_modules\n',
      ...adder('vendor/adder', 'a + b'),
      ...usesPackage('../../vendor/adder'),
      'kits/uses/uses.test.ts': addsTest,
    },
    { 'kits/uses/notes.md': 'touched\n' },
  );
  const first = repo.run();
  assert.equal(first.status, 0, first.out);
  repo.change({
    'kits/uses/package.json': JSON.stringify({ name: 'uses', type: 'module' }),
    'kits/uses/package-lock.json': brokenLock('uses'),
  });
  const removed = repo.run();
  assert.equal(removed.status, 1, removed.out);
  assert.match(removed.out, /kits\/uses\/uses\.test\.ts/);
  repo.change({ ...adder('vendor/subtracter', 'a - b'), ...usesPackage('../../vendor/subtracter') });
  const second = repo.run();
  assert.equal(second.status, 1, second.out);
  assert.match(second.out, /kits\/uses\/uses\.test\.ts: adds/);
});

test('a package installed in the repo by hand, outside its lock, does not reach the tests', () => {
  const repo = clone(
    {
      '.gitignore': 'node_modules\n',
      ...adder('vendor/adder', 'a + b'),
      'vendor/extra/package.json': '{ "name": "extra", "version": "1.0.0", "type": "module", "main": "index.js" }',
      'vendor/extra/index.js': 'export const add = (a, b) => a + b;\n',
      ...usesPackage('../../vendor/adder'),
      'kits/uses/uses.test.ts': addsTest,
    },
    { 'kits/uses/notes.md': 'touched\n' },
  );
  const first = repo.run();
  assert.equal(first.status, 0, first.out);
  execFileSync('npm', ['install', '--no-save', '--offline', '../../vendor/extra'], {
    cwd: join(repo.dir, 'kits/uses'),
  });
  repo.change({ 'kits/uses/extra.test.ts': addsTest.replace("from 'adder'", "from 'extra'") });
  const second = repo.run();
  assert.equal(second.status, 1, second.out);
  assert.match(second.out, /kits\/uses\/extra\.test\.ts/);
});

test('a test that a change of a dependency breaks fails the run, as the base installs its own', () => {
  const before = {
    '.gitignore': 'node_modules\n',
    ...adder('vendor/adder', 'a + b'),
    ...usesPackage('../../vendor/adder'),
    'kits/uses/uses.test.ts': addsTest,
  };
  for (const change of [
    { ...adder('vendor/subtracter', 'a - b'), ...usesPackage('../../vendor/subtracter') },
    { ...adder('vendor/adder', 'a - b'), 'kits/uses/notes.md': 'touched\n' },
  ]) {
    const { status, out } = tests(before, change);
    assert.equal(status, 1, out);
    assert.match(out, /kits\/uses\/uses\.test\.ts: adds/);
    assert.doesNotMatch(out, /Failing on main too/);
  }
});

// The worker image's copy of the tools, laid out as the repo, with `links` (path: target) beside the files
function toolsHome(files: Record<string, string>, links: Record<string, string> = {}) {
  const tools = mkdtempSync(join(tmpdir(), 'tests-tools-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tools, path)), { recursive: true });
    writeFileSync(join(tools, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(tools, path)), { recursive: true });
    symlinkSync(target, join(tools, path));
  }
  return tools;
}

// A package that depends on adder as published, with its lock (npm never fetches it while the tools' copy stands in)
const publishedPackage = {
  'kits/uses/package.json': JSON.stringify({ name: 'uses', type: 'module', dependencies: { adder: '^1.0.0' } }),
  'kits/uses/package-lock.json': JSON.stringify({
    name: 'uses',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'uses', dependencies: { adder: '^1.0.0' } },
      'node_modules/adder': { version: '1.0.0', resolved: 'https://registry.npmjs.org/adder/-/adder-1.0.0.tgz' },
    },
  }),
};

test("the tools' copy of a package stands in only for the manifest and lock it was installed from", () => {
  // the tools hold kits/uses installed from main's manifest and lock
  const tools = toolsHome({ ...publishedPackage, ...adder('kits/uses/node_modules/adder', 'a + b') });
  const repo = clone(
    { '.gitignore': 'node_modules\n', ...publishedPackage, 'kits/uses/uses.test.ts': addsTest },
    { 'kits/uses/notes.md': 'touched\n' },
  );
  const same = repo.run({ GATES_HOME: tools });
  assert.equal(same.status, 0, same.out);
  repo.change({ ...adder('vendor/subtracter', 'a - b'), ...usesPackage('../../vendor/subtracter') });
  const changed = repo.run({ GATES_HOME: tools });
  assert.equal(changed.status, 1, changed.out);
  assert.match(changed.out, /kits\/uses\/uses\.test\.ts: adds/);
});

test("the tools' copy of a package that links a folder of the repo never stands in for the checkout's folder", () => {
  // the tools' kits/uses links their own vendor/adder, which adds; the change makes the repo's subtract
  const tools = toolsHome(
    { ...usesPackage('../../vendor/adder'), ...adder('vendor/adder', 'a + b') },
    { 'kits/uses/node_modules/adder': '../../../vendor/adder' },
  );
  const { status, out } = tests(
    {
      '.gitignore': 'node_modules\n',
      ...adder('vendor/adder', 'a + b'),
      ...usesPackage('../../vendor/adder'),
      'kits/uses/uses.test.ts': addsTest,
    },
    { ...adder('vendor/adder', 'a - b'), 'kits/uses/notes.md': 'touched\n' },
    { GATES_HOME: tools },
  );
  assert.equal(status, 1, out);
  assert.match(out, /kits\/uses\/uses\.test\.ts: adds/);
});
