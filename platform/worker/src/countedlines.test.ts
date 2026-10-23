// node --test src/countedlines.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countedLines, markedPaths, numstatRow } from './countedlines.ts';

test('a numstat row: a renamed file is its new path, a binary one is none', () => {
  assert.deepEqual(numstatRow('3\t1\tsrc/a.ts'), { path: 'src/a.ts', add: 3, del: 1 });
  assert.deepEqual(numstatRow('2\t2\tsrc/{old => new}/a.ts'), { path: 'src/new/a.ts', add: 2, del: 2 });
  assert.deepEqual(numstatRow('0\t0\tsrc/{ => deep}/a.ts'), { path: 'src/deep/a.ts', add: 0, del: 0 });
  assert.deepEqual(numstatRow('1\t0\told.md => new.md'), { path: 'new.md', add: 1, del: 0 });
  assert.equal(numstatRow('-\t-\tpic.png'), null);
  assert.equal(numstatRow(''), null);
});

test('only code and docs count, never data or what .gitattributes marks generated; an edited line counts once', () => {
  const files = [
    { path: 'src/a.ts', add: 10, del: 4 },
    { path: 'README.md', add: 2, del: 0 },
    { path: 'knowledge/qa/trace.json', add: 100_000, del: 0 },
    { path: 'package-lock.json', add: 900, del: 300 },
    { path: 'products/x/plates/a.svg', add: 400, del: 0 },
    { path: 'products/x/app/bundle.js', add: 5_000, del: 0 },
    { path: 'infra/Dockerfile', add: 1, del: 1 },
  ];
  const marked = markedPaths(
    'products/x/app/bundle.js\0linguist-generated\0set\0src/a.ts\0linguist-generated\0unspecified\0',
  );
  assert.deepEqual(countedLines(files, marked), { add: 13, del: 5, lines: 13 });
});
