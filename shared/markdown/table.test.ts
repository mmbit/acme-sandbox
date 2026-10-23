// node --test shared/markdown/table.test.ts   (npm ci in shared/markdown first)
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeTable } from './table.ts';

test('table tokenization preserves inline text, escaped pipes and empty cells', () => {
  const table = tokenizeTable([
    '| Choice | Cost |',
    '| :--- | ---: |',
    '| **A** \\| B | [cost](https://example.com) |',
    '| <example> | |',
  ]);
  assert.deepEqual(table, {
    headings: ['Choice', 'Cost'],
    rows: [
      ['**A** | B', '[cost](https://example.com)'],
      ['<example>', ''],
    ],
  });
});

test('invalid separators and mismatched rows are reported without inventing or losing cells', () => {
  assert.equal(tokenizeTable(['| Choice | Cost |']), null);
  assert.equal(tokenizeTable(['| Choice | Cost |', '| --- |']), null);
  assert.equal(tokenizeTable(['| Choice | Cost |', '| words | --- |']), null);
  assert.deepEqual(tokenizeTable(['| Choice | Cost |', '| --- | --- |', '| A |', '| B | 1 | 2 |'])?.rows, [null, null]);
});
