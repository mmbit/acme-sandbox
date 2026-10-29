// node --test src/lighter.test.ts   (The briefing's lines on a lighter model: the
// queuer's on choosing it, a light run's on handing up, and the run after a hand-up's.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handedUpLines, lighterLine, lightLines } from './lighter.ts';

test('every briefing names the lighter model a small hand-off goes on, by the word hq job --model takes; none without one', () => {
  const line = lighterLine({ company: { lighter: [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }] } });
  assert.match(line, /a small, fully specified change \(a sentence or label the brief quotes, a\n {2}colour value/);
  assert.match(line, /goes `--model sonnet`; diagnosis, design or judgment/);
  assert.match(line, /market\n {2}research and running the company stay on the default\.$/);
  assert.equal(lighterLine({ company: {} }), '');
  assert.equal(lighterLine({ company: { lighter: [] } }), '');
});

test('a light run hears it may hand the work up with hq up, and on which model it goes on; any other run hears nothing', () => {
  const lines = lightLines({ lighter: { name: 'Sonnet 5.5', own: 'Opus 5.5' } });
  assert.match(lines, /^\n\nThis job runs on Sonnet 5\.5, a lighter model/);
  assert.match(lines, /run `hq up "<the note>"` and end your turn\. The same job goes on at once on Opus 5\.5/);
  assert.match(lines, /this run opens no pull request\.$/);
  assert.equal(lightLines({}), '');
});

test('the run after a hand-up hears it is a new session in the same clone, with the note', () => {
  const lines = handedUpLines({ from: 'Sonnet 5.5', note: 'The label is the kit’s, in three products.' });
  assert.match(lines, /^This job ran first on Sonnet 5\.5 as a small job/);
  assert.match(lines, /a new session in the same clone/);
  assert.match(lines, /Its note:\n\nThe label is the kit’s, in three products\.$/);
});
