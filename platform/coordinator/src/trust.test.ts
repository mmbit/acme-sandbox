// node --test src/trust.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reading, weighed } from './trust.ts';

const day = '2026-10-17';
const review = (engine: string, output: unknown) => ({
  day,
  pr: 7,
  agent: engine === 'codex' ? 'nib' : 'rook',
  kind: 'review' as const,
  engine,
  stage: null,
  output: typeof output === 'string' ? output : JSON.stringify(output),
});
const verdict = (stage: string, output: unknown) => ({
  day,
  pr: 7,
  agent: 'quill',
  kind: 'consolidate' as const,
  engine: 'claude',
  stage,
  output: JSON.stringify(output),
});

test("STATUS.md's reading counts the guards the round and the consolidator dismissed, as a share of labelled findings", () => {
  const read = reading([
    review('claude', {
      findings: [
        { file: 'a.ts', line: 3, case: 'org.yaml names no zone', from: 'ours', guard: 'fail' }, // a check against our own systems: dismissed
        { from: 'none', guard: 'retry' }, // a retry for a case nobody causes: dismissed
        { from: 'outside', guard: 'fail' }, // fails loudly on outside input: weighed
        { from: 'ours', guard: 'none' }, // a bug in our own code, fixed where it is: weighed
        { severity: 'blocking' }, // no labels: counted as a finding, never dismissed
      ],
    }),
    review('codex', { findings: [{ from: 'outside', guard: 'fallback' }] }),
    review('codex', 'No verdict: the file and the final message disagree'),
    verdict('ruling', {
      blocking: [{ rule: 'trust' }, {}],
      dismissed: [{ file: 'b.ts', rule: 'trust', why: 'our own config' }, { rule: 'unshown' }, null],
      decision: 'changes',
    }),
    verdict('recheck', { blocking: [null], decision: 'changes' }),
  ]);
  assert.deepEqual(read.reviews, [
    { day, engine: 'claude', reviews: 1, findings: 5, labelled: 4, guards: 3, hides: 0, trust: 2, fallback: 0 },
    { day, engine: 'codex', reviews: 1, findings: 1, labelled: 1, guards: 1, hides: 0, trust: 0, fallback: 1 },
  ]);
  assert.deepEqual(read.verdicts, [
    { day, stage: 'ruling', verdicts: 1, dismissed_trust: 1, dismissed_unshown: 1, blocking: 2, blocking_hardening: 1 },
    {
      day,
      stage: 'recheck',
      verdicts: 1,
      dismissed_trust: 0,
      dismissed_unshown: 0,
      blocking: 1,
      blocking_hardening: 0,
    },
  ]);
  assert.deepEqual(read.total, {
    labelled: 5,
    dismissed_by_round: 3,
    dismissed_by_consolidator: 1,
    overhardening_share: '80%',
  });
  // each dismissal, to check against its pull request: the round's with the finding's labels and case, the consolidator's with its why
  const drop = { day, pr: 7, place: '', from: '', guard: '', case: '' };
  assert.deepEqual(read.dismissals, [
    {
      ...drop,
      by: 'rook',
      rule: 'trust',
      place: 'a.ts:3',
      from: 'ours',
      guard: 'fail',
      case: 'org.yaml names no zone',
    },
    { ...drop, by: 'rook', rule: 'trust', from: 'none', guard: 'retry' },
    { ...drop, by: 'nib', rule: 'fallback', from: 'outside', guard: 'fallback' },
    { ...drop, by: 'quill', rule: 'trust', place: 'b.ts', case: 'our own config' },
  ]);
});

test('a finding with no origin label stays with the round, and a verdict that is not an object decides nothing', () => {
  const kept = weighed('rook', JSON.stringify({ findings: [{ guard: 'fail', issue: 'a request has no auth check' }] }));
  assert.match(kept, /a request has no auth check/);
  assert.doesNotMatch(kept, /dismissed/);
  const read = reading([review('claude', { findings: [{ guard: 'fail' }] }), verdict('ruling', null)]);
  assert.equal(read.reviews[0].trust, 0);
  assert.deepEqual(read.verdicts, []);
});

test("a finding on a line that hides a failure stays with the round, whatever its fix's labels", () => {
  const swallowed = {
    case: "a renamed column makes the check's SELECT throw",
    from: 'ours',
    hides: true,
    guard: 'fail',
  };
  const output = JSON.stringify({
    findings: [swallowed, { ...swallowed, guard: 'fallback' }, { from: 'ours', guard: 'fail' }],
  });
  const kept = weighed('rook', output);
  assert.equal(JSON.parse(kept.split('\n')[1]).findings.length, 2);
  assert.match(kept, /dismissed 1 more/);
  const read = reading([review('claude', JSON.parse(output))]);
  assert.deepEqual(read.reviews[0], {
    day,
    engine: 'claude',
    reviews: 1,
    findings: 3,
    labelled: 3,
    guards: 3,
    hides: 2,
    trust: 1,
    fallback: 0,
  });
});

test('ruling reports retain original finding indices across dismissals and pre-existing separation', () => {
  const output = JSON.stringify({
    findings: [
      { from: 'ours', guard: 'fail' },
      { file: 'old.ts', issue: 'An existing bug.' },
      { file: 'new.ts', issue: 'A new bug.' },
    ],
  });
  const report = weighed('rook', output, f => (f as { file?: string })?.file === 'old.ts');
  const shown = JSON.parse(report.split('\n')[1]);
  assert.equal(shown.findings[0].finding, 2);
  assert.equal(shown.pre_existing[0].finding, 1);
});
