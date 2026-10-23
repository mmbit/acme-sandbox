// node --test src/outcomes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reading } from './outcomes.ts';

const rook = { agent: 'rook', engine: 'claude' },
  nib = { agent: 'nib', engine: 'codex' };
const row = (
  kind: string,
  by: object[],
  outcome: string | null = null,
  right: string | null = null,
  day = '2026-10-17',
) => ({
  day,
  pr: 7,
  kind,
  file: 'a.ts',
  line: 3,
  issue: 'x',
  by: JSON.stringify(by),
  outcome,
  right,
});

test('noise is the share of judged findings that were wrong or kept, and an open one is not judged', () => {
  const read = reading([
    row('blocking', [rook], 'disputed', 'reviewer'),
    row('blocking', [rook], 'kept'),
    row('nonblocking', [rook]),
    row('blocking', [rook, nib], 'not fixed'),
  ]);
  assert.deepEqual(read.engines, [
    { engine: 'claude', reached: 4, fixed: 0, not_fixed: 1, wrong: 0, stood: 1, kept: 1, open: 1, noise: '33%' },
    { engine: 'codex', reached: 1, fixed: 0, not_fixed: 1, wrong: 0, stood: 0, kept: 0, open: 0, noise: '0%' },
  ]);
});

test("pre-existing findings are listed newest first and counted for their reviewer, and a finding nobody's named for stays counted", () => {
  const read = reading([
    row('pre-existing', [nib], null, null, '2026-10-15'),
    row('pre-existing', [rook, nib], null, null, '2026-10-16'),
    row('blocking', [], 'fixed'),
  ]);
  assert.deepEqual(
    read.preExisting.map(f => [f.day, f.place, f.by]),
    [
      ['2026-10-16', 'a.ts:3', 'rook, nib'],
      ['2026-10-15', 'a.ts:3', 'nib'],
    ],
  );
  assert.deepEqual(
    read.reviewers.map(r => [r.agent, r.pre_existing, r.reached]),
    [
      ['nib', 2, 0],
      ['rook', 1, 0],
      ['(not named)', 0, 1],
    ],
  );
});
