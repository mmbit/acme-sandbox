// node --test shared/browser/touched.test.mjs   (makes throwaway git repos in the system's temp folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordIn } from './touched.mjs';

const PAGE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// A check's repo: its entry importing a module of its own that reads a seed by its address and one of its seeds/ by
// an address worked out as it runs (and builds a path from the root, which reads nothing), a list of screens the check
// reads itself, a page script and a style sheet, committed
function checkRepo() {
  const root = mkdtempSync(join(tmpdir(), 'touched-'));
  writeFileSync(join(root, 'check.mjs'), "import { kit } from './kit.mjs';\n");
  writeFileSync(
    join(root, 'kit.mjs'),
    "export const kit = readFileSync(new URL('./seed.json', import.meta.url));\n" +
      'export const seed = name => readFileSync(new URL(`./seeds/${name}.json`, import.meta.url));\n' +
      'export const inRepo = path => new URL(`./${path}`, import.meta.url);\n',
  );
  writeFileSync(join(root, 'seed.json'), '[]\n');
  mkdirSync(join(root, 'seeds'));
  for (const name of ['one', 'two']) writeFileSync(join(root, 'seeds', `${name}.json`), '[]\n');
  writeFileSync(join(root, 'screens.json'), '[]\n');
  writeFileSync(join(root, 'page.js'), PAGE);
  writeFileSync(join(root, 'page.css'), 'p { color: red }\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'check');
  return root;
}
const git = (root, ...args) => execFileSync('git', args, { cwd: root });
const edit = (root, file, change) => writeFileSync(join(root, file), change(readFileSync(join(root, file), 'utf8')));
const lines = (text, from, to, replace) => {
  const all = text.split('\n');
  all.splice(from - 1, to - from + 1, ...replace);
  return all.join('\n');
};

// Two cases run and recorded: one that ran page.js's lines 5 to 8, one that used page.css; then the record read again
function recorded(root) {
  const out = join(root, '.out');
  const entry = pathToFileURL(join(root, 'check.mjs')).href;
  const record = recordIn(out, entry, ['screens.json']);
  record.save('script', 'ok   script', { 'page.js': [[5, 8]] });
  record.save('style', 'FAIL style\n     its words', { 'page.css': 'whole' });
  record.write();
  return () => recordIn(out, entry, ['screens.json']);
}

test('a case with no record runs, and an unchanged tree keeps every case with its result', () => {
  const root = checkRepo();
  try {
    assert.equal(recordIn(join(root, '.out'), pathToFileURL(join(root, 'check.mjs')).href).touches('script'), true);
    const again = recorded(root)();
    assert.equal(again.touches('script'), false);
    assert.equal(again.touches('style'), false);
    assert.equal(again.kept('style'), 'FAIL style\n     its words');
    assert.equal(again.touches('a new one'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a script change touches only the cases whose executed lines it changes, deletes or inserts beside', () => {
  const root = checkRepo();
  try {
    const again = recorded(root);
    edit(root, 'page.js', text => lines(text, 12, 12, ['changed']));
    assert.equal(again().touches('script'), false, 'a line that never ran');
    edit(root, 'page.js', () => lines(PAGE, 7, 7, ['changed']));
    assert.equal(again().touches('script'), true, 'a line that ran');
    edit(root, 'page.js', () => lines(PAGE, 8, 9, []));
    assert.equal(again().touches('script'), true, 'a line that ran, deleted');
    edit(root, 'page.js', () => lines(PAGE, 9, 8, ['inserted']));
    assert.equal(again().touches('script'), true, 'a line inserted right after one that ran');
    edit(root, 'page.js', () => lines(PAGE, 3, 2, ['inserted']));
    assert.equal(again().touches('script'), false, 'a line inserted away from them');
    assert.equal(again().touches('style'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('any change to a whole file touches its cases, and one to the check’s own code touches every case', () => {
  const root = checkRepo();
  try {
    const again = recorded(root);
    edit(root, 'page.css', text => `${text}a { color: blue }\n`);
    assert.deepEqual(
      [again().touches('script'), again().touches('style')],
      [false, true],
      'a path from the root reads none',
    );
    edit(root, 'kit.mjs', () => 'export const kit = 2;\n');
    assert.deepEqual([again().touches('script'), again().touches('style')], [true, true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a change to a file the check reads itself, or its code reads by its address or in a folder it names, touches every case', () => {
  for (const file of ['screens.json', 'seed.json', 'seeds/one.json']) {
    const root = checkRepo();
    try {
      const again = recorded(root);
      edit(root, file, () => '[1]\n');
      assert.deepEqual([again().touches('script'), again().touches('style')], [true, true], file);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('the record reads in another checkout that never had the tree it ran on, as a helper’s', () => {
  const root = checkRepo();
  const helper = mkdtempSync(join(tmpdir(), 'touched-helper-'));
  try {
    recorded(root);
    cpSync(root, helper, { recursive: true, filter: path => !path.endsWith('.git') });
    edit(helper, 'page.js', () => lines(PAGE, 6, 6, ['changed']));
    git(helper, 'init', '-q');
    git(helper, 'add', '-A');
    git(helper, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'sent');
    const there = recordIn(join(helper, '.out'), pathToFileURL(join(helper, 'check.mjs')).href);
    assert.deepEqual([there.touches('script'), there.touches('style')], [true, false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(helper, { recursive: true, force: true });
  }
});
